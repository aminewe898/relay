import { z } from 'zod';
import { normalizeBaseUrl, type Config } from '../config.js';
import { resourceIdSchema, type Workflow, type WorkflowPage, type WorkflowPayload } from './types.js';

export class N8nApiError extends Error {
  constructor(message: string, readonly status?: number, readonly mutationMayHaveOccurred = false) { super(message); this.name = 'N8nApiError'; }
}
const responseSchema = z.object({ id: resourceIdSchema, name: z.string(), active: z.boolean(), nodes: z.array(z.unknown()), connections: z.record(z.string(), z.unknown()), settings: z.record(z.string(), z.unknown()) });

export class N8nClient {
  readonly #config: Config; readonly #fetch: typeof fetch;
  constructor(config: Config, fetchImpl: typeof fetch = fetch) { this.#config = { ...config, baseUrl: normalizeBaseUrl(config.baseUrl) }; this.#fetch = fetchImpl; }

  // Deliberately private: there is no arbitrary HTTP tool or public request method.
  async #request(method: 'GET' | 'POST' | 'PUT', path: string, payload?: unknown): Promise<unknown> {
    if (this.#config.dryRun && method !== 'GET') throw new N8nApiError('Writes are disabled by N8N_DRY_RUN.');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#config.timeoutMs);
    try {
      const response = await this.#fetch(`${this.#config.baseUrl}${path}`, {
        method, headers: { Accept: 'application/json', 'X-N8N-API-KEY': this.#config.apiKey, ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
        signal: controller.signal, redirect: 'error',
      });
      if (!response.ok) {
        const hint: Record<number, string> = { 400: 'Invalid payload.', 401: 'Check N8N_API_KEY.', 403: 'Check API key scopes and project access.', 404: 'Resource not found.', 409: 'Conflict; fetch the workflow again.', 429: 'Rate limited; retry later.' };
        throw new N8nApiError(`n8n API HTTP ${response.status}. ${hint[response.status] ?? 'Server rejected the request.'}`, response.status, method !== 'GET' && (response.status >= 500 || (method === 'PUT' && response.status === 403)));
      }
      // Timeout remains in force while reading/parsing the response body.
      try { return await response.json() as unknown; } catch {
        if (controller.signal.aborted) throw new N8nApiError('n8n API request timed out.', undefined, method !== 'GET');
        throw new N8nApiError('n8n API returned invalid JSON.', undefined, method !== 'GET');
      }
    } catch (error) {
      if (error instanceof N8nApiError) throw error;
      throw new N8nApiError(controller.signal.aborted ? 'n8n API request timed out.' : 'Cannot reach n8n; check the base URL, network, TLS, and redirects.', undefined, method !== 'GET');
    } finally { clearTimeout(timer); }
  }
  async listWorkflows(options: { limit?: number; cursor?: string } = {}): Promise<WorkflowPage> {
    const limit = z.number().int().min(1).max(250).parse(options.limit ?? 50);
    const query = new URLSearchParams({ limit: String(limit) });
    if (options.cursor) query.set('cursor', z.string().max(4096).parse(options.cursor));
    const data = await this.#request('GET', `/workflows?${query}`);
    const parsed = z.object({ data: z.array(z.object({ id: resourceIdSchema, name: z.string(), active: z.boolean() })), nextCursor: z.string().nullable().optional() }).safeParse(data);
    if (!parsed.success) throw new N8nApiError('n8n returned an invalid workflow list.');
    return parsed.data;
  }
  async getWorkflow(id: string): Promise<Workflow> {
    resourceIdSchema.parse(id);
    const data = await this.#request('GET', `/workflows/${encodeURIComponent(id)}`);
    if (!responseSchema.safeParse(data).success) throw new N8nApiError('n8n returned an invalid workflow.');
    const workflow = data as Workflow;
    if (workflow.id !== id) throw new N8nApiError('n8n returned a different workflow ID.');
    return workflow;
  }
  async createWorkflow(payload: WorkflowPayload): Promise<Workflow> {
    const data = await this.#request('POST', '/workflows', payload);
    if (!responseSchema.safeParse(data).success) throw new N8nApiError('Creation response is invalid; inspect n8n before retrying.', undefined, true);
    return data as Workflow;
  }
  async updateWorkflow(id: string, payload: WorkflowPayload): Promise<Workflow> {
    resourceIdSchema.parse(id);
    const data = await this.#request('PUT', `/workflows/${encodeURIComponent(id)}?publishIfActive=false`, payload);
    if (!responseSchema.safeParse(data).success || (data as Workflow).id !== id) throw new N8nApiError('Update response identity is invalid; inspect n8n before retrying.', undefined, true);
    return data as Workflow;
  }
  async getExecution(id: string): Promise<unknown> {
    z.string().regex(/^[1-9][0-9]{0,19}$/).parse(id);
    return this.#request('GET', `/executions/${id}?includeData=true`);
  }
}
