import { type Config } from '../config.js';
import { N8nApiError, N8nClient } from '../n8n/client.js';
import { resourceIdSchema, type WorkflowPayload, type Workflow } from '../n8n/types.js';
import { redact } from '../security.js';
import { isObject, sanitizePayload, validateWorkflow } from '../validation/workflow-validator.js';
import { diagnoseExecution } from '../diagnostics/execution.js';
import { workflowChanges } from './workflow-diff.js';

export interface UpdateOptions { allowNodeRemoval?: boolean; maxChangedNodes?: number }

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
function summary(before: WorkflowPayload | undefined, after: WorkflowPayload) {
  const oldNames = new Set(before?.nodes.map(n => n.name) ?? []);
  const newNames = new Set(after.nodes.map(n => n.name));
  return {
    before: before ? { name: before.name, nodeCount: before.nodes.length } : null,
    after: { name: after.name, nodeCount: after.nodes.length, active: false },
    addedNodes: after.nodes.filter(n => !oldNames.has(n.name)).map(n => n.name),
    removedNodes: before?.nodes.filter(n => !newNames.has(n.name)).map(n => n.name) ?? [],
    changedNodes: after.nodes.filter(n => { const old = before?.nodes.find(o => o.name === n.name); return old && canonical(old) !== canonical(n); }).map(n => n.name),
    connectionsChanged: canonical(before?.connections ?? {}) !== canonical(after.connections),
    settingsChanged: canonical(before?.settings ?? {}) !== canonical(after.settings),
    otherChangedFields: ['staticData', 'pinData', 'nodeGroups'].filter(k => canonical(before?.[k as keyof WorkflowPayload]) !== canonical(after[k as keyof WorkflowPayload])),
  };
}
export class WorkflowService {
  readonly #locks = new Set<string>();
  constructor(readonly client: N8nClient, readonly config: Config, readonly writesEnabled = true) {}
  safe(value: unknown): unknown { return redact(value, this.config.apiKey); }
  validate(workflow: unknown) { return validateWorkflow(workflow); }
  async list(options: { limit?: number; cursor?: string }) { return this.client.listWorkflows(options); }
  async get(id: string) { return this.client.getWorkflow(id); }
  async diagnose(id: string) {
    return diagnoseExecution(await this.client.getExecution(id), id, this.config.apiKey);
  }
  async diff(id: string, proposedWorkflow: unknown) {
    const existing = await this.client.getWorkflow(id);
    const { validation, payload } = this.#prepare(proposedWorkflow);
    if (isObject(proposedWorkflow) && proposedWorkflow.id !== undefined && proposedWorkflow.id !== id) {
      validation.errors.push('Payload ID does not match workflowId.'); validation.valid = false;
    }
    return { workflowId: id, valid: validation.valid, validationErrors: validation.errors,
      validationWarnings: validation.warnings,
      ...(validation.valid && payload ? { changes: workflowChanges(sanitizePayload(existing), payload) } : {}),
    };
  }
  #prepare(input: unknown) {
    const validation = validateWorkflow(input);
    if (!validation.valid) return { validation, payload: undefined };
    return { validation, payload: sanitizePayload(input) };
  }
  async create(input: unknown) {
    const { validation, payload } = this.#prepare(input);
    if (!payload) return { rejected: true, validation };
    if (isObject(input) && input.id !== undefined) throw new Error('Creation requires a workflow without an existing ID.');
    const changeSummary = summary(undefined, payload);
    if (this.config.dryRun) return { dryRun: true, operation: 'create_workflow', name: payload.name, validation, sanitizedPayload: payload, changeSummary };
    if (!this.writesEnabled) throw new Error('Real writes are not enabled in this milestone.');
    const created = await this.client.createWorkflow(payload);
    return this.#verify(created.id, payload, validation.warnings, changeSummary);
  }
  async update(id: string, input: unknown, expectedVersionId?: string, options: UpdateOptions = {}) {
    resourceIdSchema.parse(id);
    if (options.allowNodeRemoval !== undefined && typeof options.allowNodeRemoval !== 'boolean') throw new Error('allowNodeRemoval must be a boolean.');
    if (options.maxChangedNodes !== undefined && (!Number.isSafeInteger(options.maxChangedNodes) || options.maxChangedNodes < 0)) throw new Error('maxChangedNodes must be a nonnegative safe integer.');
    if (this.#locks.has(id)) throw new Error('An update to this workflow is already in progress.');
    this.#locks.add(id);
    try {
      const existing = await this.client.getWorkflow(id);
      if (existing.active !== false) throw new Error('Updates to active workflows are forbidden. Deactivate manually in n8n first.');
      if (isObject(input) && input.id !== undefined && input.id !== id) throw new Error('Payload ID does not match workflowId.');
      if (expectedVersionId !== undefined && existing.versionId !== expectedVersionId) throw new Error('Workflow version changed; fetch again before updating.');
      const { validation, payload } = this.#prepare(input);
      if (!payload) return { rejected: true, validation };
      const before = sanitizePayload(existing);
      const changeSummary = summary(before, payload);
      const changes = workflowChanges(before, payload);
      if (changes.nodesRemoved.length && options.allowNodeRemoval !== true) throw new Error('Update removes existing nodes. Destructive removal requires explicit allowNodeRemoval: true.');
      const changedNodeCount = changes.nodesAdded.length + changes.nodesRemoved.length + changes.nodesModified.length;
      if (options.maxChangedNodes !== undefined && changedNodeCount > options.maxChangedNodes) throw new Error('Proposed repair exceeds maxChangedNodes; narrow the repair or explicitly revise the limit.');
      const warnings = [...validation.warnings];
      if (changes.nodesRemoved.length) warnings.push('Destructive node removal explicitly allowed; removed nodes and their behavior will be lost.');
      if (changes.otherChangedFields.some(field => field !== 'name')) warnings.push('Optional workflow data changes in this full replacement; review otherChangedFields before writing.');
      if (!existing.versionId) warnings.push('Workflow versionId is unavailable; the pre-write full-state check remains in effect.');
      const versionInformation = { ...(typeof existing.versionId === 'string' ? { before: existing.versionId } : {}), ...(expectedVersionId !== undefined ? { expected: expectedVersionId } : {}), atomic: false };
      if (this.config.dryRun) return { dryRun: true, updated: false, operation: 'update_workflow', workflowId: id, name: payload.name, validation, sanitizedPayload: payload, changeSummary, versionInformation, changes, warnings };
      if (!this.writesEnabled) throw new Error('Real writes are not enabled in this milestone.');
      // Narrow the race window; n8n does not offer an atomic activation guard.
      const latest = await this.client.getWorkflow(id);
      if (latest.active !== false || canonical(latest) !== canonical(existing)) throw new Error('Workflow changed during preparation; fetch again.');
      await this.client.updateWorkflow(id, payload);
      const verified = await this.#verify(id, payload, warnings, changeSummary);
      return { ...verified, updated: true, versionInformation: { ...versionInformation, ...(verified.versionId !== undefined ? { after: verified.versionId } : {}) }, changes, warnings };
    } finally { this.#locks.delete(id); }
  }
  async #verify(id: string, payload: WorkflowPayload, warnings: string[], changeSummary: ReturnType<typeof summary>) {
    let workflow: Workflow;
    try { workflow = await this.client.getWorkflow(id); } catch {
      throw new N8nApiError(`Write may have succeeded for workflow ${id}, but read-back failed. Inspect n8n before retrying.`, undefined, true);
    }
    if (workflow.active !== false) throw new N8nApiError(`Workflow ${id} is unexpectedly active. Inspect n8n manually; this server cannot deactivate it.`, undefined, true);
    // n8n may add defaults/IDs; verify every submitted field, allowing additional server fields.
    const contains = (actual: unknown, expected: unknown): boolean => {
      if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every((v, i) => contains(actual[i], v));
      if (isObject(expected)) return isObject(actual) && Object.entries(expected).every(([k, v]) => contains(actual[k], v));
      return actual === expected;
    };
    if (!contains(workflow, payload)) throw new N8nApiError(`Workflow ${id} exists but read-back differs from the submitted payload. Inspect n8n before retrying.`, undefined, true);
    return { workflowId: id, name: workflow.name, active: workflow.active, verified: true, validationWarnings: warnings, changeSummary, ...(typeof workflow.versionId === 'string' ? { versionId: workflow.versionId } : {}) };
  }
  async execution(id: string) {
    const data = await this.client.getExecution(id);
    if (!isObject(data) || data.id !== id) throw new Error('Invalid execution response or identity.');
    const output: Record<string, unknown> = { dataPolicy: 'Raw item data, error messages, binary content, custom data, and workflow snapshots are omitted to avoid exposing secrets.' };
    for (const key of ['id', 'workflowId', 'status', 'mode', 'startedAt', 'stoppedAt', 'finished', 'dataTooLargeToDisplay']) {
      if (['string', 'boolean'].includes(typeof data[key]) || data[key] === null) output[key] = data[key];
    }
    const result = isObject(data.data) && isObject(data.data.resultData) ? data.data.resultData : undefined;
    if (result && isObject(result.runData)) {
      output.nodeRuns = Object.entries(result.runData).map(([name, runs]) => ({ name, runs: Array.isArray(runs) ? runs.map(run => {
        if (!isObject(run)) return {};
        return { status: typeof run.executionStatus === 'string' ? run.executionStatus : undefined, executionTime: typeof run.executionTime === 'number' ? run.executionTime : undefined, hasError: !!run.error };
      }) : [] }));
    }
    return output;
  }
}
