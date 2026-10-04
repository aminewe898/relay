import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { N8nClient } from '../src/n8n/client.js';
import { createServer } from '../src/server.js';
import { WorkflowService } from '../src/tools/service.js';
import { diagnoseExecution } from '../src/diagnostics/execution.js';
import { DiagnosticSanitizer } from '../src/diagnostics/sanitizer.js';
import { config, json, mockFetch } from './helpers.js';
import { executionFixture, fixtureSecrets } from './fixtures/executions.js';

test('failed execution diagnosis retains safe technical evidence only', async () => {
  const api = new N8nClient(config, mockFetch((url, init) => {
    assert.equal(init.method, 'GET'); assert.equal(url.pathname, '/api/v1/executions/123');
    assert.equal(url.search, '?includeData=true'); return json(executionFixture());
  }));
  const result = await new WorkflowService(api, config).diagnose('123');
  assert.equal(result.executionId, '123'); assert.equal(result.workflowId, 'wf-1');
  assert.equal(result.status, 'error'); assert.equal(result.startedAt, executionFixture().startedAt);
  assert.deepEqual(result.failedNode, { name: 'HTTP Request', type: 'n8n-nodes-base.httpRequest' });
  assert.equal(result.error?.category, 'api'); assert.equal(result.error?.httpStatusCode, 401);
  assert.equal(result.error?.message, 'Authorization failed - please check your credentials');
  assert.equal(result.error?.description, undefined);
  assert.equal(result.nodeStatuses[1]?.executionTime, 12);
  for (const secret of fixtureSecrets) assert.ok(!JSON.stringify(result).includes(secret));
});
test('successful diagnosis never treats lastNodeExecuted as failure', () => {
  const result = diagnoseExecution({ id: '123', workflowId: 'wf-1', status: 'success', stoppedAt: null, data: { resultData: { lastNodeExecuted: 'Start', runData: { Start: [{ executionStatus: 'success', executionTime: 0 }] } } } }, '123', config.apiKey);
  assert.equal(result.failedNode, undefined); assert.equal(result.error, undefined);
  assert.equal(result.stoppedAt, null); assert.equal(result.nodeStatuses[0]?.status, 'success');
});
test('failed node falls back to unique run error and snapshot type', () => {
  const result = diagnoseExecution({ id: '123', workflowId: 'wf-1', status: 'error', data: { resultData: { runData: { Start: [{ error: { name: 'ExpressionError', message: 'Invalid expression' } }] } } }, workflowData: { nodes: [{ name: 'Start', type: 'n8n-nodes-base.set' }] } }, '123', config.apiKey);
  assert.deepEqual(result.failedNode, { name: 'Start', type: 'n8n-nodes-base.set' });
  assert.equal(result.error?.category, 'expression'); assert.equal(result.nodeStatuses[0]?.status, undefined);
});
test('ambiguous failures do not fabricate a failed node', () => {
  const result = diagnoseExecution({ id: '123', workflowId: 'wf-1', status: 'error', data: { resultData: { lastNodeExecuted: 'Other', runData: { A: [{ executionStatus: 'error' }], B: [{ executionStatus: 'error' }] } } } }, '123', '');
  assert.equal(result.failedNode, undefined);
});
test('lastNodeExecuted disambiguates only when it has error evidence', () => {
  const result = diagnoseExecution({ id: '123', workflowId: 'wf-1', status: 'error', data: { resultData: { lastNodeExecuted: 'B', runData: { A: [{ error: {} }], B: [{ error: {} }] } } } }, '123', '');
  assert.equal(result.failedNode?.name, 'B');
});
test('repeated runs keep their individual timing/status', () => {
  const result = diagnoseExecution({ id: '123', workflowId: 'wf-1', status: 'success', data: { resultData: { runData: { Start: [{ executionStatus: 'error', executionTime: 1 }, { executionStatus: 'success', executionTime: 2 }] } } } }, '123', '');
  assert.deepEqual(result.nodeStatuses.map(run => run.runIndex), [0, 1]); assert.equal(result.failedNode, undefined);
});
test('missing execution exposes controlled 404 and makes no retries', async () => {
  let calls = 0;
  const api = new N8nClient(config, mockFetch(() => { calls++; return json({ error: fixtureSecrets }, 404); }));
  await assert.rejects(new WorkflowService(api, config).diagnose('123'), /HTTP 404/); assert.equal(calls, 1);
});
test('malformed execution and unknown versions fail closed', () => {
  for (const value of [null, [], {}, { ...executionFixture(), id: '456' }, { ...executionFixture(), status: fixtureSecrets[0] }, { ...executionFixture(), data: [] }, { ...executionFixture(), data: { version: 2 } }, { ...executionFixture(), data: { resultData: [] } }, { ...executionFixture(), data: { resultData: { runData: [] } } }, { ...executionFixture(), data: { resultData: { runData: { Start: [null] } } } }]) {
    assert.throws(() => diagnoseExecution(value, '123', config.apiKey), /Invalid|Unsupported/);
  }
});
test('missing, redacted and size-limited execution details remain unavailable', () => {
  const result = diagnoseExecution({ id: '123', workflowId: 'wf-1', status: 'error', data: {}, dataTooLargeToDisplay: true }, '123', '');
  assert.equal(result.failedNode, undefined); assert.equal(result.error, undefined); assert.equal(result.startedAt, undefined); assert.equal(result.nodeStatuses.length, 0); assert.ok(result.warnings.length);
});
test('n8n redactedError technical type/httpCode is understood without revealing data', () => {
  const result = diagnoseExecution({ id: '123', workflowId: 'wf-1', status: 'error', data: { version: 1, resultData: { redactedError: { type: 'NodeApiError', httpCode: '403' }, runData: { Request: [{ redactedError: { type: 'NodeApiError', httpCode: '403' } }] } } } }, '123', '');
  assert.equal(result.error?.name, 'NodeApiError'); assert.equal(result.error?.category, 'api');
  assert.equal(result.error?.httpStatusCode, 403); assert.equal(result.failedNode?.name, 'Request');
  assert.equal(result.failedNode?.type, undefined); assert.equal(result.error?.message, undefined);
});
test('legacy data version and run error node type work without a workflow snapshot', () => {
  const result = diagnoseExecution({ id: '123', workflowId: 'wf-1', status: 'error', data: { resultData: { runData: { Request: [{ error: { name: 'ExpressionError', node: { name: 'Request', type: 'n8n-nodes-base.httpRequest' } } }] } } } }, '123', '');
  assert.equal(result.failedNode?.type, 'n8n-nodes-base.httpRequest');
});
test('nonfinite timings and unrecognized http/status/error metadata are omitted', () => {
  const data = executionFixture(); data.data.resultData.error.httpCode = '0'; data.data.resultData.error.name = fixtureSecrets[0];
  data.data.resultData.runData.Start[0]!.executionTime = Infinity;
  const result = diagnoseExecution(data, '123', '');
  assert.equal(result.error?.httpStatusCode, undefined); assert.equal(result.error?.name, undefined); assert.equal(result.nodeStatuses[0]?.executionTime, undefined);
});
for (const field of ['authorization', 'cookie', 'set-cookie', 'apiKey', 'api_key', 'token', 'access_token', 'refresh_token', 'password', 'secret', 'client_secret', 'credential', 'x-api-key']) {
  test(`diagnostic sanitizer removes nested ${field}`, () => {
    const sanitizer = new DiagnosticSanitizer({ nested: { [field]: fixtureSecrets[0] } }, '');
    assert.equal(sanitizer.text(`value ${fixtureSecrets[0]}`), 'value [REDACTED]');
    assert.ok(!sanitizer.text(`${field}=${fixtureSecrets[2]}`)?.includes(fixtureSecrets[2]));
  });
}
test('Bearer/Basic authorization strings, credential URLs, cookies and personal prose', () => {
  const sanitizer = new DiagnosticSanitizer({}, '');
  for (const text of [`Bearer ${fixtureSecrets[1]}`, `Basic ${fixtureSecrets[1]}`, `https://user:${fixtureSecrets[2]}@example.org/${fixtureSecrets[0]}?token=x`, `Cookie: session=${fixtureSecrets[3]}; other=${fixtureSecrets[0]}`, `password="${fixtureSecrets[2]}"`]) {
    for (const secret of fixtureSecrets) assert.ok(!sanitizer.text(text)?.includes(secret));
  }
  assert.equal(sanitizer.diagnosticText('Customer Alice owes 500 euros'), undefined);
  assert.equal(sanitizer.diagnosticText('response body: private data'), undefined);
  assert.equal(sanitizer.diagnosticText('x'.repeat(2049)), undefined);
});
test('security regression: serialized MCP diagnostics never contain ANY fixture secret', async () => {
  const variants: unknown[] = [executionFixture(), { id: '123', workflowId: 'wf-1', status: 'success' }, null];
  for (const secret of fixtureSecrets) {
    const data = executionFixture(); data.data.resultData.error.message = `Bearer ${secret}`; data.data.resultData.error.description = `password=${secret}`;
    data.data.resultData.error.node.name = `cookie=${secret}`; variants.push(data);
  }
  let current: unknown;
  const api = new N8nClient(config, mockFetch(() => json(current)));
  const server = createServer(config, api, false); const client = new Client({ name: 'security-v2', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
  try {
    for (current of variants) {
      const response = await client.callTool({ name: 'diagnose_execution', arguments: { executionId: '123' } });
      const output = JSON.stringify(response);
      for (const secret of fixtureSecrets) assert.ok(!output.includes(secret), 'Fixture secret escaped into MCP output');
      for (const key of ['request', 'response', 'binary', 'environment', 'workflowData', 'customData', 'stack']) assert.ok(!output.includes(`\\"${key}\\"`));
    }
  } finally { await client.close(); await server.close(); }
});
