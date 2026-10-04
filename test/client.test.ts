import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as httpServer } from 'node:http';
import { N8nClient, N8nApiError } from '../src/n8n/client.js';
import { normalizeBaseUrl, loadConfig } from '../src/config.js';
import { config, mockFetch, json, payload } from './helpers.js';

test('URL normalization retains instance subpath and API root', () => {
  for (const url of ['https://n8n.example/prefix/', 'https://n8n.example/prefix/api/v1/']) assert.equal(normalizeBaseUrl(url), 'https://n8n.example/prefix/api/v1');
  for (const url of ['not-url', 'file:///tmp', 'http://user:pass@localhost', 'http://localhost?key=secret']) assert.throws(() => normalizeBaseUrl(url));
});
test('config validates required secrets, dry-run, timeout and safe errors', () => {
  assert.equal(loadConfig({ N8N_BASE_URL: config.baseUrl, N8N_API_KEY: config.apiKey }).dryRun, true);
  for (const env of [{}, { N8N_BASE_URL: config.baseUrl }, { N8N_BASE_URL: config.baseUrl, N8N_API_KEY: config.apiKey, N8N_DRY_RUN: 'yes' }, { N8N_BASE_URL: config.baseUrl, N8N_API_KEY: config.apiKey, N8N_REQUEST_TIMEOUT_MS: 'NaN' }]) assert.throws(() => loadConfig(env));
});
test('API errors do not include secret-bearing response bodies', async () => {
  for (const status of [400, 401, 403, 404, 409, 429, 500]) {
    const api = new N8nClient(config, mockFetch(() => json({ message: config.apiKey, credentials: { password: 'hidden' } }, status)));
    await assert.rejects(api.getWorkflow('wf-1'), (error: unknown) => error instanceof N8nApiError && error.status === status && !error.message.includes(config.apiKey) && !error.message.includes('hidden'));
  }
});
test('network errors and malformed responses use controlled errors', async () => {
  for (const response of [new Response('secret body'), json({})]) {
    const api = new N8nClient(config, mockFetch(() => response));
    await assert.rejects(api.getWorkflow('wf-1'), /n8n/);
  }
  const api = new N8nClient(config, mockFetch(() => { throw new Error(config.apiKey); }));
  await assert.rejects(api.getWorkflow('wf-1'), error => !String(error).includes(config.apiKey));
});
test('native fetch times out through response body reading without retrying writes', async () => {
  let calls = 0;
  const server = httpServer((_request, response) => {
    calls++;
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.write('{'); // Send headers but leave the body hanging.
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const api = new N8nClient({ ...config, baseUrl: `http://127.0.0.1:${address.port}`, timeoutMs: 100, dryRun: false });
  try {
    await assert.rejects(api.createWorkflow(payload()), (error: unknown) => error instanceof N8nApiError && /timed out/.test(error.message) && error.mutationMayHaveOccurred);
    assert.equal(calls, 1);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
test('redirects are refused so API keys are never forwarded', async () => {
  const server = httpServer((_request, response) => { response.writeHead(302, { Location: 'http://example.invalid' }); response.end(); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  try { await assert.rejects(new N8nClient({ ...config, baseUrl: `http://127.0.0.1:${address.port}` }).getWorkflow('wf-1'), /Cannot reach/); }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
