import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { resolve } from 'node:path';
import { config, payload } from './helpers.js';

test('real spawned stdio server handshake and local validation', async () => {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', resolve('src/index.ts')], env: { ...env, N8N_BASE_URL: config.baseUrl, N8N_API_KEY: config.apiKey, N8N_DRY_RUN: 'true' }, stderr: 'pipe' });
  let stderr = ''; transport.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  const client = new Client({ name: 'stdio-test', version: '1' });
  try {
    await client.connect(transport);
    assert.equal((await client.listTools()).tools.length, 8);
    const result = await client.callTool({ name: 'validate_workflow', arguments: { workflow: payload() } });
    assert.notEqual(result.isError, true);
    const invalid = await client.callTool({ name: 'create_workflow', arguments: { workflow: { ...payload(), active: true } } });
    assert.equal(invalid.isError, true);
    assert.ok(!stderr.includes(config.apiKey));
    assert.match(stderr, /validationErrorCount/);
  } finally { await client.close(); }
});
