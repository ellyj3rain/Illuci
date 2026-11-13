// Proof: the verification gate flags a clean-code violation and passes clean code, judged by a live fleet model.
import { verify } from "./verify.js";
import { byId } from "./registry.js";
import grok from "../bridges/grok-cli.js";

const judge = async (prompt) => (await grok.query(prompt, { writeMode: false })).response;
const inv = byId("clean-code");

const dirty = `/**
 * Adds two numbers together.
 * Same lesson the other adder carries: we add a and b and return the result.
 * @param a the first number
 * @param b the second number
 * @returns the sum
 */
function add(a, b) { return a + b; } // return the sum of a and b`;

const clean = `function add(a, b) { return a + b; }`;

for (const [label, out] of [["dirty", dirty], ["clean", clean]]) {
  const r = await verify(out, inv, judge);
  console.log(label, "=>", JSON.stringify(r));
}
