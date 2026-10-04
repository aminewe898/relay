export type Ticket = {
  id: string; number: string; intakeId: string; customerId: string; contactId: string;
  summary: string; description: string; category: string;
  priority: 'low' | 'normal' | 'high' | 'critical';
  status: 'open' | 'in_progress' | 'resolved' | 'closed'; createdAt: string; updatedAt: string;
  humanIdentifier?: string; clientName?: string; contactName?: string | null; contactEmail?: string;
  affectedSystem?: string | null; symptoms?: string[] | null; technicalDetails?: string[] | null;
  businessImpact?: string | null; onsetText?: string | null; urgencyEvidence?: string | null;
};
export type Customer = { id: string; name: string; kind: string; active: boolean; createdAt: string };
export type Contact = { id: string; customerId: string; name: string | null; email: string; active: boolean };
export type Intake = {
  id: string; number: string; state: string; summary: string | null;
  transcript: string | null; customerId: string | null; createdAt: string; updatedAt: string;
  categorySuggestion: string | null; prioritySuggestion: string | null;
  businessImpact: string | null; missingInformation: string[];
};
export type Interaction = { id: string; intakeId: string; kind: string; status: string; createdAt: string; resolvedAt?: string | null };
export type Work = { id: string; intakeId: string | null; stage: string; status: string; attempts: number; maxAttempts: number; updatedAt: string };
export type Delivery = { id: string; intakeId: string | null; kind: string; status: string; attempts: number; updatedAt: string };
export type Snapshot = {
  version: 1; source: 'live' | 'disconnected' | 'unavailable'; capturedAt: string;
  tickets: Ticket[]; customers: Customer[]; contacts: Contact[]; intakes: Intake[];
  interactions: Interaction[]; work: Work[]; deliveries: Delivery[];
  truncated: boolean; message: string | null;
  stats?: { openTickets: number; waitingInput: number; automationAttention: number; completedTickets: number; totalTickets: number; totalClients: number };
  activity?: Activity[]; services?: ServiceHealth[];
};
export type Activity = { id: string; kind: string; title: string; occurredAt: string; href: string; provenance: string };
export type ServiceHealth = { key: string; name: string; status: string; lastSuccessAt: string | null; queued: number | null; running: number | null; failed: number | null; uncertain: number | null; oldestAt: string | null; averageLatencyMs: number | null; evidence: string };
export function emptySnapshot(source: Snapshot['source'], message: string | null): Snapshot {
  return { version: 1, source, capturedAt: new Date().toISOString(), tickets: [], customers: [],
    contacts: [], intakes: [], interactions: [], work: [], deliveries: [], truncated: false, message };
}
export function label(value: string) { return value.replaceAll('_', ' ').replace(/^./, x => x.toUpperCase()); }
export function isOpen(ticket: Ticket) { return ticket.status === 'open' || ticket.status === 'in_progress'; }
export function customerName(data: Snapshot, id: string | null) {
  return data.customers.find(c => c.id === id)?.name ?? 'Customer not resolved';
}
export type QueueAction = { id: string; title: string; context: string; reason: string; tag: string; href: string; action: string; rank: number; time: string };
export function actionQueue(data: Snapshot): QueueAction[] {
  const actions: QueueAction[] = [];
  for (const interaction of data.interactions.filter(i => i.status === 'open')) {
    const intake = data.intakes.find(i => i.id === interaction.intakeId);
    actions.push({ id: interaction.id, title: intake?.summary ?? `Intake #${intake?.number ?? 'unknown'}`,
      context: customerName(data, intake?.customerId ?? null), reason: `Waiting for ${label(interaction.kind).toLowerCase()}. Reply through the existing Telegram operator conversation.`,
      tag: 'Decision needed', href: `/automations?intake=${interaction.intakeId}`, action: 'Review intake', rank: 0, time: interaction.createdAt });
  }
  for (const delivery of data.deliveries.filter(d => ['uncertain', 'needs_operator'].includes(d.status))) {
    actions.push({ id: delivery.id, title: delivery.status === 'uncertain' ? 'Delivery needs verification' : 'Message needs operator attention',
      context: 'Telegram delivery', reason: delivery.status === 'uncertain' ? 'The send outcome is unknown. Verify delivery before any manual retry.' : 'The delivery is awaiting operator intervention.',
      tag: 'Delivery exception', href: '/automations', action: 'Inspect delivery', rank: 1, time: delivery.updatedAt });
  }
  for (const work of data.work.filter(w => w.status === 'needs_operator')) {
    actions.push({ id: work.id, title: `${label(work.stage)} needs attention`, context: 'Intake pipeline',
      reason: `Work is paused for an operator. ${work.attempts} of ${work.maxAttempts} attempts used.`, tag: 'Automation blocked',
      href: '/automations', action: 'Inspect work', rank: 2, time: work.updatedAt });
  }
  for (const ticket of data.tickets.filter(isOpen)) {
    const rank = ticket.priority === 'critical' ? 3 : ticket.priority === 'high' ? 4 : 5;
    actions.push({ id: ticket.id, title: ticket.summary, context: customerName(data, ticket.customerId),
      reason: ticket.status === 'open' ? 'Open ticket awaiting technician work.' : 'Continue the work already in progress.',
      tag: ticket.priority === 'critical' ? 'Critical' : ticket.priority === 'high' ? 'High priority' : 'Current work',
      href: `/tickets/${ticket.id}`, action: ticket.status === 'open' ? 'Open workspace' : 'Continue work', rank, time: ticket.createdAt });
  }
  // Critical incidents outrank routine questions; retain rank groups for queue filters.
  const urgency = (action: QueueAction) => action.tag === 'Critical' ? -1 : action.rank;
  return actions.sort((a, b) => urgency(a) - urgency(b) || Date.parse(a.time) - Date.parse(b.time) || a.id.localeCompare(b.id));
}
export function searchRecords(data: Snapshot, query: string) {
  const q = query.trim().toLocaleLowerCase();
  return [
    ...data.tickets.map(t => ({ id: t.id, title: `${t.humanIdentifier ?? `TI-${t.number}`} · ${t.summary}`, subtitle: customerName(data, t.customerId), href: `/tickets/${t.id}`, haystack: `TI-${t.number} ${t.number} ${t.summary} ${t.description} ${customerName(data, t.customerId)}` })),
    ...data.customers.map(c => ({ id: c.id, title: c.name, subtitle: 'Customer', href: `/customers/${c.id}`, haystack: `${c.name} ${data.contacts.filter(x => x.customerId === c.id).map(x => `${x.name ?? ''} ${x.email}`).join(' ')}` })),
  ].filter(r => r.haystack.toLocaleLowerCase().includes(q)).slice(0, 12);
}
