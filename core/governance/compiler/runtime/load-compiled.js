// illuci/core/governance/compiler/runtime/load-compiled.js
//
// The bridge: load the compiled enforcers from compiled/ and expose them grouped by tier, so
// the live runtime (floor-check, dispatch gate, carry, soft-verify) can RUN the compiled
// governance rather than just have it sit emitted on disk. Dynamic-imports every emitted module
// under compiled/<tier>/. This is the seam the existing floor wires into to go from convention-
// enforcement to Bill-enforcement; it does not modify the existing floor itself.

import { readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const COMPILED_ROOT = join(here, "..", "..", "compiled"); // runtime -> compiler -> governance -> compiled

async function loadDir(sub) {
  const dir = join(COMPILED_ROOT, sub);
  if (!existsSync(dir)) return [];
  const mods = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".js"))) {
    mods.push(await import(pathToFileURL(join(dir, f)).href));
  }
  return mods;
}

/** Load every compiled enforcer, grouped by tier. */
export async function loadCompiled() {
  const [floor, gate, carried, soft] = await Promise.all([
    loadDir("floor"), loadDir("gate"), loadDir("carried"), loadDir("soft"),
  ]);
  return { floor, gate, carried, soft };
}

/** Run the hard floor + gate enforcers over a context; collect blocks (armed verdicts). */
export async function runHard(context = {}) {
  const { floor, gate } = await loadCompiled();
  const blocking = [];
  for (const m of [...floor, ...gate]) {
    const v = m.check(context);
    if (!v.ok) blocking.push({ obligation: m.OBLIGATION_ID, reason: v.reason });
  }
  return { ok: blocking.length === 0, blocking };
}

/** The carried preambles to fold into a seat's operating context. */
export async function carriedPreambles() {
  const { carried } = await loadCompiled();
  return carried.map((m) => ({ id: m.OBLIGATION_ID, preamble: m.PREAMBLE, trigger: m.TRIGGER }));
}

/** Run the soft-verify pass; collect advisory findings (never blocks). */
export async function runSoft(context = {}) {
  const { soft } = await loadCompiled();
  const findings = [];
  for (const m of soft) {
    const v = m.verify(context);
    if (!v.ok) findings.push({ obligation: m.OBLIGATION_ID, reason: v.reason });
  }
  return { findings };
}

export default { loadCompiled, runHard, carriedPreambles, runSoft };
