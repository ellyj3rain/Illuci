import { test } from "node:test";
import assert from "node:assert/strict";
import { validateServingModule, makeServingModule } from "./serving-module.js";
import { getBridge } from "./index.js";

function clearFlags() {
  delete process.env.ILLUCI_FLEET_NORMALIZED_ENABLED;
  delete process.env.ILLUCI_FLEET_SERVING_MODULE_ENABLED;
}

test("validateServingModule: query() present (named or default) is valid; absent is missing", () => {
  assert.deepEqual(validateServingModule({ query: () => {} }), { ok: true, missing: [] });
  assert.deepEqual(validateServingModule({ default: { query: () => {} } }), { ok: true, missing: [] });
  assert.deepEqual(validateServingModule({}), { ok: false, missing: ["query"] });
});

test("makeServingModule: C2 stamps the identity, preserves servedModel + channel, passes other fields", async () => {
  const fakeBridge = { query: async () => ({ model: "agy", response: "hi", usage: { in: 1 } }) };
  const sm = makeServingModule(fakeBridge, { id: "gemini", transport: "antigravity", bridge: "agy.js" });
  const r = await sm.query("ping", {});
  assert.equal(r.model, "gemini");      // identity, NOT the bridge literal "agy"
  assert.equal(r.servedModel, "agy");   // served model preserved
  assert.equal(r.channel, "antigravity");
  assert.equal(r.response, "hi");
  assert.equal(r.usage.in, 1);          // other fields pass through untouched
});

test("makeServingModule: optional methods pass through only when the bridge implements them", () => {
  const withStream = makeServingModule({ query: () => {}, queryStream: () => {} }, { id: "x" });
  assert.equal(typeof withStream.queryStream, "function");
  const without = makeServingModule({ query: () => {} }, { id: "y" });
  assert.equal(without.queryStream, undefined);
});

test('actual retrieval interface survives the facade independently of identity', async () => {
  for (const id of ['unlisted-local','opaque-remote']) {
    let calls=0;
    const mod={query:async()=>({response:'answer'}),retrieveTrace:async function(request){calls++;assert.equal(this,mod);return {events:[],operationId:request.operationId};}};
    const view=makeServingModule(mod,{id});
    assert.equal((await view.retrieveTrace({operationId:'one'})).operationId,'one');assert.equal(calls,1);
    assert.equal(makeServingModule({query:mod.query},{id}).retrieveTrace,undefined);
  }
});

test("getBridge flag-OFF: returns the RAW module (byte-identical — no ServingModule view)", async () => {
  clearFlags();
  const mod = await getBridge("gemini"); // agy.js (import only, no dispatch)
  assert.equal(typeof (mod.query || mod.default?.query), "function");
  assert.equal(mod.id, undefined); // raw module has none of the view fields
});

test("getBridge: umbrella ON but sub-flag OFF -> still raw (sub-flag gated by the umbrella)", async () => {
  clearFlags();
  process.env.ILLUCI_FLEET_NORMALIZED_ENABLED = "true";
  const mod = await getBridge("gemini");
  assert.equal(mod.id, undefined);
  clearFlags();
});

test("getBridge flag-ON: returns a ServingModule view (identity welded)", async () => {
  clearFlags();
  process.env.ILLUCI_FLEET_NORMALIZED_ENABLED = "true";
  process.env.ILLUCI_FLEET_SERVING_MODULE_ENABLED = "true";
  const sm = await getBridge("gemini");
  assert.equal(sm.id, "gemini");
  assert.equal(sm.transport, "antigravity");
  assert.equal(typeof sm.query, "function");
  clearFlags();
});
