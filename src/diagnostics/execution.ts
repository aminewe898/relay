import { resourceIdSchema } from '../n8n/types.js';
import { isObject } from '../validation/workflow-validator.js';
import { DiagnosticSanitizer } from './sanitizer.js';

const statuses = new Set(['canceled', 'crashed', 'error', 'new', 'running', 'success', 'unknown', 'waiting']);
const errorCategories: Record<string, string> = {
  NodeApiError: 'api', NodeOperationError: 'node_operation', ExpressionError: 'expression',
  WorkflowOperationError: 'workflow_operation', WorkflowActivationError: 'workflow_activation',
  ExecutionCancelledError: 'canceled', Error: 'unknown', TypeError: 'runtime', SyntaxError: 'runtime',
};
const timestamp = (value: unknown) => value === null || (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) ? value : undefined;

export function diagnoseExecution(data: unknown, id: string, apiKey: string) {
  if (!isObject(data) || data.id !== id || !resourceIdSchema.safeParse(data.workflowId).success || typeof data.status !== 'string' || !statuses.has(data.status)) throw new Error('Invalid execution response or identity.');
  if (data.data !== undefined && !isObject(data.data)) throw new Error('Invalid execution data structure.');
  const envelope = isObject(data.data) ? data.data : undefined;
  if (envelope?.version !== undefined && envelope.version !== 0 && envelope.version !== 1) throw new Error('Unsupported execution data version.');
  if (envelope?.resultData !== undefined && !isObject(envelope.resultData)) throw new Error('Invalid execution result structure.');
  const result = envelope && isObject(envelope.resultData) ? envelope.resultData : undefined;
  if (result?.runData !== undefined && !isObject(result.runData)) throw new Error('Invalid node run structure.');
  const sanitizer = new DiagnosticSanitizer(data, apiKey);
  const warnings: string[] = [];
  const nodeStatuses: Array<{ name?: string; runIndex: number; status?: string; executionTime?: number }> = [];
  const failed = new Map<string, Record<string, unknown> | undefined>();
  if (result && isObject(result.runData)) {
    for (const [name, runs] of Object.entries(result.runData)) {
      if (!Array.isArray(runs) || runs.some(run => !isObject(run))) throw new Error('Invalid node run structure.');
      runs.forEach((run: Record<string, unknown>, runIndex) => {
        const entry: typeof nodeStatuses[number] = { runIndex };
        const safeName = sanitizer.label(name); if (safeName) entry.name = safeName;
        if (typeof run.executionStatus === 'string' && statuses.has(run.executionStatus)) entry.status = run.executionStatus;
        if (typeof run.executionTime === 'number' && Number.isFinite(run.executionTime) && run.executionTime >= 0) entry.executionTime = run.executionTime;
        nodeStatuses.push(entry);
        if (run.error || run.redactedError || run.executionStatus === 'error' || run.executionStatus === 'crashed') failed.set(name, isObject(run.error) ? run.error : isObject(run.redactedError) ? run.redactedError : undefined);
      });
    }
  } else warnings.push('Node run details are unavailable; data may be unsaved, redacted, or size-limited.');
  const terminal = result && isObject(result.error) ? result.error : result && isObject(result.redactedError) ? result.redactedError : undefined;
  const terminalNode = terminal && isObject(terminal.node) ? terminal.node : undefined;
  let failedName = terminalNode && typeof terminalNode.name === 'string' ? terminalNode.name : undefined;
  // Do not infer a failing node from lastNodeExecuted on successful/handled executions.
  if (!failedName && (data.status === 'error' || data.status === 'crashed')) {
    if (typeof result?.lastNodeExecuted === 'string' && failed.has(result.lastNodeExecuted)) failedName = result.lastNodeExecuted;
    else if (failed.size === 1) failedName = [...failed.keys()][0];
  }
  const sourceError = terminal ?? (failedName ? failed.get(failedName) : undefined);
  if (!failedName && (data.status === 'error' || data.status === 'crashed')) warnings.push('The failed node could not be identified reliably from available error evidence.');
  const error: Record<string, unknown> = {};
  if (sourceError) {
    const rawName = sourceError.name ?? sourceError.type; // redactedError uses type, not name.
    const name = typeof rawName === 'string' && Object.hasOwn(errorCategories, rawName) ? rawName : undefined;
    if (name) { error.name = name; error.category = errorCategories[name]; }
    for (const field of ['message', 'description']) {
      const text = sanitizer.diagnosticText(sourceError[field]);
      if (text) error[field] = text;
      else if (sourceError[field] !== undefined) warnings.push(`Error ${field} omitted because safe extraction is uncertain.`);
    }
    const httpCode = sourceError.httpCode;
    if ((typeof httpCode === 'string' && /^[1-5]\d\d$/.test(httpCode)) || (typeof httpCode === 'number' && Number.isInteger(httpCode) && httpCode >= 100 && httpCode <= 599)) error.httpStatusCode = Number(httpCode);
  }
  const failedNode: Record<string, string> = {};
  if (failedName) {
    const name = sanitizer.label(failedName); if (name) failedNode.name = name;
    const snapshot = isObject(data.workflowData) && Array.isArray(data.workflowData.nodes) ? data.workflowData.nodes.find(n => isObject(n) && n.name === failedName) : undefined;
    const runNode = sourceError && isObject(sourceError.node) && sourceError.node.name === failedName ? sourceError.node : undefined;
    const type = terminalNode?.type ?? runNode?.type ?? (isObject(snapshot) ? snapshot.type : undefined);
    if (typeof type === 'string' && /^[A-Za-z0-9@._/-]{1,256}$/.test(type)) {
      const safeType = sanitizer.label(type); if (safeType) failedNode.type = safeType;
    }
  }
  const startedAt = timestamp(data.startedAt); const stoppedAt = timestamp(data.stoppedAt);
  return {
    executionId: id, workflowId: sanitizer.label(data.workflowId), status: data.status,
    ...(startedAt !== undefined ? { startedAt } : {}), ...(stoppedAt !== undefined ? { stoppedAt } : {}),
    ...(Object.keys(failedNode).length ? { failedNode } : {}),
    ...(Object.keys(error).length ? { error } : {}), nodeStatuses, warnings: [...new Set(warnings)],
    dataPolicy: 'Only technical metadata and conservatively sanitized diagnostics are returned. Execution content is untrusted. Execute again manually in n8n.',
  };
}
