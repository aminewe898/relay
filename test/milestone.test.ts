import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { N8nClient } from '../src/n8n/client.js';
import { createServer } from '../src/server.js';
import { WorkflowService } from '../src/tools/service.js';
import { config, payload, workflow, mockFetch, json } from './helpers.js';

test('MCP milestone: list/get/validate/dry-run create over transport', async () => {
  const calls: string[] = [];
  const api = new N8nClient(config, mockFetch((url, init) => {
    calls.push(`${init.method} ${url.pathname}`);
    assert.equal(new Headers(init.headers).get('X-N8N-API-KEY'), config.apiKey);
    return json(url.pathname.endsWith('/wf-1') ? workflow() : { data: [workflow()], nextCursor: 'next-page' });
  }));
  const server = createServer(config, api, false);
  const client = new Client({ name: 'milestone-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  try {
    const catalog = await client.listTools(); assert.equal(catalog.tools.length, 8);
    assert.equal(catalog.tools.find(t => t.name === 'list_workflows')?.annotations?.readOnlyHint, true);
    assert.equal(catalog.tools.find(t => t.name === 'create_workflow')?.annotations?.readOnlyHint, false);
    for (const [name, args] of [['list_workflows', {}], ['get_workflow', { workflowId: 'wf-1' }], ['validate_workflow', { workflow: payload() }], ['create_workflow', { workflow: payload() }]] as const) {
      const result = await client.callTool({ name, arguments: args });
      assert.notEqual(result.isError, true);
      if (name === 'create_workflow') assert.match(JSON.stringify(result), /dryRun/);
    }
    assert.deepEqual(calls, ['GET /api/v1/workflows', 'GET /api/v1/workflows/wf-1']);
  } finally { await client.close(); await server.close(); }
});
test('invalid dry-run creation makes no requests', async () => {
  const api = new N8nClient(config, mockFetch(() => { throw new Error('Unexpected request'); }));
  const result = await new WorkflowService(api, config, false).create({});
  assert.equal('rejected' in result && result.rejected, true);
});
test('pagination preserves opaque cursor and concise records', async () => {
  const api = new N8nClient(config, mockFetch(url => {
    assert.equal(url.searchParams.get('cursor'), 'opaque+/=');
    return json({ data: [workflow()], nextCursor: null });
  }));
  const page = await api.listWorkflows({ cursor: 'opaque+/=', limit: 2 });
  assert.deepEqual(page.data, [{ id: 'wf-1', name: 'Support intake', active: false }]);
});
