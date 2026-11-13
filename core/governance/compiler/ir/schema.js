// illuci/core/governance/compiler/ir/schema.js
//
// The Governance Intermediate Representation (GIR) shape + a thin structural validator. The
// GIR is the deterministic, content-addressed compile artifact: every obligation lowered to a
// tier + mechanism, plus the promise-gap report and stats. schema.js owns the shape; the
// pipeline (index.js) builds instances and writes governance.gir.json. Pure.

export const GIR_SCHEMA = "gzds-gir/1.0";

/** Build an empty GIR envelope. The caller fills obligations / promise_gaps / stats. */
export function emptyGir(sourceHash, batch) {
  return {
    $schema: GIR_SCHEMA,
    source_hash: sourceHash,
    compiled_batch: batch || null,
    obligations: [],
    promise_gaps: [],
    stats: {},
  };
}

/** Structural validation of a built GIR. Returns {ok, errors[]}. Pure. */
export function validateGir(gir) {
  const errors = [];
  if (!gir || typeof gir !== "object") return { ok: false, errors: ["gir is not an object"] };
  if (gir.$schema !== GIR_SCHEMA) errors.push(`bad $schema: ${gir.$schema}`);
  if (typeof gir.source_hash !== "string") errors.push("source_hash missing");
  if (!Array.isArray(gir.obligations)) errors.push("obligations not an array");
  for (const o of gir.obligations || []) {
    if (!o.id) errors.push("an obligation is missing id");
    if (!o.tier) errors.push(`obligation ${o.id || "?"} missing tier`);
  }
  return { ok: errors.length === 0, errors };
}

export default { GIR_SCHEMA, emptyGir, validateGir };
