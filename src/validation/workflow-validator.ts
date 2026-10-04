import { workflowSchema, type WorkflowPayload } from '../n8n/types.js';

export interface ValidationResult { valid: boolean; errors: string[]; warnings: string[] }
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateWorkflow(input: unknown): ValidationResult {
  const errors: string[] = []; const warnings: string[] = [];
  if (isObject(input) && input.active !== undefined && input.active !== false) errors.push('active must be false or omitted; activation is forbidden.');
  const parsed = workflowSchema.safeParse(input);
  if (!parsed.success) {
    // Do not echo input values or Zod messages, which can contain secrets.
    for (const issue of parsed.error.issues) errors.push(`Invalid field at ${issue.path.map(String).join('.') || 'workflow'} (${issue.code}).`);
    return { valid: false, errors, warnings };
  }
  const workflow = parsed.data;
  if (typeof workflow.staticData === 'string') {
    try { JSON.parse(workflow.staticData); } catch { errors.push('staticData must contain valid JSON when supplied as a string.'); }
  }
  const names = new Set<string>(); const ids = new Set<string>();
  workflow.nodes.forEach((node, i) => {
    if (names.has(node.name)) errors.push(`Duplicate node name at nodes.${i}.`);
    names.add(node.name);
    if (node.id && ids.has(node.id)) errors.push(`Duplicate node ID at nodes.${i}.`);
    if (node.id) ids.add(node.id);
    if (node.credentials) warnings.push(`nodes.${i}: credential references must already exist; IDs are not verified locally.`);
    if (node.type === 'n8n-nodes-base.webhook' && !node.parameters.path) warnings.push(`nodes.${i}: webhook path is missing.`);
    if (node.type === 'n8n-nodes-base.scheduleTrigger' && !node.parameters.rule) warnings.push(`nodes.${i}: schedule rule is missing.`);
    if (node.type === 'n8n-nodes-base.telegramTrigger' && (!node.parameters.updates || !node.credentials)) warnings.push(`nodes.${i}: Telegram updates or credential reference is missing.`);
  });
  for (const [source, channels] of Object.entries(workflow.connections)) {
    if (!names.has(source)) errors.push('Connection source references a nonexistent node.');
    for (const [channel, outputs] of Object.entries(channels)) {
      if (!channel.trim()) errors.push('Connection channel must be nonempty.');
      for (const output of outputs) for (const edge of output) {
        if (!names.has(edge.node)) errors.push('Connection target references a nonexistent node.');
        if (edge.type !== channel) errors.push('Connection type must match its channel.');
      }
    }
  }
  for (const group of workflow.nodeGroups ?? []) {
    if (group.nodeIds.some(id => !ids.has(id))) errors.push('Node group references a nonexistent node ID.');
  }
  const inspect = (value: unknown): void => {
    if (typeof value === 'string') {
      if (value.includes('[REDACTED]')) errors.push('Redaction placeholders cannot be written back; supply the intended value or credential reference.');
      if (value.includes('{{') || value.includes('}}')) {
        const opens = value.match(/\{\{/g)?.length ?? 0;
        const closes = value.match(/\}\}/g)?.length ?? 0;
        if (opens !== closes || (opens > 0 && value.indexOf('}}') < value.indexOf('{{'))) errors.push('Unbalanced expression delimiters.');
        if (/\{\{\s*\}\}/.test(value)) errors.push('Empty expression.');
      }
      for (const match of value.matchAll(/(?:\$node\[|\$\()\s*['"]([^'"]+)['"]/g)) {
        if (!names.has(match[1] ?? '')) warnings.push('Expression references an unknown node name.');
      }
    } else if (Array.isArray(value)) value.forEach(inspect);
    else if (isObject(value)) Object.entries(value).forEach(([key, child]) => { inspect(key); inspect(child); });
  };
  inspect(workflow);
  if (!workflow.nodes.some(n => !n.disabled && (/trigger$/i.test(n.type) || n.type === 'n8n-nodes-base.webhook'))) {
    warnings.push('No enabled trigger detected; confirm the intended entry point.');
  }
  if (isObject(input)) {
    const supported = new Set(Object.keys(workflowSchema.shape));
    if (Object.keys(input).some(k => !supported.has(k) && k !== 'active' && k !== 'id')) warnings.push('Unsupported or server-managed top-level fields are excluded from the write payload.');
    if (Array.isArray(input.nodes) && input.nodes.some(n => isObject(n) && Object.keys(n).some(k => !(k in workflowSchema.shape.nodes.element.shape)))) warnings.push('Unsupported or server-managed node fields are excluded from the write payload.');
  }
  warnings.push('Structural validation cannot verify node schemas, installed versions, credentials, or execution success.');
  return { valid: errors.length === 0, errors, warnings: [...new Set(warnings)] };
}

export function sanitizePayload(input: unknown): WorkflowPayload {
  const payload = workflowSchema.parse(input);
  delete payload.settings.binaryMode;
  delete payload.settings.credentialResolverId;
  return payload;
}
