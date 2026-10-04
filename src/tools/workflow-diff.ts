import type { WorkflowPayload } from '../n8n/types.js';

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
type Edge = { source: string; channel: string; outputIndex: number; target: string; type: string; inputIndex: number };
function edges(workflow: WorkflowPayload): Edge[] {
  return Object.entries(workflow.connections).flatMap(([source, channels]) => Object.entries(channels).flatMap(([channel, outputs]) => outputs.flatMap((output, outputIndex) => output.map(edge => ({ source, channel, outputIndex, target: edge.node, type: edge.type, inputIndex: edge.index })))));
}
function subtract(left: Edge[], right: Edge[]): Edge[] {
  const remaining = right.map(canonical);
  return left.filter(edge => { const index = remaining.indexOf(canonical(edge)); if (index < 0) return true; remaining.splice(index, 1); return false; });
}
/** Compares raw allowlisted payloads, but emits field names only, never values. */
export function workflowChanges(before: WorkflowPayload, after: WorkflowPayload) {
  const identity = (node: WorkflowPayload['nodes'][number]) => node.id ? `id:${node.id}` : `name:${node.name}`;
  const oldNodes = new Map(before.nodes.map(node => [identity(node), node]));
  const newNodes = new Map(after.nodes.map(node => [identity(node), node]));
  if (oldNodes.size !== before.nodes.length || newNodes.size !== after.nodes.length) throw new Error('Workflow has ambiguous node identities; inspect duplicate IDs or names before repair.');
  const nodesAdded = after.nodes.filter(node => !oldNodes.has(identity(node))).map(node => node.name);
  const nodesRemoved = before.nodes.filter(node => !newNodes.has(identity(node))).map(node => node.name);
  const nodesModified = after.nodes.flatMap(node => {
    const old = oldNodes.get(identity(node)); if (!old) return [];
    const fields = [...new Set([...Object.keys(old), ...Object.keys(node)])].filter(field => canonical(old[field as keyof typeof old]) !== canonical(node[field as keyof typeof node]));
    return fields.length ? [{ name: node.name, fields }] : [];
  });
  const oldEdges = edges(before); const newEdges = edges(after);
  return { nodesAdded, nodesRemoved, nodesModified,
    connectionsAdded: subtract(newEdges, oldEdges), connectionsRemoved: subtract(oldEdges, newEdges),
    settingsChanged: [...new Set([...Object.keys(before.settings), ...Object.keys(after.settings)])].filter(key => canonical(before.settings[key as keyof typeof before.settings]) !== canonical(after.settings[key as keyof typeof after.settings])),
    otherChangedFields: ['name', 'staticData', 'pinData', 'nodeGroups'].filter(key => canonical(before[key as keyof WorkflowPayload]) !== canonical(after[key as keyof WorkflowPayload])),
  };
}
