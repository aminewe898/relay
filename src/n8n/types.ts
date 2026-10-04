import { z } from 'zod';

const object = z.record(z.string(), z.unknown());
const nonempty = z.string().trim().min(1);
export const nodeSchema = z.object({
  id: nonempty.optional(), name: nonempty, type: nonempty,
  typeVersion: z.number().finite().positive(),
  position: z.tuple([z.number().finite(), z.number().finite()]), parameters: object,
  credentials: z.record(z.string(), z.object({ id: nonempty, name: nonempty.optional() }).strict()).optional(),
  extendsCredential: nonempty.optional(),
  webhookId: nonempty.optional(), disabled: z.boolean().optional(),
  notes: z.string().optional(), notesInFlow: z.boolean().optional(),
  executeOnce: z.boolean().optional(), alwaysOutputData: z.boolean().optional(),
  retryOnFail: z.boolean().optional(), maxTries: z.number().int().positive().optional(),
  waitBetweenTries: z.number().nonnegative().optional(), continueOnFail: z.boolean().optional(),
  onError: z.enum(['stopWorkflow', 'continueRegularOutput', 'continueErrorOutput']).optional(),
  customTelemetryTags: z.object({ tag: z.array(z.object({ key: z.string(), value: z.string() }).strict()) }).strict().optional(),
});
export const settingsSchema = z.object({
  saveExecutionProgress: z.boolean().optional(), saveManualExecutions: z.boolean().optional(),
  saveDataErrorExecution: z.enum(['all', 'none']).optional(), saveDataSuccessExecution: z.enum(['all', 'none']).optional(),
  executionTimeout: z.number().finite().min(-1).optional(), errorWorkflow: z.string().optional(),
  timezone: z.string().optional(), executionOrder: z.enum(['v0', 'v1']).optional(),
  callerPolicy: z.enum(['any', 'none', 'workflowsFromAList', 'workflowsFromSameOwner']).optional(),
  callerIds: z.string().optional(), timeSavedMode: z.enum(['fixed', 'dynamic']).optional(),
  timeSavedPerExecution: z.number().finite().nonnegative().optional(),
  redactionPolicy: z.enum(['none', 'non-manual', 'manual-only', 'all']).optional(),
  availableInMCP: z.literal(false).optional(),
  customTelemetryTags: z.array(z.object({ key: z.string(), value: z.string() }).strict()).optional(),
  // These documented derived settings are accepted on reads but excluded from writes.
  binaryMode: z.enum(['separate', 'combined']).optional(), credentialResolverId: z.string().optional(),
}).strict();
const edge = z.object({ node: nonempty, type: nonempty, index: z.number().int().nonnegative() }).strict();
export const workflowSchema = z.object({
  name: nonempty.max(128), nodes: z.array(nodeSchema),
  connections: z.record(z.string(), z.record(z.string(), z.array(z.array(edge)))),
  settings: settingsSchema,
  staticData: z.union([object, z.string(), z.null()]).optional(),
  pinData: object.nullable().optional(),
  nodeGroups: z.array(z.object({ id: nonempty, name: z.string(), description: z.string().max(155).optional(), nodeIds: z.array(nonempty) }).strict()).optional(),
});
export type WorkflowPayload = z.infer<typeof workflowSchema>;
export type WorkflowNode = z.infer<typeof nodeSchema>;
export interface Workflow extends WorkflowPayload {
  id: string; active: boolean; versionId?: string; updatedAt?: string;
}
export interface WorkflowPage { data: Array<{ id: string; name: string; active: boolean }>; nextCursor?: string | null | undefined }
export const resourceIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/, 'Invalid resource ID');
