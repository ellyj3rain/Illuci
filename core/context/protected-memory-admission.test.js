import test from 'node:test';
import assert from 'node:assert/strict';
import { createProtectedMemoryAdmission, memoryValueDigest } from './protected-memory-admission.js';

function fixture() {
  const reader = { contextId: 'principal-context', agentId: 'illuci', runId: 'run-1', sessionId: 'session-1',
    projectId: 'example-project', assignmentId: 'binding', purpose: 'principal-management', lineage: ['run-1'] };
  const value = { content: 'Private principal correction history', summary: 'Private summary' };
  const item = { id: 'feedback', value, digest: memoryValueDigest(value), custody: {
    classification: 'protected', sourceRef: 'observations:source-1', ownerAgentId: 'illuci', ownerContextId: 'principal-context',
    projectId: 'example-project', assignmentId: 'binding', permittedPurposes: ['principal-management', 'execution-briefing'],
  } };
  const briefing = { ...structuredClone(item), id: 'briefing', value: { content: 'Implement the binding' } };
  briefing.digest = memoryValueDigest(briefing.value);
  briefing.custody.classification = 'work';
  const state = { reader, items: { feedback: item, briefing }, grant: null, time: 1000, calls: 0 };
  const control = createProtectedMemoryAdmission({
    resolveReader: ref => ref === 'host-context' ? state.reader : null,
    resolveItem: ref => state.items[ref],
    resolveAuthorization: () => { state.calls++; return state.grant; },
    now: () => state.time,
  });
  const port = control.openContext('host-context');
  const grant = (kind = 'custody') => ({
    kind, evidenceRef: 'observations:auth-evidence', authorizationId: 'authorization-1', status: 'active',
    validFrom: 0, validUntil: null, itemId: item.id, digest: item.digest,
    ...Object.fromEntries(['sourceRef', 'ownerAgentId', 'ownerContextId', 'projectId', 'assignmentId'].map(k => [k, item.custody[k]])),
    recipient: structuredClone(state.reader),
  });
  return { state, control, port, grant };
}

async function denied(f) {
  const result = await f.port.select(['feedback', 'briefing']);
  assert.deepEqual(result.admitted.map(i => i.id), ['briefing']);
  assert.equal(result.excluded.length, 1);
  assert.equal(JSON.stringify(result.excluded).includes('Private'), false);
}

test('same identity/assignment/role and fake trusted or tool capability fields do not authorize', async () => {
  const f = fixture();
  Object.assign(f.state.reader, { role: 'principal', trusted: true, allowedTools: ['memory.read'], permissions: ['admin'] });
  await denied(f);
});

test('host-confirmed exact custody permits original and summary; source is not mutated', async () => {
  const f = fixture(); f.state.grant = f.grant();
  const before = structuredClone(f.state.items);
  const result = await f.port.select(['feedback']);
  assert.equal(result.admitted[0].value.content, 'Private principal correction history');
  result.admitted[0].value.content = 'changed';
  assert.deepEqual(f.state.items, before);
});

for (const change of [
  { purpose: 'execution-briefing', role: 'coder' },
  { runId: 'child', lineage: ['run-1', 'child'], role: 'principal', inheritedPersona: 'illuci' },
  { sessionId: 'unrelated-session', contextId: 'new-context', runId: 'new-run', lineage: ['new-run'] },
  { agentId: 'another-worker', role: 'principal' },
]) {
  test(`retained grant cannot follow unverified reader change ${JSON.stringify(change)}`, async () => {
    const f = fixture(); f.state.grant = f.grant(); Object.assign(f.state.reader, change); await denied(f);
  });
}

test('verified cross-session continuation reuses retained authorization without fresh approval or TTL', async () => {
  const f = fixture();
  Object.assign(f.state.reader, { contextId: 'continued', sessionId: 'next-session', runId: 'run-2', lineage: ['run-2'] });
  f.state.grant = { ...f.grant('continuation'), originContextId: 'principal-context',
    continuityEvidenceRef: 'observations:continuity', retainedAuthorizationRef: 'observations:retained-authorization' };
  f.state.time = 1000 * 60 * 60 * 24 * 365 * 20;
  assert.equal((await f.port.select(['feedback'])).admitted.length, 1);
  delete f.state.grant.continuityEvidenceRef;
  await denied(f);
});

test('explicit disclosure is material-, recipient-, purpose- and scope-bound', async () => {
  const f = fixture();
  Object.assign(f.state.reader, { contextId: 'worker-context', agentId: 'worker', runId: 'child',
    lineage: ['run-1', 'child'], purpose: 'execution-briefing' });
  f.state.grant = f.grant('disclosure');
  assert.equal((await f.port.select(['feedback'])).admitted.length, 1);
  f.state.grant.itemId = 'other-material'; await denied(f);
});

for (const [key, value] of [
  ['status', 'revoked'], ['status', 'pending'], ['validFrom', 1001], ['validUntil', 1000],
  ['validUntil', undefined], ['validFrom', NaN], ['sourceRef', 'other-source'],
  ['ownerContextId', 'other-owner'], ['assignmentId', 'other-assignment'], ['projectId', 'other-project'],
  ['digest', 'stale-version'], ['evidenceRef', ''], ['kind', 'role-inheritance'],
]) {
  test(`reject invalid authorization ${key}=${value}`, async () => {
    const f = fixture(); f.state.grant = { ...f.grant(), [key]: value }; await denied(f);
  });
}

test('re-resolves revocation on later calls; no cached successful admission', async () => {
  const f = fixture(); f.state.grant = f.grant();
  assert.equal((await f.port.select(['feedback'])).admitted.length, 1);
  f.state.grant.status = 'revoked'; await denied(f); assert.equal(f.state.calls, 2);
});

for (const mutate of [
  item => { delete item.custody; },
  item => { delete item.custody.sourceRef; },
  item => { item.custody.classification = 'unclassified'; },
  item => { item.value.summary = 'replacement bytes'; },
  item => { item.custody.permittedPurposes = ['unrelated-purpose']; },
]) {
  test(`malformed or changed item excluded, work briefing continues: ${mutate}`, async () => {
    const f = fixture(); f.state.grant = f.grant(); mutate(f.state.items.feedback); await denied(f);
  });
}

test('project/assignment mismatch blocks even work material rather than crossing scope', async () => {
  const f = fixture(); f.state.reader.assignmentId = 'unrelated';
  const result = await f.port.select(['feedback', 'briefing']); assert.equal(result.admitted.length, 0);
  assert.ok(result.excluded.every(e => e.reason === 'outside-selected-scope'));
});

test('selection cannot inject reader, custody, grant, content or host context', async () => {
  const f = fixture(); f.state.grant = f.grant();
  await assert.rejects(f.port.select([{ itemRef: 'feedback', trusted: true, reader: f.state.reader }]), TypeError);
  assert.equal((await f.control.openContext('made-up-context').select(['feedback'])).admitted.length, 0);
  assert.equal(f.port.openContext, undefined);
  assert.equal(f.port.grant, undefined);
});

test('host lookup failure excludes only affected item without error detail leakage', async () => {
  const f = fixture();
  const control = createProtectedMemoryAdmission({ resolveReader: () => f.state.reader,
    resolveItem: ref => { if (ref === 'feedback') throw Error('Private secret'); return f.state.items[ref]; },
    resolveAuthorization: () => null });
  const result = await control.openContext('host-context').select(['feedback', 'briefing']);
  assert.deepEqual(result.admitted.map(i => i.id), ['briefing']);
  assert.deepEqual(result.excluded, [{ itemRef: 'feedback', reason: 'host-resolution-failed' }]);
});

test('bounded input, duplicates deduplicated, no host resolver defaults', async () => {
  const f = fixture(); await assert.rejects(f.port.select(Array(257).fill('briefing')), TypeError);
  assert.equal((await f.port.select(['briefing', 'briefing'])).admitted.length, 1);
  assert.throws(() => createProtectedMemoryAdmission(), TypeError);
});

for (const phase of ['item', 'authorization']) {
  test(`reader binding drift during awaited ${phase} resolution excludes pending payload`, async () => {
    const f = fixture();
    f.state.grant = f.grant();
    const drift = async () => {
      await Promise.resolve();
      f.state.reader = { ...f.state.reader, runId: 'child', lineage: ['run-1', 'child'] };
    };
    const control = createProtectedMemoryAdmission({
      resolveReader: () => f.state.reader,
      resolveItem: async ref => { if (phase === 'item') await drift(); return f.state.items[ref]; },
      resolveAuthorization: async () => { if (phase === 'authorization') await drift(); return f.state.grant; },
      now: () => 1000,
    });
    const result = await control.openContext('host-context').select(['feedback']);
    assert.equal(result.admitted.length, 0);
    assert.deepEqual(result.excluded, [{ itemRef: 'feedback', reason: 'reader-binding-changed' }]);
  });
}

test('authoritative lookup must return the exact requested item ID, not an implicit alias', async () => {
  const f = fixture(); f.state.grant = f.grant(); f.state.items.feedback.id = 'other';
  f.state.grant.itemId = 'other';
  await denied(f);
});

test('final reader lookup failure excludes previously eligible material', async () => {
  const f = fixture(); let calls = 0;
  const control = createProtectedMemoryAdmission({
    resolveReader: () => { if (++calls > 1) throw Error('private host detail'); return f.state.reader; },
    resolveItem: () => f.state.items.briefing, resolveAuthorization: () => null,
  });
  const result = await control.openContext('host-context').select(['briefing']);
  assert.deepEqual(result, { admitted: [], excluded: [{ itemRef: 'briefing', reason: 'reader-binding-changed' }] });
});

test('authorization expiry during final reader lookup excludes pending payload', async () => {
  const f = fixture(); f.state.grant = { ...f.grant(), validUntil: 1100 }; let calls = 0;
  const control = createProtectedMemoryAdmission({
    resolveReader: () => { if (++calls > 1) f.state.time = 1100; return f.state.reader; },
    resolveItem: () => f.state.items.feedback, resolveAuthorization: () => f.state.grant, now: () => f.state.time,
  });
  const result = await control.openContext('host-context').select(['feedback']);
  assert.deepEqual(result, { admitted: [], excluded: [{ itemRef: 'feedback', reason: 'missing-or-invalid-authorization' }] });
});

test('later work-item resolution cannot retain a protected item that has expired', async () => {
  const f = fixture(); f.state.grant = { ...f.grant(), validUntil: 1100 };
  const control = createProtectedMemoryAdmission({
    resolveReader: () => f.state.reader,
    resolveItem: async ref => {
      if (ref === 'briefing') { await Promise.resolve(); f.state.time = 1100; }
      return f.state.items[ref];
    },
    resolveAuthorization: () => f.state.grant, now: () => f.state.time,
  });
  const result = await control.openContext('host-context').select(['feedback', 'briefing']);
  assert.deepEqual(result.admitted.map(i => i.id), ['briefing']);
  assert.deepEqual(result.excluded, [{ itemRef: 'feedback', reason: 'missing-or-invalid-authorization' }]);
});
