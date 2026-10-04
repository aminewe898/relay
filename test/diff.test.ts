import { test } from 'node:test';
import assert from 'node:assert/strict';
import { N8nClient } from '../src/n8n/client.js';
import { WorkflowService } from '../src/tools/service.js';
import { workflowChanges } from '../src/tools/workflow-diff.js';
import { config, payload, workflow, json, mockFetch } from './helpers.js';

test('workflow_diff with no changes reads only and returns empty changes', async () => {
  const calls: string[] = [];
  const api = new N8nClient(config, mockFetch((_url, init) => { calls.push(init.method!); return json(workflow()); }));
  const result = await new WorkflowService(api, config).diff('wf-1', payload());
  assert.equal(result.valid, true); assert.deepEqual(calls, ['GET']);
  assert.ok(Object.values(result.changes!).every(value => Array.isArray(value) && !value.length));
});
test('workflow_diff detects node addition and removal', () => {
  const after = payload(); after.nodes.push({ ...after.nodes[0]!, id: 'second', name: 'Second' });
  assert.deepEqual(workflowChanges(payload(), after).nodesAdded, ['Second']);
  assert.deepEqual(workflowChanges(after, payload()).nodesRemoved, ['Second']);
});
test('workflow_diff node modification reports fields without dumping secret values', () => {
  const after = payload(); after.nodes[0]!.parameters = { apiKey: 'FAKE_API_KEY_DO_NOT_LEAK' };
  const changes = workflowChanges(payload(), after);
  assert.deepEqual(changes.nodesModified, [{ name: 'Start', fields: ['parameters'] }]);
  assert.ok(!JSON.stringify(changes).includes('FAKE_API_KEY_DO_NOT_LEAK'));
});
test('workflow_diff connection modifications retain channel and port meaning', () => {
  const before = payload(); before.connections = { Start: { main: [[{ node: 'Start', type: 'main', index: 0 }]] } };
  const after = structuredClone(before); after.connections.Start!.main = [[], [{ node: 'Start', type: 'main', index: 1 }]];
  const changes = workflowChanges(before, after);
  assert.equal(changes.connectionsAdded[0]?.outputIndex, 1); assert.equal(changes.connectionsAdded[0]?.inputIndex, 1);
  assert.equal(changes.connectionsRemoved[0]?.outputIndex, 0);
});
test('workflow_diff ignores object key ordering, node order and connection order', () => {
  const before = payload(); before.nodes.push({ ...before.nodes[0]!, name: 'Second', id: 'second' });
  before.nodes[0]!.parameters = { a: 1, b: 2 };
  before.connections = { Start: { main: [[{ node: 'Start', type: 'main', index: 0 }, { node: 'Second', type: 'main', index: 0 }]] } };
  const after = structuredClone(before); after.nodes[0]!.parameters = { b: 2, a: 1 }; after.nodes.reverse(); after.connections.Start!.main![0]!.reverse();
  assert.ok(Object.values(workflowChanges(before, after)).every(value => !value.length));
});
test('stable node ID makes rename one modification; replaced IDs count as removal/addition', () => {
  const after = payload(); after.nodes[0]!.name = 'Renamed';
  assert.equal(workflowChanges(payload(), after).nodesModified.length, 1);
  after.nodes[0]!.id = 'replacement';
  assert.equal(workflowChanges(payload(), after).nodesRemoved.length, 1);
});
test('settings and optional data removal are visible without values', () => {
  const before = { ...payload(), pinData: { private: 'FAKE_PASSWORD_DO_NOT_LEAK' } }; const after = payload(); after.settings.timezone = 'Europe/Madrid';
  const changes = workflowChanges(before, after);
  assert.deepEqual(changes.settingsChanged, ['timezone']); assert.deepEqual(changes.otherChangedFields, ['pinData']);
  assert.ok(!JSON.stringify(changes).includes('FAKE_PASSWORD_DO_NOT_LEAK'));
});
test('invalid proposal and wrong workflow ID never write or produce misleading changes', async () => {
  const api = new N8nClient(config, mockFetch((_url, init) => { assert.equal(init.method, 'GET'); return json(workflow()); }));
  const service = new WorkflowService(api, config);
  for (const proposal of [{}, { ...payload(), id: 'other' }, { ...payload(), active: true }]) {
    const result = await service.diff('wf-1', proposal); assert.equal(result.valid, false); assert.equal(result.changes, undefined);
  }
});
