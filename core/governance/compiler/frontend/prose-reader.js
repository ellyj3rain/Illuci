// illuci/core/governance/compiler/frontend/prose-reader.js
//
// FRONTEND companion: read the Bill + Constitution prose and enumerate every standard/article
// it names, so the promise-gap pass can flag any with NO declaration file (a Class-A gap: a
// governed commitment the compiler was never told how to enforce). Heuristic but pure - it
// matches the standard/article headings the documents use and de-duplicates by number.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export const BILL = join("constitutional", "BILL_OF_STANDARDS.md");
export const CONSTITUTION = join("constitutional", "CONSTITUTION.md");

const ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"];

function read(repoRoot, rel) {
  const p = join(repoRoot, rel);
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}

/**
 * @param {string} repoRoot
 * @param {Set<string>} declaredKeys  source_keys that DO have a declaration (std-12, art-IX, ...)
 * @returns {Array<{key,label,declared}>}
 */
export function readProse(repoRoot, declaredKeys = new Set()) {
  const out = [];

  const bill = read(repoRoot, BILL);
  if (bill) {
    const seen = new Set();
    const re = /(?:^|\n)#{0,4}\s*Standard\s+(\d{1,2})\b/gi;
    let m;
    while ((m = re.exec(bill))) {
      const n = parseInt(m[1], 10);
      if (seen.has(n)) continue;
      seen.add(n);
      const key = "std-" + n;
      out.push({ key, label: `Standard ${n}`, declared: declaredKeys.has(key) });
    }
  }

  const con = read(repoRoot, CONSTITUTION);
  if (con) {
    const seen = new Set();
    const re = /(?:^|\n)#{0,4}\s*Article\s+([IVX]{1,5})\b/g;
    let m;
    while ((m = re.exec(con))) {
      const num = m[1];
      if (seen.has(num) || !ROMAN.includes(num)) continue;
      seen.add(num);
      const key = "art-" + num;
      out.push({ key, label: `Article ${num}`, declared: declaredKeys.has(key) });
    }
  }

  return out;
}

export default { readProse, BILL, CONSTITUTION };
