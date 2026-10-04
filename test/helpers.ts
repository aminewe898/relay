import type { Config } from '../src/config.js';
import type { Workflow, WorkflowPayload } from '../src/n8n/types.js';

export const config: Config = { baseUrl: 'http://localhost:5678', apiKey: 'test-api-secret', dryRun: true, timeoutMs: 1000 };
export function payload(): WorkflowPayload {
  return { name: 'Support intake', nodes: [{ id: 'node-1', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} }], connections: {}, settings: {} };
}
export function workflow(): Workflow { return { ...payload(), id: 'wf-1', active: false, versionId: 'v1' }; }
export function mockFetch(handler: (url: URL, init: RequestInit) => Response | Promise<Response>): typeof fetch {
  return (async (url, init) => handler(new URL(String(url)), init ?? {})) as typeof fetch;
}
export const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
