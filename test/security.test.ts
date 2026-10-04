import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact } from '../src/security.js';
import { WorkflowService } from '../src/tools/service.js';
import { N8nClient } from '../src/n8n/client.js';
import { validateWorkflow } from '../src/validation/workflow-validator.js';
import { config, mockFetch, json, payload } from './helpers.js';

test('redaction masks secrets and preserves only credential references', () => {
  const result = redact({ authorization: 'secret-auth', parameters: { apiKey: 'hidden-key', token: 'hidden-token', pair: { name: 'Authorization', value: 'hidden-header' }, text: config.apiKey, url: 'https://user:hidden-pass@example.org?token=hidden-query' }, credentials: { telegramApi: { id: 'credential-1', name: 'Telegram', password: 'hidden-password' } } }, config.apiKey);
  const serialized = JSON.stringify(result);
  for (const secret of ['secret-auth', 'hidden-key', 'hidden-token', 'hidden-header', 'hidden-pass', 'hidden-query', 'hidden-password', config.apiKey]) assert.ok(!serialized.includes(secret));
  assert.match(serialized, /credential-1/);
});
test('execution summary omits arbitrary secrets in innocuous keys and error strings', async () => {
  const execution = { id: '123', workflowId: 'wf-1', status: 'error', mode: 'manual', data: { resultData: { error: { message: 'hidden-error' }, runData: { Start: [{ executionTime: 3, executionStatus: 'error', error: { message: 'hidden-error' }, data: { main: [[{ json: { innocent: 'hidden-payload' } }]] } }] } } }, workflowData: { parameters: { anything: 'hidden-config' } }, customData: { x: 'hidden-custom' } };
  const service = new WorkflowService(new N8nClient(config, mockFetch(() => json(execution))), config);
  const result = JSON.stringify(await service.execution('123'));
  for (const secret of ['hidden-error', 'hidden-payload', 'hidden-config', 'hidden-custom']) assert.ok(!result.includes(secret));
  assert.match(result, /executionTime/); assert.match(result, /hasError/);
});
test('redacted parameters cannot be written back', () => {
  const w = payload(); w.nodes[0]!.parameters = { value: '[REDACTED]' };
  assert.equal(validateWorkflow(w).valid, false);
});
