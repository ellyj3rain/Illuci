// node:test — [A40]/CAP-4: the flipped floor at the dispatch choke point. A
// vision-lane dispatch with no grant REFUSES before any bridge I/O, with the
// standard blocked failure shape.
import { test } from "node:test";
import assert from "node:assert/strict";
import { queryModel } from "./dispatch.js";

test("a vlm dispatch without a vision grant REFUSES pre-bridge (blocked shape, coded)", async () => {
  const result = await queryModel("nim-llama-3.2-90b-vision", "describe the screen", { seat: "ungrannted-test-seat", raw: true });
  assert.equal(result.failed, true);
  assert.equal(result.blocked, true);
  assert.equal(result.code, "CAPABILITY_LICENSE_DENIED");
  assert.match(result.error, /vision capability required/);
  assert.equal(result.response, null);
});

test("a granted resolution passes the vision gate (fails later on the bridge, NOT on capability)", async () => {
  const granted = { capabilities: { vision: { state: "granted", via: ["g-test"] } } };
  const result = await queryModel("nim-llama-3.2-90b-vision", "describe", { seat: "s", raw: true, capabilityResolution: granted, timeoutMs: 1 });
  // Whatever the bridge outcome (no key/timeout), it must NOT be a capability block.
  assert.notEqual(result.code, "CAPABILITY_LICENSE_DENIED");
});
