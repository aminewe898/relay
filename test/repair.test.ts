import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { N8nClient } from '../src/n8n/client.js';
import { WorkflowService } from '../src/tools/service.js';
import { createServer } from '../src/server.js';
import { config, payload, workflow, json, mockFetch } from './helpers.js';

function twoNodes() { const existing = workflow(); existing.nodes.push({ ...existing.nodes[0]!, id: 'second', name: 'Second' }); return existing; }
test('node removal is rejected by default in dry-run and real-write modes', async () => {
  for (const dryRun of [true, false]) {
    const settings = { ...config, dryRun }; const calls: string[] = [];
    const service = new WorkflowService(new N8nClient(settings, mockFetch((_url, init) => { calls.push(init.method!); return json(twoNodes()); })), settings);
    await assert.rejects(service.update('wf-1', payload()), /allowNodeRemoval/);
    await assert.rejects(service.update('wf-1', payload(), undefined, { allowNodeRemoval: false }), /allowNodeRemoval/);
    assert.deepEqual(calls, ['GET', 'GET']);
  }
});
test('ambiguous existing node IDs cannot bypass removal protection', async () => {
  const current = twoNodes(); current.nodes[1]!.id = current.nodes[0]!.id!;
  const service = new WorkflowService(new N8nClient(config, mockFetch((_url, init) => { assert.equal(init.method, 'GET'); return json(current); })), config);
  await assert.rejects(service.update('wf-1', payload()), /ambiguous node identities/);
});
test('explicit node removal allows a dry-run preview with destructive warning', async () => {
  const service = new WorkflowService(new N8nClient(config, mockFetch((_url, init) => { assert.equal(init.method, 'GET'); return json(twoNodes()); })), config);
  const result = await service.update('wf-1', payload(), 'v1', { allowNodeRemoval: true });
  assert.ok('changes' in result); assert.deepEqual(result.changes.nodesRemoved, ['Second']);
  assert.equal(result.updated, false); assert.ok(result.warnings.some(w => /Destructive/.test(w)));
});
test('allowed node removal writes only to mock then verifies the full replacement', async () => {
  const settings = { ...config, dryRun: false }; let saved = twoNodes(); const calls: string[] = [];
  const api = new N8nClient(settings, mockFetch((url, init) => {
    calls.push(init.method!); assert.equal(url.pathname, '/api/v1/workflows/wf-1');
    if (init.method === 'PUT') saved = { ...workflow(), ...JSON.parse(String(init.body)), versionId: 'v2' };
    return json(saved);
  }));
  const result = await new WorkflowService(api, settings).update('wf-1', payload(), 'v1', { allowNodeRemoval: true, maxChangedNodes: 1 });
  assert.ok('updated' in result && result.updated); assert.deepEqual(calls, ['GET', 'GET', 'PUT', 'GET']);
  assert.ok('versionInformation' in result); assert.deepEqual(result.versionInformation, { before: 'v1', expected: 'v1', after: 'v2', atomic: false });
});
test('maxChangedNodes accepts exact bound and zero-change updates', async () => {
  const service = new WorkflowService(new N8nClient(config, mockFetch(() => json(workflow()))), config);
  const after = payload(); after.nodes[0]!.parameters = { message: 'Repaired' };
  assert.ok('changes' in await service.update('wf-1', after, 'v1', { maxChangedNodes: 1 }));
  assert.ok('changes' in await service.update('wf-1', payload(), 'v1', { maxChangedNodes: 0 }));
});
test('maxChangedNodes rejects added+removed+modified nodes before writing', async () => {
  const settings = { ...config, dryRun: false }; const calls: string[] = [];
  const service = new WorkflowService(new N8nClient(settings, mockFetch((_url, init) => { calls.push(init.method!); return json(twoNodes()); })), settings);
  const after = payload(); after.nodes[0]!.parameters = { value: 'fixed' }; after.nodes.push({ ...after.nodes[0]!, id: 'third', name: 'Third' });
  await assert.rejects(service.update('wf-1', after, 'v1', { allowNodeRemoval: true, maxChangedNodes: 2 }), /exceeds maxChangedNodes/);
  assert.deepEqual(calls, ['GET']);
});
test('stable ID rename fits one-node limit while an ID replacement requires removal approval', async () => {
  const service = new WorkflowService(new N8nClient(config, mockFetch(() => json(workflow()))), config);
  const after = payload(); after.nodes[0]!.name = 'Renamed';
  const result = await service.update('wf-1', after, 'v1', { maxChangedNodes: 1 });
  assert.ok('changes' in result && result.changes.nodesModified.length === 1);
  after.nodes[0]!.id = 'new-id'; await assert.rejects(service.update('wf-1', after), /allowNodeRemoval/);
});
test('invalid change limits cannot bypass service guards', async () => {
  const service = new WorkflowService(new N8nClient(config, mockFetch(() => { throw new Error('Must not read'); })), config);
  for (const maxChangedNodes of [-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) await assert.rejects(service.update('wf-1', payload(), undefined, { maxChangedNodes }), /nonnegative safe integer/);
});
test('V2 protections retain stale-version, active, activation, ID and placeholder guards', async () => {
  let current = workflow(); const calls: string[] = [];
  const settings = { ...config, dryRun: false };
  const service = new WorkflowService(new N8nClient(settings, mockFetch((_url, init) => { calls.push(init.method!); return json(current); })), settings);
  await assert.rejects(service.update('wf-1', payload(), 'stale'), /version changed/);
  current.active = true; await assert.rejects(service.update('wf-1', payload()), /active workflows/); current.active = false;
  for (const proposal of [{ ...payload(), active: true }, { ...payload(), staticData: { password: '[REDACTED]' } }, { ...payload(), nodes: [{ ...payload().nodes[0]!, credentials: { api: { id: '[REDACTED]' } } }] }]) assert.ok('rejected' in await service.update('wf-1', proposal));
  await assert.rejects(service.update('wf-1', { ...payload(), id: 'other' }), /does not match/);
  assert.ok(calls.every(method => method === 'GET'));
});
test('missing versionId omits fabricated version fields and reports the limitation', async () => {
  const current = workflow(); delete current.versionId;
  const result = await new WorkflowService(new N8nClient(config, mockFetch(() => json(current))), config).update('wf-1', payload());
  assert.ok('versionInformation' in result); assert.deepEqual(result.versionInformation, { atomic: false });
  assert.ok(result.warnings.some(w => /versionId is unavailable/.test(w)));
});
test('V2 stale check detects parameter changes before PUT', async () => {
  let reads = 0; const settings = { ...config, dryRun: false };
  const service = new WorkflowService(new N8nClient(settings, mockFetch((_url, init) => {
    assert.equal(init.method, 'GET'); const current = workflow(); if (++reads > 1) current.nodes[0]!.parameters = { changed: true }; return json(current);
  })), settings);
  await assert.rejects(service.update('wf-1', payload(), 'v1', { maxChangedNodes: 1 }), /changed during preparation/);
});
test('MCP V2 catalogs only controlled tools and enforces alias/removal/limit inputs', async () => {
  const api = new N8nClient(config, mockFetch((_url, init) => { assert.equal(init.method, 'GET'); return json(twoNodes()); }));
  const server = createServer(config, api, false); const client = new Client({ name: 'repair-v2', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
  try {
    const catalog = (await client.listTools()).tools;
    assert.deepEqual(catalog.map(tool => tool.name).sort(), ['list_workflows', 'get_workflow', 'validate_workflow', 'create_workflow', 'update_workflow', 'get_execution', 'diagnose_execution', 'workflow_diff'].sort());
    for (const name of ['diagnose_execution', 'workflow_diff']) assert.equal(catalog.find(tool => tool.name === name)?.annotations?.readOnlyHint, true);
    for (const args of [{ workflowId: 'wf-1', workflow: payload() }, { workflowId: 'wf-1', proposedWorkflow: payload(), allowNodeRemoval: true, maxChangedNodes: 0 }, { workflowId: 'wf-1', workflow: payload(), proposedWorkflow: payload() }, { workflowId: 'wf-1', workflow: payload(), allowNodeRemoval: 'true' }, { workflowId: 'wf-1', workflow: payload(), maxChangedNodes: -1 }]) {
      assert.equal((await client.callTool({ name: 'update_workflow', arguments: args })).isError, true);
    }
    const preview = await client.callTool({ name: 'update_workflow', arguments: { workflowId: 'wf-1', proposedWorkflow: payload(), allowNodeRemoval: true, maxChangedNodes: 1 } });
    assert.notEqual(preview.isError, true); assert.match(JSON.stringify(preview), /dryRun/);
    const diff = await client.callTool({ name: 'workflow_diff', arguments: { workflowId: 'wf-1', proposedWorkflow: payload() } });
    assert.notEqual(diff.isError, true); assert.match(JSON.stringify(diff), /nodesRemoved/);
  } finally { await client.close(); await server.close(); }
});
