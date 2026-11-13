// illuci/core/governance/gitops/mirror-reconciliation.js
//
// Pure classifier for publication mirror posture. Host code gathers git facts;
// this module decides whether a mirror is aligned, fast-forwardable, divergent,
// or missing evidence. It never mutates remotes.

import { SEVERITIES, bool, list, makeGovernedVerdict, makeSignal, norm } from "../classifiers/governed-verdict.js";

export const MIRROR_DISPOSITIONS = Object.freeze({
  ALIGNED: "aligned",
  CONTENT_CURRENT: "content-current",
  FAST_FORWARD: "fast-forward",
  HISTORY_EQUIVALENT: "history-equivalent",
  DIVERGENT_MIRROR_LINE: "divergent-mirror-line",
  DIVERGENT_UNIQUE_WORK: "divergent-unique-work",
  AHEAD_OF_AUTHORITY: "ahead-of-authority",
  MISSING: "missing",
  UNKNOWN: "unknown",
});

export const MIRROR_SET_STATUS = Object.freeze({
  ALIGNED: "aligned",
  CONTENT_CURRENT: "content-current",
  FAST_FORWARD_AVAILABLE: "fast-forward-available",
  OPERATOR_REVIEW: "operator-review",
  BLOCKED: "blocked",
});

const MIRROR_SUBJECT_PATTERNS = [
  /^\[[^\]]+\]\s+mirror\s+/i,
  /^mirror\s+/i,
  /^\[[^\]]+\]\s+sync\s+/i,
  /^sync\s+/i,
];

function cleanName(value, fallback = "") {
  const raw = String(value || "").trim();
  return raw || fallback;
}

function cleanSha(value) {
  const raw = String(value || "").trim();
  return /^[0-9a-f]{7,40}$/i.test(raw) ? raw.toLowerCase() : null;
}

function cleanCommit(record = {}) {
  const subject = String(record.subject || record.message || "").trim();
  return {
    sha: cleanSha(record.sha),
    subject,
  };
}

function isMirrorSubject(record = {}) {
  const subject = String(record.subject || record.message || "").trim();
  return MIRROR_SUBJECT_PATTERNS.some((pattern) => pattern.test(subject));
}

function count(input, key, listKey) {
  const explicit = Number(input[key]);
  if (Number.isInteger(explicit) && explicit >= 0) return explicit;
  return list(input[listKey]).length;
}

function result({ mirror, authoritative, disposition, code, evidence, signals, next = null, extra = {} }) {
  const verdict = makeGovernedVerdict({
    classifier: "illuci.gitops.mirror-reconciliation",
    subject: cleanName(mirror.name, "mirror"),
    decision: disposition,
    strategy: disposition,
    allowed: disposition === MIRROR_DISPOSITIONS.ALIGNED ||
      disposition === MIRROR_DISPOSITIONS.CONTENT_CURRENT ||
      disposition === MIRROR_DISPOSITIONS.FAST_FORWARD ||
      disposition === MIRROR_DISPOSITIONS.HISTORY_EQUIVALENT,
    requiresOperator: disposition !== MIRROR_DISPOSITIONS.ALIGNED &&
      disposition !== MIRROR_DISPOSITIONS.CONTENT_CURRENT,
    code,
    evidence,
    next,
    signals,
    dimensions: {
      authoritative: {
        name: cleanName(authoritative.name, "authoritative"),
        ref: cleanName(authoritative.ref || authoritative.branch, "main"),
        headSha: cleanSha(authoritative.headSha),
      },
      mirror: {
        name: cleanName(mirror.name, "mirror"),
        ref: cleanName(mirror.ref || mirror.branch, cleanName(authoritative.ref || authoritative.branch, "main")),
        remoteUrl: mirror.remoteUrl ? String(mirror.remoteUrl) : null,
        headSha: cleanSha(mirror.headSha),
      },
      ...extra,
    },
  });

  return {
    ...verdict,
    disposition,
    reconciled: disposition === MIRROR_DISPOSITIONS.ALIGNED ||
      disposition === MIRROR_DISPOSITIONS.CONTENT_CURRENT,
    mutationAction: mutationActionFor(disposition),
  };
}

function mutationActionFor(disposition) {
  switch (disposition) {
    case MIRROR_DISPOSITIONS.ALIGNED:
    case MIRROR_DISPOSITIONS.CONTENT_CURRENT:
      return "none";
    case MIRROR_DISPOSITIONS.FAST_FORWARD:
      return "push-fast-forward-after-ratification";
    case MIRROR_DISPOSITIONS.HISTORY_EQUIVALENT:
    case MIRROR_DISPOSITIONS.DIVERGENT_MIRROR_LINE:
      return "force-with-lease-after-ratification";
    default:
      return "operator-review";
  }
}

export function classifyMirrorReconciliation(input = {}) {
  const authoritative = input.authoritative || {};
  const mirror = input.mirror || input;
  const authoritativeHead = cleanSha(authoritative.headSha);
  const mirrorHead = cleanSha(mirror.headSha);
  const uniqueMirrorCommits = list(mirror.uniqueMirrorCommits).map(cleanCommit);
  const uniqueAuthoritativeCommits = list(mirror.uniqueAuthoritativeCommits).map(cleanCommit);
  const uniqueMirrorCount = count(mirror, "uniqueMirrorCommitCount", "uniqueMirrorCommits");
  const uniqueAuthoritativeCount = count(mirror, "uniqueAuthoritativeCommitCount", "uniqueAuthoritativeCommits");
  const mirrorLineCount = uniqueMirrorCommits.filter(isMirrorSubject).length;
  const allUniqueMirrorCommitsAreMirrorLine =
    uniqueMirrorCount > 0 &&
    uniqueMirrorCommits.length > 0 &&
    mirrorLineCount === uniqueMirrorCommits.length;

  const common = {
    authoritative,
    mirror,
    extra: {
      relationship: {
        isAncestorOfAuthoritative: bool(mirror.isAncestorOfAuthoritative),
        authoritativeIsAncestorOfMirror: bool(mirror.authoritativeIsAncestorOfMirror),
        isTreeEquivalentToAuthoritative: bool(mirror.isTreeEquivalentToAuthoritative),
        isPatchEquivalentToAuthoritative: bool(mirror.isPatchEquivalentToAuthoritative),
        gitEvidenceAvailable: bool(mirror.gitEvidenceAvailable),
      },
      uniqueMirrorCommitCount: uniqueMirrorCount,
      uniqueAuthoritativeCommitCount: uniqueAuthoritativeCount,
      uniqueMirrorCommits,
      uniqueAuthoritativeCommits,
      mirrorLineCommitCount: mirrorLineCount,
    },
  };

  if (!authoritativeHead) {
    return result({
      ...common,
      disposition: MIRROR_DISPOSITIONS.UNKNOWN,
      code: "authoritative-head-missing",
      evidence: "authoritative publication head could not be resolved",
      next: "refresh-authoritative-remote-before-reconciling-mirrors",
      signals: [makeSignal({
        code: "authoritative-head-missing",
        severity: SEVERITIES.BLOCK,
        dimension: "publication-authority",
        evidence: "no authoritative head SHA was supplied",
        next: "fetch-or-repair-authoritative-remote",
      })],
    });
  }

  if (!mirrorHead) {
    return result({
      ...common,
      disposition: MIRROR_DISPOSITIONS.MISSING,
      code: "mirror-head-missing",
      evidence: "mirror publication head could not be resolved",
      next: "repair-mirror-remote-or-create-branch-after-ratification",
      signals: [makeSignal({
        code: "mirror-head-missing",
        severity: SEVERITIES.OPERATOR,
        dimension: "publication-mirror",
        evidence: "mirror branch is missing or unreachable",
        next: "operator-decide-create-or-drop-mirror",
      })],
    });
  }

  if (authoritativeHead === mirrorHead) {
    return result({
      ...common,
      disposition: MIRROR_DISPOSITIONS.ALIGNED,
      code: "mirror-aligned",
      evidence: "mirror head equals authoritative head",
      signals: [makeSignal({
        code: "mirror-aligned",
        severity: SEVERITIES.INFO,
        dimension: "publication-mirror",
        evidence: `${cleanName(mirror.name, "mirror")} is at ${mirrorHead}`,
        next: "retain-mirror",
      })],
    });
  }

  if (bool(mirror.isAncestorOfAuthoritative) && !bool(mirror.authoritativeIsAncestorOfMirror)) {
    return result({
      ...common,
      disposition: MIRROR_DISPOSITIONS.FAST_FORWARD,
      code: "mirror-fast-forward-available",
      evidence: "mirror head is an ancestor of the authoritative head",
      next: "push-authoritative-head-to-mirror-after-publication-ratification",
      signals: [makeSignal({
        code: "mirror-behind-authority",
        severity: SEVERITIES.WATCH,
        dimension: "publication-mirror",
        evidence: `${cleanName(mirror.name, "mirror")} can move by fast-forward`,
        next: "ratify-and-fast-forward-mirror",
        data: { uniqueAuthoritativeCommitCount: uniqueAuthoritativeCount },
      })],
    });
  }

  if (bool(mirror.authoritativeIsAncestorOfMirror) && !bool(mirror.isAncestorOfAuthoritative)) {
    return result({
      ...common,
      disposition: MIRROR_DISPOSITIONS.AHEAD_OF_AUTHORITY,
      code: "mirror-ahead-of-authority",
      evidence: "mirror contains commits not present on the authoritative line",
      next: "inspect-mirror-only-commits-before-any-rewrite",
      signals: [makeSignal({
        code: "mirror-ahead-of-authority",
        severity: SEVERITIES.OPERATOR,
        dimension: "publication-mirror",
        evidence: `${cleanName(mirror.name, "mirror")} is ahead of the authoritative line`,
        next: "operator-classify-mirror-only-work",
        data: { uniqueMirrorCommitCount: uniqueMirrorCount },
      })],
    });
  }

  if (bool(mirror.isTreeEquivalentToAuthoritative) || bool(mirror.isPatchEquivalentToAuthoritative)) {
    return result({
      ...common,
      disposition: MIRROR_DISPOSITIONS.CONTENT_CURRENT,
      code: "mirror-content-current",
      evidence: "mirror differs by history shape but its content matches the authoritative head",
      signals: [makeSignal({
        code: "content-current-mirror",
        severity: SEVERITIES.INFO,
        dimension: "publication-mirror",
        evidence: "mirror content is current despite different commit IDs",
        next: "retain-protected-mirror-history-or-normalize-history-by-separate-ratification",
      })],
    });
  }

  if (allUniqueMirrorCommitsAreMirrorLine) {
    return result({
      ...common,
      disposition: MIRROR_DISPOSITIONS.DIVERGENT_MIRROR_LINE,
      code: "mirror-divergent-mirror-line",
      evidence: "mirror has a divergent historical mirror/sync line and lacks current authoritative commits",
      next: "operator-ratify-force-with-lease-or-retain-historical-mirror-line",
      signals: [makeSignal({
        code: "divergent-mirror-line",
        severity: SEVERITIES.OPERATOR,
        dimension: "publication-mirror",
        evidence: `${cleanName(mirror.name, "mirror")} has mirror/sync commits outside the authoritative line`,
        next: "decide-governed-history-reconciliation",
        data: {
          uniqueMirrorCommitCount: uniqueMirrorCount,
          uniqueAuthoritativeCommitCount: uniqueAuthoritativeCount,
          mirrorLineCommitCount: mirrorLineCount,
        },
      })],
    });
  }

  return result({
    ...common,
    disposition: MIRROR_DISPOSITIONS.DIVERGENT_UNIQUE_WORK,
    code: "mirror-divergent-unique-work",
    evidence: "mirror and authoritative branches diverged with unclassified mirror-only commits",
    next: "inspect-unique-mirror-work-before-any-ref-update",
    signals: [makeSignal({
      code: "divergent-unique-work",
      severity: SEVERITIES.OPERATOR,
      dimension: "publication-mirror",
      evidence: `${cleanName(mirror.name, "mirror")} contains unclassified unique work`,
      next: "operator-review-unique-commits",
      data: {
        uniqueMirrorCommitCount: uniqueMirrorCount,
        uniqueAuthoritativeCommitCount: uniqueAuthoritativeCount,
      },
    })],
  });
}

export function classifyMirrorSet(input = {}) {
  const authoritative = input.authoritative || {};
  const verdicts = list(input.mirrors).map((mirror) => classifyMirrorReconciliation({ authoritative, mirror }));
  const aligned = verdicts.filter((v) => v.disposition === MIRROR_DISPOSITIONS.ALIGNED).length;
  const contentCurrent = verdicts.filter((v) => v.disposition === MIRROR_DISPOSITIONS.CONTENT_CURRENT).length;
  const fastForward = verdicts.filter((v) => v.disposition === MIRROR_DISPOSITIONS.FAST_FORWARD).length;
  const operatorReview = verdicts.filter((v) => v.requiresOperator).length;
  const blocked = verdicts.filter((v) => v.riskBand === "block").length;
  const status = blocked > 0
      ? MIRROR_SET_STATUS.BLOCKED
    : operatorReview > 0
      ? MIRROR_SET_STATUS.OPERATOR_REVIEW
      : fastForward > 0
        ? MIRROR_SET_STATUS.FAST_FORWARD_AVAILABLE
        : contentCurrent > 0
          ? MIRROR_SET_STATUS.CONTENT_CURRENT
        : MIRROR_SET_STATUS.ALIGNED;

  return {
    schema: "illuci.gitops.mirror-reconciliation-set/1",
    authoritative: {
      name: cleanName(authoritative.name, "authoritative"),
      ref: cleanName(authoritative.ref || authoritative.branch, "main"),
      headSha: cleanSha(authoritative.headSha),
      remoteUrl: authoritative.remoteUrl ? String(authoritative.remoteUrl) : null,
    },
    summary: {
      total: verdicts.length,
      status,
      aligned,
      contentCurrent,
      fastForward,
      operatorReview,
      blocked,
      notification: status === MIRROR_SET_STATUS.ALIGNED
        ? "Publication mirrors are aligned."
        : status === MIRROR_SET_STATUS.CONTENT_CURRENT
          ? "Publication mirrors are content-current; at least one mirror uses protected snapshot history."
        : status === MIRROR_SET_STATUS.FAST_FORWARD_AVAILABLE
          ? `${fastForward} publication mirror(s) can fast-forward after ratification.`
          : status === MIRROR_SET_STATUS.BLOCKED
            ? `${blocked} publication mirror check(s) are blocked by missing authority evidence.`
            : `${operatorReview} publication mirror(s) require operator review before reconciliation.`,
    },
    verdicts,
  };
}

export function formatMirrorSet(report) {
  const lines = [];
  lines.push(`Mirror reconciliation: ${report.summary.status} - ${report.summary.notification}`);
  lines.push(`authoritative: ${report.authoritative.name}/${report.authoritative.ref} ${report.authoritative.headSha || "(missing)"}`);
  for (const verdict of report.verdicts) {
    lines.push(`- ${verdict.disposition}: ${verdict.subject} - ${verdict.code}`);
    if (verdict.next) lines.push(`  next: ${verdict.next}`);
  }
  return `${lines.join("\n")}\n`;
}

export default {
  MIRROR_DISPOSITIONS,
  MIRROR_SET_STATUS,
  classifyMirrorReconciliation,
  classifyMirrorSet,
  formatMirrorSet,
};
