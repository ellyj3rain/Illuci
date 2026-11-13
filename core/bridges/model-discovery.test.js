/**
 * model-discovery tests — the deterministic logic (tagging + probe
 * classification + cache self-heal). Host observations and transports in
 * this file are synthetic; no live inference or account access is established.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ollamaFamily, classifyProbe, invalidate, CACHE_PATH, probeModel, discoverOllama, discoverModels, discoverCodexAccountCatalog, selectCodexAccountModel, discoverGrokAccountCatalog, selectGrokAccountModel } from "./model-discovery.js";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { dirname } from "path";

test("ollama tag maps to the right capability family", () => {
  assert.equal(ollamaFamily("deepseek-v3.1:671b-cloud"), "deepseek");
  assert.equal(ollamaFamily("gpt-oss:120b-cloud"), "gpt");
  assert.equal(ollamaFamily("qwen3-coder:480b-cloud"), "qwen");
  assert.equal(ollamaFamily("huihui_ai/Qwen3.6-abliterated:35b"), "qwen"); // namespaced community tag
  assert.equal(ollamaFamily("kimi-k2.6:cloud"), "kimi");
  assert.equal(ollamaFamily("llama3:8b"), "llama");
});

test("an Ollama catalog is inventory, not inference or account entitlement", async () => {
  const result = await discoverOllama({ _listModels: async () => ({ models: [
    { name: "qwen:latest" }, { name: "kimi:cloud" }, { name: "cloud-user/qwen:local" },
  ] }) });
  assert.deepEqual(result.models.map(m => m.provider), ["ollama-local", "ollama-cloud", "ollama-local"]);
  for (const model of result.models) {
    assert.equal(model.localityBasis, "model-tag-only");
    assert.equal(model.actualEndpoint, "unknown");
    assert.equal(model.disclosureSuitability, "unknown");
    assert.equal(model.executionAuthority, "none");
  }
  assert.ok(result.models.every(m => m.available === null && m.status === "listed-unverified"));
});

test("probe classification: not-found markers mean unavailable, faults mean unknown", () => {
  assert.equal(classifyProbe("There's an issue with the selected model (claude-fable-5). It may not exist or you may not have access to it."), "unavailable");
  assert.equal(classifyProbe("api_error_status 404 model not found"), "unavailable");
  assert.equal(classifyProbe("pong"), "available");
  assert.equal(classifyProbe("Here is the answer you asked for."), "available");
  assert.equal(classifyProbe(""), "unknown");       // empty/transient → not asserted unavailable
  assert.equal(classifyProbe(null), "unknown");
});

test("invalidate drops a cached entry so the next read re-probes (self-heal)", () => {
  mkdirSync(dirname(CACHE_PATH), { recursive: true });
  const prior = existsSync(CACHE_PATH) ? readFileSync(CACHE_PATH, "utf-8") : null;
  try {
    writeFileSync(CACHE_PATH, JSON.stringify({ "test-model": { available: true, checkedAt: 1 } }), "utf-8");
    invalidate("test-model");
    const after = JSON.parse(readFileSync(CACHE_PATH, "utf-8"));
    assert.ok(!("test-model" in after), "invalidated entry must be gone");
  } finally {
    if (prior !== null) writeFileSync(CACHE_PATH, prior, "utf-8");
    else rmSync(CACHE_PATH, { force: true });
  }
});

test("probeModel treats unknown bridge files as missing without dynamic imports", async () => {
  const result = await probeModel({ id: "ghost-model", bridge: "ghost.js", model: "ghost" });
  assert.deepEqual(result, {
    id: "ghost-model",
    available: false,
    status: "missing",
    detail: "unknown bridge ghost.js",
  });
});

test("discovery does not launch unbound ambient agentic workers", async () => {
  for (const [id, bridge] of [['codex-terra','codex.js'], ['grok-build','grok-cli.js'],
    ['claude-opus','claude.js'], ['gemini','agy.js'], ['kimi-local','kimi.js']]) {
    const result = await probeModel({ id, bridge, model: 'fixture' });
    assert.equal(result.status, "unknown");
    assert.equal(result.available, null);
    assert.match(result.detail, /Account.*not bound.*probe not attempted/);
  }
});

test("unscoped old CLI cache cannot certify another account", async () => {
  mkdirSync(dirname(CACHE_PATH), { recursive: true });
  const prior = existsSync(CACHE_PATH) ? readFileSync(CACHE_PATH, 'utf8') : null;
  try {
    writeFileSync(CACHE_PATH, JSON.stringify({ 'grok-build': { available: true, status: 'available', checkedAt: Date.now() } }));
    const result = await discoverModels({ probe: false, _ollamaDiscovery: async () => ({ models: [] }) });
    const grok = result.models.find(x => x.id === 'grok-build');
    assert.equal(grok.available, null); assert.equal(grok.status, 'unknown');
    assert.equal(grok.source, 'account-unbound'); assert.equal(grok.checkedAt, null);
  } finally {
    if (prior !== null) writeFileSync(CACHE_PATH, prior); else rmSync(CACHE_PATH, { force: true });
  }
});

test('existing account observation reaches discovery as account-scoped catalog evidence', async () => {
  const binding = { accountId: 'account-a', subjectSha256: 'a'.repeat(64) };
  let reads = 0;
  const observation = { ...binding, source:'official-codex-app-server', identityMatched:true,
    observedAt:1000, modelsComplete:false, models:[
      { model:'gpt-fixture', isDefault:true, defaultReasoningEffort:'high', supportedReasoningEfforts:['high','low'] },
    ] };
  const result = await discoverModels({ includeOllama: false, _ollamaDiscovery: async () => { throw Error('unrelated provider read'); }, accountCatalog: {
    selection: binding, now: () => 1001, readObservation: async selected => { reads++; assert.deepEqual(selected, binding); return observation; },
  } });
  assert.equal(reads, 1);
  const catalog = result.codexAccountCatalog;
  assert.equal(catalog.status, 'host-reported'); assert.equal(catalog.accountId, binding.accountId);assert.equal(catalog.subjectSha256,binding.subjectSha256);
  assert.equal(catalog.complete, false); assert.equal(catalog.inferenceVerified, false); assert.equal(catalog.authority, 'none');
  assert.deepEqual(catalog.models[0], { model: 'gpt-fixture', isDefault: true, defaultReasoningEffort: 'high',
    supportedReasoningEfforts: ['high','low'], status: 'advertised-unverified', available: null });
  assert.equal(result.models.find(x => x.id === 'codex-terra').available, null);
});

test('account selection resolves a registry candidate only through its fresh subject-bound catalog',async()=>{
 const selection={accountId:'account-a',subjectSha256:'a'.repeat(64)},observation={...selection,source:'official-codex-app-server',identityMatched:true,observedAt:1000,modelsComplete:true,models:[
  {model:'gpt-6-astra',isDefault:true,defaultReasoningEffort:'medium',supportedReasoningEfforts:['low','medium','high','xhigh','max','ultra']},
  {model:'gpt-6-luna',isDefault:false,defaultReasoningEffort:'medium',supportedReasoningEfforts:['low','medium','high','xhigh','max']},
 ]};
 const catalog=await discoverCodexAccountCatalog({selection,now:()=>1001,readObservation:async()=>observation});
 assert.deepEqual(selectCodexAccountModel(catalog,{model:'codex-astra',reasoning:'xhigh'}),{status:'advertised-unverified',source:'official-codex-app-server',accountId:selection.accountId,subjectSha256:selection.subjectSha256,observedAt:1000,complete:true,model:'gpt-6-astra',reasoning:'xhigh',isDefault:true,defaultReasoningEffort:'medium',authority:'none',inferenceVerified:false});
 assert.equal(selectCodexAccountModel(catalog,{model:'codex-terra',reasoning:'high'}).status,'model-not-advertised');
 assert.equal(selectCodexAccountModel(catalog,{model:'codex-luna',reasoning:'ultra'}).status,'reasoning-not-advertised');
 const copied=structuredClone(catalog);assert.equal(selectCodexAccountModel(copied,{model:'codex-astra',reasoning:'high'}).status,'catalog-unavailable');
});

test('account catalog rejects foreign, stale, duplicated and unavailable observations', async () => {
  const selection = { accountId: 'account-a', subjectSha256: 'a'.repeat(64) };
  const model = { model: 'gpt-fixture', supportedReasoningEfforts: ['high'] };
  const observation = { ...selection, source: 'official-codex-app-server', identityMatched: true,
    observedAt: 1000, modelsComplete: false, models: [model] };
  const inspect = value => discoverCodexAccountCatalog({ selection, now: () => 1001, readObservation: async () => value });
  assert.equal((await inspect({ ...observation, accountId: 'account-b' })).status, 'observation-mismatch');
  assert.equal((await inspect({ ...observation, subjectSha256: 'b'.repeat(64) })).status, 'observation-mismatch');
  assert.equal((await inspect({ ...observation, observedAt: -100000 })).status, 'observation-stale');
  assert.equal((await inspect({ ...observation, models: [model, model] })).status, 'catalog-invalid');
  assert.equal((await discoverCodexAccountCatalog({ selection, readObservation: async () => { throw Error('fixture'); } })).status, 'observation-unavailable');
});

test('account catalog cannot be combined with ambient provider probes', async () => {
  let invoked = false;
  await assert.rejects(discoverModels({ probe: true, accountCatalog: {}, _ollamaDiscovery: async () => { invoked = true; } }), /cannot be combined/);
  assert.equal(invoked, false);
});

test('unauthenticated Grok cache names cannot advertise account models', async () => {
  const selection = { profileId: 'grok-a', profileHomeSha256: 'b'.repeat(64) };
  const observation = {
    source: 'official-grok-build-cli', status: 'unauthenticated', authenticated: false,
    profileId: selection.profileId, profileHomeSha256: selection.profileHomeSha256,
    profileBindingMatched: true, accountIdentityVerified: false, observedAt: 1000,
    complete: false, models: [], cachedCandidates: ['grok-4.6', 'grok-4.5'],
  };
  const catalog = await discoverGrokAccountCatalog({ selection, now: () => 1001, readObservation: async () => observation });
  assert.equal(catalog.status, 'unauthenticated');
  assert.deepEqual(catalog.models, []);
  assert.deepEqual(catalog.cachedCandidates, ['grok-4.6', 'grok-4.5']);
  assert.equal(selectGrokAccountModel(catalog, { model: 'grok-build' }).status, 'unauthenticated');

  const result = await discoverModels({ includeOllama: false, grokCatalog: {
    selection, now: () => 1001, readObservation: async () => observation,
  } });
  for (const entry of result.models.filter(model => model.bridge === 'grok-cli.js')) {
    assert.equal(entry.available, null);
    assert.equal(entry.status, 'unauthenticated');
    assert.equal(entry.source, 'official-grok-build-cli');
  }
});

test('selected Grok profile catalog resolves only advertised registry candidates', async () => {
  const selection = { profileId: 'grok-a', profileHomeSha256: 'c'.repeat(64) };
  const observation = {
    source: 'official-grok-build-cli', status: 'catalog-reported', authenticated: true,
    profileId: selection.profileId, profileHomeSha256: selection.profileHomeSha256,
    profileBindingMatched: true, accountIdentityVerified: false, observedAt: 2000,
    complete: true, models: ['grok-4.7', 'grok-4.7-build-fast', 'grok-4.6', 'grok-4.5'], cachedCandidates: [],
  };
  const catalog = await discoverGrokAccountCatalog({ selection, now: () => 2001, readObservation: async () => observation });
  assert.equal(catalog.status, 'host-reported');
  assert.equal(selectGrokAccountModel(catalog, { model: 'grok-build' }).status, 'advertised-unverified');
  assert.equal(selectGrokAccountModel(catalog, { model: 'grok-build-fast' }).model, 'grok-4.7-build-fast');
  assert.equal(selectGrokAccountModel(catalog, { model: 'grok-build-4.6' }).status, 'advertised-unverified');
  assert.equal(selectGrokAccountModel(catalog, { model: 'grok-composer-2.5-fast' }).status, 'model-not-advertised');
  assert.equal(selectGrokAccountModel(structuredClone(catalog), { model: 'grok-build' }).status, 'catalog-unavailable');
});

test('Grok catalog cannot be combined with ambient provider probes', async () => {
  await assert.rejects(discoverModels({ probe: true, grokCatalog: {}, includeOllama: false }), /cannot be combined/);
});
