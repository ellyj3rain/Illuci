import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MIRROR_DISPOSITIONS,
  MIRROR_SET_STATUS,
  classifyMirrorReconciliation,
  classifyMirrorSet,
  formatMirrorSet,
} from "./mirror-reconciliation.js";

const AUTH = {
  name: "zero",
  ref: "main",
  headSha: "e84551fd3c9d1ff24b8f7c78f4d328bb1ddb723a",
};

test("equal mirror head is aligned and needs no mutation", () => {
  const r = classifyMirrorReconciliation({
    authoritative: AUTH,
    mirror: {
      name: "enterprise",
      ref: "main",
      headSha: AUTH.headSha,
    },
  });
  assert.equal(r.disposition, MIRROR_DISPOSITIONS.ALIGNED);
  assert.equal(r.reconciled, true);
  assert.equal(r.allowed, true);
  assert.equal(r.requiresOperator, false);
  assert.equal(r.mutationAction, "none");
});

test("ancestor mirror is a ratified fast-forward candidate", () => {
  const r = classifyMirrorReconciliation({
    authoritative: AUTH,
    mirror: {
      name: "enterprise",
      ref: "main",
      headSha: "05e812c70ef272ba42411c68f1ea033406b9289d",
      isAncestorOfAuthoritative: true,
      uniqueAuthoritativeCommitCount: 2,
    },
  });
  assert.equal(r.disposition, MIRROR_DISPOSITIONS.FAST_FORWARD);
  assert.equal(r.allowed, true);
  assert.equal(r.requiresOperator, true);
  assert.equal(r.mutationAction, "push-fast-forward-after-ratification");
  assert.equal(r.signals[0].code, "mirror-behind-authority");
});

test("content-equivalent protected snapshot mirror is current without mutation", () => {
  const r = classifyMirrorReconciliation({
    authoritative: AUTH,
    mirror: {
      name: "personal",
      ref: "main",
      headSha: "2de733ea04d858e9a385dbf32598877450f4377f",
      isTreeEquivalentToAuthoritative: true,
      uniqueMirrorCommits: [
        { sha: "2de733ea04d858e9a385dbf32598877450f4377f", subject: "[A56] Mirror zero/main e84551f" },
      ],
      uniqueAuthoritativeCommitCount: 48,
    },
  });
  assert.equal(r.disposition, MIRROR_DISPOSITIONS.CONTENT_CURRENT);
  assert.equal(r.reconciled, true);
  assert.equal(r.allowed, true);
  assert.equal(r.requiresOperator, false);
  assert.equal(r.mutationAction, "none");
  assert.equal(r.signals[0].code, "content-current-mirror");
});

test("divergent historical mirror commits are not silently overwritten", () => {
  const r = classifyMirrorReconciliation({
    authoritative: AUTH,
    mirror: {
      name: "personal",
      ref: "main",
      headSha: "2de733ea04d858e9a385dbf32598877450f4377f",
      uniqueMirrorCommits: [
        { sha: "2de733ea04d858e9a385dbf32598877450f4377f", subject: "[A34] Mirror zero/main 76bc0bd15049" },
        { sha: "5b9500722222222222222222222222222222222", subject: "[A33] Mirror zero/main 91286adfc0c4" },
        { sha: "1b1374833333333333333333333333333333333", subject: "Mirror zero/main d6f806f4e7a8" },
      ],
      uniqueAuthoritativeCommitCount: 48,
    },
  });
  assert.equal(r.disposition, MIRROR_DISPOSITIONS.DIVERGENT_MIRROR_LINE);
  assert.equal(r.allowed, false);
  assert.equal(r.requiresOperator, true);
  assert.equal(r.mutationAction, "force-with-lease-after-ratification");
  assert.equal(r.dimensions.mirrorLineCommitCount, 3);
  assert.ok(r.audit.blockingSignals.includes("divergent-mirror-line"));
});

test("divergent unclassified commits require unique-work review", () => {
  const r = classifyMirrorReconciliation({
    authoritative: AUTH,
    mirror: {
      name: "personal",
      ref: "main",
      headSha: "bbbbbbb111111111111111111111111111111111",
      uniqueMirrorCommits: [
        { sha: "bbbbbbb111111111111111111111111111111111", subject: "[A56] Add private payload" },
      ],
      uniqueAuthoritativeCommitCount: 12,
    },
  });
  assert.equal(r.disposition, MIRROR_DISPOSITIONS.DIVERGENT_UNIQUE_WORK);
  assert.equal(r.allowed, false);
  assert.equal(r.requiresOperator, true);
  assert.ok(r.audit.blockingSignals.includes("divergent-unique-work"));
});

test("missing authoritative head blocks mirror reconciliation", () => {
  const r = classifyMirrorReconciliation({
    authoritative: { name: "zero", ref: "main" },
    mirror: { name: "personal", ref: "main", headSha: AUTH.headSha },
  });
  assert.equal(r.disposition, MIRROR_DISPOSITIONS.UNKNOWN);
  assert.equal(r.riskBand, "block");
  assert.equal(r.allowed, false);
});

test("mirror set summarizes operator-review posture", () => {
  const report = classifyMirrorSet({
    authoritative: AUTH,
    mirrors: [
      { name: "enterprise", ref: "main", headSha: AUTH.headSha },
      {
        name: "personal",
        ref: "main",
        headSha: "2de733ea04d858e9a385dbf32598877450f4377f",
        uniqueMirrorCommits: [
          { sha: "2de733ea04d858e9a385dbf32598877450f4377f", subject: "[A34] Mirror zero/main 76bc0bd15049" },
        ],
        uniqueAuthoritativeCommitCount: 48,
      },
    ],
  });
  assert.equal(report.summary.total, 2);
  assert.equal(report.summary.status, MIRROR_SET_STATUS.OPERATOR_REVIEW);
  assert.equal(report.summary.aligned, 1);
  assert.equal(report.summary.operatorReview, 1);
  assert.match(formatMirrorSet(report), /divergent-mirror-line: personal/);
});

test("mirror set treats aligned plus content-current mirrors as clean content-current", () => {
  const report = classifyMirrorSet({
    authoritative: AUTH,
    mirrors: [
      { name: "enterprise", ref: "main", headSha: AUTH.headSha },
      {
        name: "personal",
        ref: "main",
        headSha: "2de733ea04d858e9a385dbf32598877450f4377f",
        isTreeEquivalentToAuthoritative: true,
        uniqueMirrorCommits: [
          { sha: "2de733ea04d858e9a385dbf32598877450f4377f", subject: "[A56] Mirror zero/main e84551f" },
        ],
        uniqueAuthoritativeCommitCount: 48,
      },
    ],
  });
  assert.equal(report.summary.status, MIRROR_SET_STATUS.CONTENT_CURRENT);
  assert.equal(report.summary.aligned, 1);
  assert.equal(report.summary.contentCurrent, 1);
  assert.equal(report.summary.operatorReview, 0);
  assert.match(formatMirrorSet(report), /content-current: personal/);
});
