/**
 * illuci — persona-kernel loader (DR-170 Phase B1, [A82]/DR-175).
 *
 * OPTIONAL-LOAD seam for the Tier-1 napi addon (ADR-07: `seedFromPreset` +
 * `renderDirective`, once per dispatch, no shared state). The engine never
 * requires the addon: where it is absent, `loadPersonaKernel()` returns
 * `{ available: false, reason }` and the DR-170 D6 napi-gate simply stays
 * closed — every other surface is unaffected. Build it locally with
 * `npm run kernel:napi:build` (CI is node-only; the addon is gitignored).
 *
 * MARSHALLING (ADR-02, resolved by DR-175): bulk data crosses the FFI as
 * little-endian byte blobs only — the seed blob (68 x i64 LE + 3 x u8 =
 * 547 bytes) and the activation blob (68 records x 12 bytes). BigInt is
 * retired AT THE BOUNDARY; this loader decodes q_value to BigInt locally
 * from the blob (exact, no FFI marshalling involved).
 *
 * ERROR TYPING (ADR-07 Phase-2 gate, resolved by DR-175): the kernel throws
 * `Error("CODE: detail")` from a CLOSED vocabulary; this loader parses the
 * prefix onto `error.code` so call sites can switch on it.
 *
 * CONFOUND note (ADR-01): this loader is kernel-generic — axes are indices.
 * The facet->axis projection (SEED_PROJECTION_V1) belongs to the DOMAIN
 * consumer that composes seeds, not here.
 *
 * @module core/agents/persona-kernel
 */

import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const requireAddon = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ADDON_PATH = join(HERE, "..", "..", "kernel", "persona-kernel-napi", "persona-kernel.node");

/** The closed ADR-07 error-code vocabulary (DR-175; extended by DR-176 B2). */
export const KERNEL_ERROR_CODES = Object.freeze([
  "KERNEL_BAD_AXES_LEN",
  "KERNEL_BAD_CATEGORICAL_LEN",
  "KERNEL_AXIS_NOT_FINITE",
  "KERNEL_AXIS_RANGE",
  "KERNEL_BAD_SEED_BLOB",
  "KERNEL_BAD_SIGNAL",
  "KERNEL_BAD_DIRECTIONS",
]);

const CODE_RE = /^([A-Z][A-Z0-9_]+): /;

function normalizeKernelError(err) {
  const msg = String(err && err.message ? err.message : err);
  const m = CODE_RE.exec(msg);
  const out = new Error(msg);
  if (m && KERNEL_ERROR_CODES.includes(m[1])) out.code = m[1];
  else out.code = "KERNEL_UNKNOWN"; // panic backstop / untyped defect — still discriminable
  return out;
}

function wrap(fn) {
  return (...args) => {
    try {
      return fn(...args);
    } catch (err) {
      throw normalizeKernelError(err);
    }
  };
}

/**
 * Decode a grade-delta blob (i64 LE per entry) into EXACT float shifts for the
 * AM-23 ledger. The v1 grade step is dyadic (1/32), so Number(q)/2^32 is exact
 * — no precision is lost between the Q32.32 kernel and the JSONL delta.
 */
export function decodeDeltas(blob) {
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  if (buf.length % 8 !== 0) {
    const e = new Error(`KERNEL_BAD_SIGNAL: delta blob length ${buf.length} is not a multiple of 8`);
    e.code = "KERNEL_BAD_SIGNAL";
    throw e;
  }
  const out = [];
  for (let o = 0; o < buf.length; o += 8) {
    out.push(Number(buf.readBigInt64LE(o)) / 4294967296); // 2^32
  }
  return out;
}

/** Decode the packed activation blob (68 x 12-byte LE records) into records. */
export function decodeActivations(blob) {
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  if (buf.length % 12 !== 0) {
    const e = new Error(`KERNEL_BAD_SEED_BLOB: activation blob length ${buf.length} is not a multiple of 12`);
    e.code = "KERNEL_BAD_SEED_BLOB";
    throw e;
  }
  const out = [];
  for (let o = 0; o < buf.length; o += 12) {
    out.push({
      axis: buf[o + 8],
      qValue: buf.readBigInt64LE(o), // exact Q32.32 (local decode, not FFI marshalling)
      band7: buf[o + 9],
      directiveBand: buf.readInt8(o + 10),
    });
  }
  return out;
}

let cached = null;
let cachedPath = null;

/**
 * Load (and memoize) the Tier-1 kernel addon.
 * @param {{addonPath?:string, force?:boolean}} [opts]
 *        addonPath: explicit addon location (tests / non-standard deploys);
 *        the env override ILLUCI_PERSONA_KERNEL_PATH is the disclosed control.
 * @returns {{available:true, info:object, seedFromPreset:Function, renderDirective:Function, decodeActivations:Function}
 *          |{available:false, reason:string}}
 */
export function loadPersonaKernel({ addonPath, force = false } = {}) {
  const path = resolve(addonPath || process.env.ILLUCI_PERSONA_KERNEL_PATH || DEFAULT_ADDON_PATH);
  if (!force && cached && cachedPath === path) return cached;
  cachedPath = path;

  if (!existsSync(path)) {
    cached = {
      available: false,
      reason: `persona-kernel addon not built at ${path} — run \`npm run kernel:napi:build\` (DR-170 D6: the napi-gate stays closed without it)`,
    };
    return cached;
  }

  let native;
  try {
    native = requireAddon(path);
  } catch (err) {
    cached = { available: false, reason: `persona-kernel addon failed to load: ${err.message}` };
    return cached;
  }

  let info;
  try {
    info = JSON.parse(native.kernelInfo());
  } catch (err) {
    cached = { available: false, reason: `persona-kernel addon self-description failed: ${err.message}` };
    return cached;
  }
  if (info.abi !== "persona-kernel-napi/1" || info.nAxes !== 68) {
    cached = { available: false, reason: `persona-kernel ABI mismatch: ${JSON.stringify(info)}` };
    return cached;
  }

  cached = {
    available: true,
    info,
    seedFromPreset: wrap((values, categorical) =>
      native.seedFromPreset(
        values instanceof Float64Array ? values : Float64Array.from(values),
        categorical instanceof Uint8Array ? categorical : Uint8Array.from(categorical),
      ),
    ),
    renderDirective: wrap((seedBlob) => native.renderDirective(seedBlob)),
    // DR-176 (Phase B2): the v1 grade — anonymous directions in, Q32.32 deltas out.
    gradeSignals: wrap((stability, runCount, directions) =>
      native.gradeSignals(
        stability,
        runCount,
        directions instanceof Int8Array ? directions : Int8Array.from(directions),
      ),
    ),
    decodeActivations,
    decodeDeltas,
  };
  return cached;
}

export default { loadPersonaKernel, decodeActivations, decodeDeltas, KERNEL_ERROR_CODES };
