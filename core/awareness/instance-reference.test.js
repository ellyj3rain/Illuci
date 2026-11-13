import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as store from './store.js';

const assignment = { projectId:'project', workId:'work', revision:'r1', workspaceId:'workspace' };
const claim = { sourceRef:'source-1', sourceSha256:'a'.repeat(64), senderAgentId:'agent-a', senderExecutionId:'exec-a',
  senderAttemptId:'attempt-a', recipientAgentId:'agent-b', recipientExecutionId:'exec-b' };
const selected = { company:'scope', assignment, recipientAgentId:'agent-b', recipientExecutionId:'exec-b', budget:{maxEvents:4} };
const put = (route=claim) => store.publishInstanceReference({ company:'scope', topologyId:'other', assignment, instanceRoute:route });
beforeEach(() => store.reset());

test('instance discovery keeps exact untrusted reference claims out of legacy payload paths', () => {
  const supplied = structuredClone(claim), event = put(supplied); supplied.senderAgentId = 'changed';
  assert.equal(event.instanceRoute.senderAgentId, 'agent-a');
  assert.equal(event.summary, ''); assert.equal(Object.isFrozen(event.instanceRoute), true);
  assert.deepEqual(store.recall(selected), []);
  assert.deepEqual(store.recallReferences(selected), []);
  assert.equal(store.recallBlock(selected), null);
  assert.deepEqual(store.recallInstanceReferences(selected), [claim]);
  assert.equal(store.publish({ company:'scope', summary:'private payload', instanceRoute:claim }), null);
});

test('recipient execution, selected work and sender identities remain distinct even for same-model instances', () => {
  put(); put({...claim, sourceRef:'source-2', senderAgentId:'agent-c', senderExecutionId:'exec-c', senderAttemptId:'attempt-c'});
  assert.deepEqual(store.recallInstanceReferences(selected).map(x => x.senderAgentId).sort(), ['agent-a','agent-c']);
  assert.deepEqual(store.recallInstanceReferences({...selected, recipientAgentId:'agent-a'}), []);
  assert.deepEqual(store.recallInstanceReferences({...selected, recipientExecutionId:'exec-other'}), []);
  assert.deepEqual(store.recallInstanceReferences({...selected, assignment:{...assignment, revision:'r2'}}), []);
});

test('conflicting claims for one source fail closed and malformed claims cannot enter', () => {
  put(); put({...claim, senderAgentId:'spoof'});
  assert.deepEqual(store.recallInstanceReferences(selected), []);
  assert.equal(put({...claim, sourceSha256:'not-a-hash'}), null);
  assert.equal(put({...claim, extra:'payload'}), null);
  assert.equal(store.publishInstanceReference({company:'scope',assignment,instanceRoute:claim,summary:'private'}), null);
  assert.deepEqual(store.recallInstanceReferences({...selected, recipientExecutionId:''}), []);
});

