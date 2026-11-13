// illuci/core/governance/compiler/ir/content-addresser.js
//
// Deterministic source hashing for the GIR. The compile short-circuits when the hash of all
// inputs (the obligation declarations, sorted by path) is unchanged since the last compile,
// so identical inputs always reproduce the identical GIR and re-emission is skipped. Pure.

import { createHash } from "node:crypto";

/**
 * @param {Array<{path:string, content:string}>} sources
 * @returns {string} "sha256:<hex>" over path+content pairs in sorted-path order
 */
export function sourceHash(sources) {
  const h = createHash("sha256");
  const sorted = [...sources].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const s of sorted) {
    h.update(s.path);
    h.update("\0");
    h.update(s.content);
    h.update("\0");
  }
  return "sha256:" + h.digest("hex");
}

export default { sourceHash };
