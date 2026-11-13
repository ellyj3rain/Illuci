// illuci/core/governance/assess.js
//
// Deterministic GZS standards / odometer assessment - the engine-side governance
// evaluation primitive that `illuci project assess` exposes (it was a stub before).
//
// Built as a PURE, callable module on purpose: the primary goal is real-time benefit
// to illuci development via MC + Devise, so this primitive must be invokable by MC's sense
// layer (pb-core) and surfaced live in Devise, not just printed by a one-shot CLI. No
// shell-out, no async, no side effects - given a repo root (or a version string) it
// returns a structured verdict any surface can render.
//
// First slice: ODOMETER LEGALITY per the Bill of Standards, Standard 13 (two-layer caps, DR-058 / DR-081):
//   MINOR hard cap = 12, KOHAI hard cap = 16, PATCH hard cap = 24. This mirrors
//   bump.mjs's input-legality guard (which exits 2 on an out-of-range counter). The
//   append-only-integrity, version-surface-drift, and governance-pack checks the stub
//   also named are documented expansions layered on this same shape.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export const MINOR_HARD_CAP = 12;
export const KOHAI_HARD_CAP = 16;
export const PATCH_HARD_CAP = 24;
// The maturity ladder (Standard 13): the pre-release suffix, climbing to a bare numeric version at GA.
export const MATURITY_LADDER = ["pre-alpha", "alpha", "beta", "rc"];
export const ASSESS_SCHEMA = "illuci.governance.assess/1";

function parseVersion(version) {
  const raw = String(version == null ? "" : version).trim();
  const m = /^(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(raw);
  if (!m) {
    return {
      raw,
      ok: false,
      violation:
        `malformed version "${raw}" (expected X.Y.K.P or legacy X.Y.Z, optionally ` +
        `-${MATURITY_LADDER.join("/-")})`,
    };
  }

  const prerelease = m[5] || "";
  const parts = prerelease ? prerelease.split(".") : [];
  let maturity = null;

  if (parts.length > 0 && MATURITY_LADDER.includes(parts[0])) {
    maturity = parts.shift();
  }

  if (parts.length > 0) {
    return {
      raw,
      ok: false,
      violation: `malformed prerelease "${prerelease}" (expected a maturity suffix only)`,
    };
  }

  return {
    raw,
    ok: true,
    major: Number(m[1]),
    minor: Number(m[2]),
    kohai: m[4] === undefined ? null : Number(m[3]),
    patch: m[4] === undefined ? Number(m[3]) : Number(m[4]),
    coordinateFormat: m[4] === undefined ? "legacy-three" : "four",
    maturity,
    prerelease,
  };
}

function formatVersion(major, minor, kohai, patch, maturity, forceFour = false) {
  const suffix = [];
  if (maturity) suffix.push(maturity);
  const core = forceFour || kohai !== null ? `${major}.${minor}.${kohai ?? 0}.${patch}` : `${major}.${minor}.${patch}`;
  return `${core}${suffix.length > 0 ? `-${suffix.join(".")}` : ""}`;
}

function bumpPatchCore({ major, minor, kohai, patch }) {
  if (patch === PATCH_HARD_CAP) {
    if (kohai === KOHAI_HARD_CAP) {
      if (minor === MINOR_HARD_CAP) {
        return {
          major: major + 1,
          minor: 0,
          kohai: 0,
          patch: 0,
          mechanism:
            `PATCH hard-cap chained overflow: PATCH and KOHAI are at cap ` +
            `(${PATCH_HARD_CAP}/${KOHAI_HARD_CAP}) and MINOR is at its cap (${MINOR_HARD_CAP}); chains to MAJOR`,
        };
      }
      return {
        major,
        minor: minor + 1,
        kohai: 0,
        patch: 0,
        mechanism:
          `PATCH hard-cap chained overflow: PATCH at cap (${PATCH_HARD_CAP}) and KOHAI at cap (${KOHAI_HARD_CAP}); rolls MINOR`,
      };
    }
    return {
      major,
      minor,
      kohai: kohai + 1,
      patch: 0,
      mechanism: `PATCH hard-cap overflow: PATCH exceeds cap (${PATCH_HARD_CAP}); rolls KOHAI`,
    };
  }
  return {
    major,
    minor,
    kohai,
    patch: patch + 1,
    mechanism: `PATCH bump`,
  };
}

function bumpKohaiCore({ major, minor, kohai }) {
  if (kohai === KOHAI_HARD_CAP) {
    if (minor === MINOR_HARD_CAP) {
      return {
        major: major + 1,
        minor: 0,
        kohai: 0,
        patch: 0,
        mechanism:
          `KOHAI hard-cap chained overflow: KOHAI is at cap (${KOHAI_HARD_CAP}) ` +
          `and MINOR is at its cap (${MINOR_HARD_CAP}); chains to MAJOR`,
      };
    }
    return {
      major,
      minor: minor + 1,
      kohai: 0,
      patch: 0,
      mechanism: `KOHAI hard-cap overflow: KOHAI exceeds cap (${KOHAI_HARD_CAP}); rolls MINOR`,
    };
  }
  return {
    major,
    minor,
    kohai: kohai + 1,
    patch: 0,
    mechanism: `KOHAI bump`,
  };
}

/**
 * Pure odometer-legality check. Mirrors bump.mjs's overflow guard without shelling out.
 *
 * @param {string} version  a X.Y.K.P root version, or legacy X.Y.Z string
 * @returns {{version:string, legal:boolean, major?:number, minor?:number, kohai?:number|null, patch?:number,
 *            minorCap:number, kohaiCap:number, patchCap:number, ceiling?:string,
 *            violation:(string|null)}}
 */
export function assessOdometer(version) {
  const parsed = parseVersion(version);
  if (!parsed.ok) {
    return {
      version: parsed.raw,
      legal: false,
      maturity: null,
      minorCap: MINOR_HARD_CAP,
      kohaiCap: KOHAI_HARD_CAP,
      patchCap: PATCH_HARD_CAP,
      violation: parsed.violation,
    };
  }
  const { raw, major, minor, kohai, patch, coordinateFormat, maturity } = parsed;

  let violation = null;
  if (minor > MINOR_HARD_CAP) {
    violation =
      `MINOR=${minor} exceeds the MINOR hard cap (${MINOR_HARD_CAP}); ` +
      `the odometer should have rolled MAJOR at ${major}.${MINOR_HARD_CAP}.${KOHAI_HARD_CAP}.${PATCH_HARD_CAP} ` +
      `(Bill of Standards, Standard 13 two-layer caps, DR-058 / DR-081)`;
  } else if (kohai !== null && kohai > KOHAI_HARD_CAP) {
    violation =
      `KOHAI=${kohai} exceeds the KOHAI hard cap (${KOHAI_HARD_CAP}); ` +
      `the odometer should have rolled MINOR at ${major}.${minor}.${KOHAI_HARD_CAP}.${PATCH_HARD_CAP}`;
  } else if (patch > PATCH_HARD_CAP) {
    violation =
      `PATCH=${patch} exceeds the PATCH hard cap (${PATCH_HARD_CAP}); ` +
      `the odometer should have rolled KOHAI at ${major}.${minor}.${kohai ?? 0}.${PATCH_HARD_CAP} ` +
      `(Bill of Standards, Standard 13, DR-081)`;
  }

  return {
    version: raw,
    legal: violation === null,
    major,
    minor,
    kohai,
    patch,
    coordinateFormat,
    maturity,
    minorCap: MINOR_HARD_CAP,
    kohaiCap: KOHAI_HARD_CAP,
    patchCap: PATCH_HARD_CAP,
    ceiling: `${major}.${MINOR_HARD_CAP}.${KOHAI_HARD_CAP}.${PATCH_HARD_CAP}`,
    violation,
  };
}

/**
 * Pure next-version computation - the SINGLE SOURCE for the GZDS odometer rollover.
 * Ported from bump.mjs, whose rollover lived in non-exported top-level CLI scope (so a
 * gate could only shell out to it or re-implement it - the duplication that let illegal
 * VERSIONs drift, DR-119 / DR-135). The author-time version gate (derive-and-compare) and
 * the bump.mjs CLI both consume THIS, so the cap-rollover arithmetic lives in exactly one
 * tested place. Reuses assessOdometer for the input-legality guard (one source for caps).
 *
 * @param {string} current  a legal X.Y.K.P root version, or legacy X.Y.Z version
 * @param {string} tier     "hotfix" | "patch" | "kohai" | "minor" | "major"
 * @returns {{ok:true, next:string, tier:string, mechanism:string, softMarker:string}
 *           | {ok:false, error:string}}
 */
export function computeNextVersion(current, tier) {
  const t = String(tier == null ? "" : tier).toLowerCase().trim();
  if (!["hotfix", "patch", "kohai", "minor", "major"].includes(t)) {
    return { ok: false, error: `tier must be one of hotfix|patch|kohai|minor|major (got "${tier}")` };
  }
  const legality = assessOdometer(current);
  if (!legality.legal) {
    return { ok: false, error: `illegal current version "${current}": ${legality.violation}` };
  }
  const { major: MAJOR, minor: MINOR, kohai, patch: PATCH, maturity } = legality;
  const KOHAI = kohai ?? 0;

  let nextMajor = MAJOR;
  let nextMinor = MINOR;
  let nextKohai = KOHAI;
  let nextPatch = PATCH;
  let mechanism = "";
  let softMarker = "";

  if (t === "hotfix" || t === "patch") {
    const bumped = bumpPatchCore({ major: MAJOR, minor: MINOR, kohai: KOHAI, patch: PATCH });
    nextMajor = bumped.major;
    nextMinor = bumped.minor;
    nextKohai = bumped.kohai;
    nextPatch = bumped.patch;
    mechanism = `${t.toUpperCase()} bump: ${current} -> ${formatVersion(nextMajor, nextMinor, nextKohai, nextPatch, maturity, true)}`;
    if (bumped.mechanism !== "PATCH bump") {
      mechanism = `${t.toUpperCase()} ${bumped.mechanism}: ${current} -> ${formatVersion(nextMajor, nextMinor, nextKohai, nextPatch, maturity, true)}`;
    } else {
      if (nextPatch === 10) softMarker = ` [soft milestone marker at PATCH=10; operator MAY roll MINOR discretionarily]`;
      else if (nextPatch === PATCH_HARD_CAP) softMarker = ` [PATCH hard cap reached; next hotfix rolls KOHAI]`;
    }
  } else if (t === "kohai") {
    const bumped = bumpKohaiCore({ major: MAJOR, minor: MINOR, kohai: KOHAI });
    nextMajor = bumped.major;
    nextMinor = bumped.minor;
    nextKohai = bumped.kohai;
    nextPatch = bumped.patch;
    mechanism = `KOHAI bump: ${current} -> ${formatVersion(nextMajor, nextMinor, nextKohai, nextPatch, maturity, true)}`;
    if (bumped.mechanism !== "KOHAI bump") {
      mechanism = `KOHAI ${bumped.mechanism}: ${current} -> ${formatVersion(nextMajor, nextMinor, nextKohai, nextPatch, maturity, true)}`;
    } else {
      if (nextKohai === 10) softMarker = ` [soft milestone marker at KOHAI=10; operator MAY roll MINOR discretionarily]`;
      else if (nextKohai === KOHAI_HARD_CAP) softMarker = ` [KOHAI hard cap reached; next kohai rolls MINOR]`;
    }
  } else if (t === "minor") {
    if (MINOR === MINOR_HARD_CAP) {
      nextMajor = MAJOR + 1;
      nextMinor = 0;
      nextKohai = 0;
      nextPatch = 0;
      mechanism = `MINOR hard-cap rollover: ${current} + regular; MINOR at cap (${MINOR_HARD_CAP}); rolls MAJOR (DR-058)`;
    } else {
      nextMinor = MINOR + 1;
      nextKohai = 0;
      nextPatch = 0;
      mechanism = `MINOR bump: ${current} + regular -> ${nextMajor}.${nextMinor}.0.0`;
      if (nextMinor === 10) softMarker = ` [soft milestone marker at MINOR=10; operator MAY roll MAJOR discretionarily]`;
      else if (nextMinor === MINOR_HARD_CAP) softMarker = ` [MINOR hard cap reached; next regular commit rolls MAJOR]`;
    }
  } else {
    nextMajor = MAJOR + 1;
    nextMinor = 0;
    nextKohai = 0;
    nextPatch = 0;
    mechanism = `MAJOR bump: ${current} + discretionary major -> ${nextMajor}.0.0.0`;
  }

  return { ok: true, next: formatVersion(nextMajor, nextMinor, nextKohai, nextPatch, maturity, true), tier: t, mechanism, softMarker };
}

/** Read the first line of a project's root VERSION file, or null if absent. */
function readVersionFile(repoRoot) {
  const vf = join(repoRoot, "VERSION");
  if (!existsSync(vf)) return null;
  const first = readFileSync(vf, "utf8").split(/\r?\n/)[0];
  return first.trim() || null;
}

/**
 * Assess a project's governance posture. First slice = odometer legality of the root
 * VERSION. Returns a structured verdict ready for the CLI, an MC status payload, or a
 * real-time stream frame.
 *
 * Verdicts (a subset of the governance verdict categories, filled out as slices land):
 *   blocked           - no readable VERSION
 *   exception-bearing - a real violation (illegal odometer state)
 *   standard          - no violations in the checks run
 *
 * @param {string} [repoRoot=process.cwd()]
 */
export function assessProject(repoRoot = process.cwd()) {
  const findings = [];
  const version = readVersionFile(repoRoot);

  let odometer = null;
  if (version === null) {
    findings.push({
      severity: "high",
      code: "version-missing",
      message: "no readable root VERSION file",
    });
  } else {
    odometer = assessOdometer(version);
    if (!odometer.legal) {
      findings.push({
        severity: "high",
        code: "odometer-illegal",
        message: `VERSION ${version} is an illegal odometer state: ${odometer.violation}`,
      });
    }
  }

  let verdict = "standard";
  if (findings.some((f) => f.code === "version-missing")) verdict = "blocked";
  else if (findings.length > 0) verdict = "exception-bearing";

  return {
    schema: ASSESS_SCHEMA,
    repoRoot,
    verdict,
    version,
    odometer,
    findings,
  };
}

/**
 * Pure composition-consistency check for a single seat across resolved composition events.
 * The first measurable system-value metric over the composition-metadata moat (W3): how
 * stable a seat's compiled disposition fingerprint is across its runs.
 *
 * @param {Array<{engine?:string, edges?:{seatId?:string, presetId?:string}, disposition?:Object}>} compositionEvents
 *        array of composition_resolved telemetry PAYLOADS; any field may be null/missing.
 *        Pass the UNWRAPPED event `.payload` objects: the runner records
 *        { engine, edges, disposition } nested under `payload`, and this reads `edges`
 *        and `disposition` at the top level. The caller (MC / CLI) does the `.payload` unwrap.
 * @param {string} seatId  the seat whose runs should be assessed
 * @returns {{seatId:string, presetId:(string|null), runCount:number, stabilityScore:number,
 *            directiveCountDrift:number, trend:string}}
 *
 * Fingerprints use a control-character-free JSON representation.
 */
export function assessCompositionConsistency(compositionEvents, seatId) {
  const seat = String(seatId == null ? "" : seatId).trim();
  const events = Array.isArray(compositionEvents) ? compositionEvents : [];

  const NULL_SENTINEL = Symbol("null");
  const normalizeFPValue = (v) => (v === null || v === undefined ? NULL_SENTINEL : v);

  const fingerprintOf = (run) => {
    const d = (run && run.disposition) || {};
    return [
      normalizeFPValue(run && run.edges ? run.edges.presetId : undefined),
      normalizeFPValue(d.activeFacets),
      normalizeFPValue(d.activeDarkTriad),
      normalizeFPValue(d.activePid5),
      normalizeFPValue(d.activeValues),
      normalizeFPValue(d.enneagramCore),
      normalizeFPValue(d.directiveCount),
    ];
  };

  const seatRuns = events.filter((ev) => {
    const ed = ev && ev.edges ? ev.edges : null;
    return ed != null && String(ed.seatId == null ? "" : ed.seatId).trim() === seat;
  });

  const runCount = seatRuns.length;

  if (runCount === 0) {
    return {
      seatId: seat,
      presetId: null,
      runCount: 0,
      stabilityScore: 1,
      directiveCountDrift: 0,
      trend: "insufficient-data",
    };
  }

  const presetCounts = new Map();
  const firstPresetIndex = new Map();
  for (let i = 0; i < seatRuns.length; i++) {
    const pid = seatRuns[i] && seatRuns[i].edges ? seatRuns[i].edges.presetId : undefined;
    if (pid === null || pid === undefined) continue;
    const key = String(pid);
    presetCounts.set(key, (presetCounts.get(key) || 0) + 1);
    if (!firstPresetIndex.has(key)) firstPresetIndex.set(key, i);
  }

  let presetId = null;
  if (presetCounts.size > 0) {
    const entries = [...presetCounts.entries()];
    entries.sort((a, b) =>
      b[1] !== a[1] ? b[1] - a[1] : firstPresetIndex.get(a[0]) - firstPresetIndex.get(b[0]),
    );
    presetId = entries[0][0];
  }

  // Collision-resistant fingerprint key via JSON (null sentinel -> null). The 7 fields are
  // scalars (activation counts as integers, enneagramCore string|null) per the live
  // composition_resolved payload, so JSON serialization is injective here.
  const fpKey = (fp) => JSON.stringify(fp.map((v) => (v === NULL_SENTINEL ? null : v)));
  const fingerprints = seatRuns.map(fingerprintOf);

  const fpCounts = new Map();
  const firstFPIndex = new Map();
  for (let i = 0; i < fingerprints.length; i++) {
    const k = fpKey(fingerprints[i]);
    fpCounts.set(k, (fpCounts.get(k) || 0) + 1);
    if (!firstFPIndex.has(k)) firstFPIndex.set(k, i);
  }

  let modalFPCount = 0;
  {
    const entries = [...fpCounts.entries()];
    entries.sort((a, b) =>
      b[1] !== a[1] ? b[1] - a[1] : firstFPIndex.get(a[0]) - firstFPIndex.get(b[0]),
    );
    modalFPCount = entries[0][1];
  }

  const stabilityScore = modalFPCount / runCount;

  const directiveCounts = [];
  for (const run of seatRuns) {
    const dc = run && run.disposition ? run.disposition.directiveCount : undefined;
    if (typeof dc === "number" && Number.isFinite(dc)) directiveCounts.push(dc);
  }

  let directiveCountDrift = 0;
  if (directiveCounts.length >= 2) {
    let mn = directiveCounts[0];
    let mx = directiveCounts[0];
    for (let i = 1; i < directiveCounts.length; i++) {
      if (directiveCounts[i] < mn) mn = directiveCounts[i];
      if (directiveCounts[i] > mx) mx = directiveCounts[i];
    }
    directiveCountDrift = mx - mn;
  }

  const trend = runCount < 2 ? "insufficient-data" : stabilityScore === 1 ? "stable" : "drifting";

  return {
    seatId: seat,
    presetId,
    runCount,
    stabilityScore,
    directiveCountDrift,
    trend,
  };
}

/**
 * The legal maturity ADVANCES for a version: same odometer count, the suffix climbs one rung, or
 * rc drops to a bare GA. Maturity only ever advances; a bare GA version has none. The version gate
 * accepts these alongside the count-bump successors so a maturity promotion is a valid transition.
 */
export function maturitySuccessors(version) {
  const a = assessOdometer(version);
  if (!a.legal || a.maturity === null) return [];
  const core = a.coordinateFormat === "four"
    ? `${a.major}.${a.minor}.${a.kohai}.${a.patch}`
    : `${a.major}.${a.minor}.${a.patch}`;
  const i = MATURITY_LADDER.indexOf(a.maturity);
  return i === MATURITY_LADDER.length - 1 ? [core] : [`${core}-${MATURITY_LADDER[i + 1]}`];
}

export default { assessOdometer, computeNextVersion, maturitySuccessors, assessProject, assessCompositionConsistency, MATURITY_LADDER, MINOR_HARD_CAP, KOHAI_HARD_CAP, PATCH_HARD_CAP, ASSESS_SCHEMA };
