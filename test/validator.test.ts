import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateWorkflow, sanitizePayload } from '../src/validation/workflow-validator.js';
import { payload } from './helpers.js';

test('valid workflow and documented fractional node version', () => {
  const w = payload(); w.nodes[0]!.typeVersion = 1.2;
  assert.equal(validateWorkflow(w).valid, true);
});
test('missing required top-level fields and malformed workflows', () => {
  for (const w of [null, [], {}, { name: 'x' }, { ...payload(), nodes: {} }, { ...payload(), settings: null }, { ...payload(), connections: null }]) assert.equal(validateWorkflow(w).valid, false);
});
test('duplicate names and IDs', () => {
  const w = payload(); w.nodes.push({ ...w.nodes[0]! });
  assert.equal(validateWorkflow(w).errors.length, 2);
});
test('malformed nodes', () => {
  for (const patch of [{ type: '' }, { typeVersion: 0 }, { position: [1] }, { parameters: [] }, { credentials: { test: { id: '1', secret: 'hidden' } } }]) {
    assert.equal(validateWorkflow({ ...payload(), nodes: [{ ...payload().nodes[0], ...patch }] }).valid, false);
  }
});
test('broken connections and malformed connection shape', () => {
  for (const connections of [{ Missing: { main: [[]] } }, { Start: { main: [[{ node: 'Missing', type: 'main', index: 0 }]] } }, { Start: { main: [[{ node: 'Start', type: 'main', index: -1 }]] } }, { Start: { main: {} } }, { Start: { main: [[{ node: 'Start', type: 'ai_tool', index: 0 }]] } }]) assert.equal(validateWorkflow({ ...payload(), connections }).valid, false);
});
test('expressions are checked without executing code', () => {
  const w = payload(); w.nodes[0]!.parameters = { text: '={{ $json.text', empty: '{{ }}' };
  assert.equal(validateWorkflow(w).valid, false);
  w.nodes[0]!.parameters = { text: '={{ $("Missing").item.json.text }}' };
  assert.equal(validateWorkflow(w).valid, true);
  assert.ok(validateWorkflow(w).warnings.some(s => s.includes('unknown node')));
});
test('missing trigger configuration yields useful warnings', () => {
  const w = payload(); w.nodes[0]!.type = 'n8n-nodes-base.webhook';
  assert.ok(validateWorkflow(w).warnings.some(s => s.includes('webhook path')));
  w.nodes[0]!.disabled = true;
  assert.ok(validateWorkflow(w).warnings.some(s => s.includes('No enabled trigger')));
});
test('activation and MCP exposure are forbidden', () => {
  assert.equal(validateWorkflow({ ...payload(), active: true }).valid, false);
  assert.equal(validateWorkflow({ ...payload(), settings: { availableInMCP: true } }).valid, false);
});
test('payload excludes read-only and unsupported fields', () => {
  const w = { ...payload(), active: false, id: 'wf-1', tags: [], meta: {}, settings: { binaryMode: 'separate', credentialResolverId: 'resolver' } };
  assert.deepEqual(sanitizePayload(w), payload());
});
