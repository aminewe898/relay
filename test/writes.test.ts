import { test } from 'node:test';
import assert from 'node:assert/strict';
import { N8nClient, N8nApiError } from '../src/n8n/client.js';
import { WorkflowService } from '../src/tools/service.js';
import { config, payload, workflow, mockFetch, json } from './helpers.js';

test('dry-run update reads only and returns before/after', async () => {
  const calls: string[] = [];
  const api = new N8nClient(config, mockFetch((_url, init) => { calls.push(init.method!); return json(workflow()); }));
  const result = await new WorkflowService(api, config).update('wf-1', { ...payload(), name: 'Revised' });
  assert.ok('dryRun' in result && result.dryRun);
  assert.deepEqual(calls, ['GET']);
  assert.equal('changeSummary' in result && result.changeSummary.before?.name, 'Support intake');
});
test('reject activation, wrong target ID, active workflows, stale versions', async () => {
  const calls: string[] = [];
  let existing = workflow();
  const api = new N8nClient(config, mockFetch((_url, init) => { calls.push(init.method!); return json(existing); }));
  const service = new WorkflowService(api, config);
  assert.ok('rejected' in await service.create({ ...payload(), active: true }));
  assert.ok('rejected' in await service.update('wf-1', { ...payload(), active: true }));
  await assert.rejects(service.update('wf-1', { ...payload(), id: 'other' }), /does not match/);
  await assert.rejects(service.update('wf-1', payload(), 'old-version'), /version changed/);
  existing = { ...workflow(), active: true };
  await assert.rejects(service.update('wf-1', payload()), /active workflows/);
  assert.ok(calls.every(method => method === 'GET'));
});
test('client rejects mismatched read identity and path traversal before writes', async () => {
  const api = new N8nClient(config, mockFetch(() => json({ ...workflow(), id: 'other' })));
  await assert.rejects(api.getWorkflow('wf-1'), /different workflow ID/);
  await assert.rejects(api.getWorkflow('../other'));
});
test('real creation sends allowlisted payload then verifies inactive read-back', async () => {
  const realConfig = { ...config, dryRun: false }; const calls: string[] = [];
  const api = new N8nClient(realConfig, mockFetch((url, init) => {
    calls.push(`${init.method} ${url.pathname}`);
    if (init.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      assert.deepEqual(body, payload()); assert.equal('active' in body, false);
      assert.equal(init.redirect, 'error');
    }
    return json(workflow());
  }));
  const result = await new WorkflowService(api, realConfig).create({ ...payload(), active: false, tags: [], meta: { anything: true } });
  assert.ok('verified' in result && result.verified);
  assert.deepEqual(calls, ['POST /api/v1/workflows', 'GET /api/v1/workflows/wf-1']);
});
test('real update only writes exact requested ID and verifies full payload', async () => {
  const realConfig = { ...config, dryRun: false }; const calls: string[] = []; let saved = workflow();
  const api = new N8nClient(realConfig, mockFetch((url, init) => {
    assert.equal(url.pathname, '/api/v1/workflows/wf-1'); calls.push(init.method!);
    if (init.method === 'PUT') {
      assert.equal(url.searchParams.get('publishIfActive'), 'false');
      saved = { ...saved, ...JSON.parse(String(init.body)) as ReturnType<typeof payload>, versionId: 'v2' };
    }
    return json(saved);
  }));
  const result = await new WorkflowService(api, realConfig).update('wf-1', { ...payload(), name: 'Revised', id: 'wf-1', active: false }, 'v1');
  assert.ok('verified' in result && result.verified);
  assert.deepEqual(calls, ['GET', 'GET', 'PUT', 'GET']);
});
test('changed state during preparation aborts before PUT', async () => {
  const realConfig = { ...config, dryRun: false }; let reads = 0;
  const api = new N8nClient(realConfig, mockFetch((_url, init) => {
    assert.equal(init.method, 'GET'); reads++;
    return json({ ...workflow(), active: reads > 1 });
  }));
  await assert.rejects(new WorkflowService(api, realConfig).update('wf-1', payload()), /changed during preparation/);
});
test('read-back mismatch, failure, or unexpected active state reports possible mutation', async () => {
  for (const reply of [json({ ...workflow(), name: 'Unexpected' }), json({ ...workflow(), active: true }), json({}, 500)]) {
    const realConfig = { ...config, dryRun: false };
    const api = new N8nClient(realConfig, mockFetch((_url, init) => init.method === 'POST' ? json(workflow()) : reply));
    await assert.rejects(new WorkflowService(api, realConfig).create(payload()), (error: unknown) => error instanceof N8nApiError && error.mutationMayHaveOccurred);
  }
});
test('client dry-run enforcement blocks direct mutations', async () => {
  const api = new N8nClient(config, mockFetch(() => { throw new Error('Must not request'); }));
  await assert.rejects(api.createWorkflow(payload()), /Writes are disabled/);
  await assert.rejects(api.updateWorkflow('wf-1', payload()), /Writes are disabled/);
});
test('concurrent updates to same workflow are rejected', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const api = new N8nClient(config, mockFetch(async () => { await gate; return json(workflow()); }));
  const service = new WorkflowService(api, config);
  const first = service.update('wf-1', payload());
  await assert.rejects(service.update('wf-1', payload()), /already in progress/);
  release(); await first;
});
