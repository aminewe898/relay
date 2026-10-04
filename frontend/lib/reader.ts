import type { PoolClient } from 'pg';
import { emptySnapshot, type Snapshot } from './model';
import { ticketSelect, activitySelect, healthSelect, statsSelect } from './api/projections';
export type QueryClient = Pick<PoolClient, 'query'>;
// Explicit column whitelist. Never SELECT * from an intake, queue or outbox.
export const reads = [
  ['tickets', `${ticketSelect} ORDER BY CASE WHEN t.status IN ('open','in_progress') THEN 0 ELSE 1 END, CASE t.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, t.created_at,t.id LIMIT 201`],
  ['customers', `SELECT id, display_name AS name, kind, active, created_at::text AS "createdAt" FROM ticket_intake.clients ORDER BY display_name, id LIMIT 201`],
  ['contacts', `SELECT id, client_id AS "customerId", display_name AS name, email_original AS email, active FROM ticket_intake.client_contacts ORDER BY created_at DESC, id LIMIT 201`],
  ['intakes', `SELECT id, intake_number::text AS number, state, CASE WHEN extraction_validated_at IS NOT NULL THEN extraction->>'summary' END AS summary, transcript_original AS transcript, client_id AS "customerId", created_at::text AS "createdAt", updated_at::text AS "updatedAt", CASE WHEN extraction_validated_at IS NOT NULL THEN extraction->>'category' END AS "categorySuggestion", CASE WHEN extraction_validated_at IS NOT NULL THEN extraction->>'prioritySuggestion' END AS "prioritySuggestion", CASE WHEN extraction_validated_at IS NOT NULL THEN extraction->>'businessImpact' END AS "businessImpact", CASE WHEN extraction_validated_at IS NOT NULL THEN extraction->'missingInformation' ELSE '[]'::jsonb END AS "missingInformation" FROM ticket_intake.intakes ORDER BY CASE WHEN state LIKE 'awaiting_%' OR state='needs_operator' THEN 0 ELSE 1 END, created_at DESC, id LIMIT 201`],
  ['interactions', `SELECT id, intake_id AS "intakeId", kind, status, created_at::text AS "createdAt", resolved_at::text AS "resolvedAt" FROM ticket_intake.pending_interactions ORDER BY CASE WHEN status='open' THEN 0 ELSE 1 END, created_at DESC,id LIMIT 201`],
  ['work', `SELECT id, intake_id AS "intakeId", stage, status, attempt_count AS attempts, max_attempts AS "maxAttempts", updated_at::text AS "updatedAt" FROM ticket_intake.work_items ORDER BY CASE WHEN status='needs_operator' THEN 0 ELSE 1 END, updated_at DESC, id LIMIT 201`],
  ['deliveries', `SELECT id, intake_id AS "intakeId", kind, status, attempt_count AS attempts, updated_at::text AS "updatedAt" FROM ticket_intake.outbox ORDER BY CASE WHEN status IN ('uncertain','needs_operator') THEN 0 ELSE 1 END, updated_at DESC, id LIMIT 201`],
  ['activity', `${activitySelect} LIMIT 201`],
  ['services', healthSelect],
] as const;
export async function readSnapshot(client: QueryClient): Promise<Snapshot> {
  const data = emptySnapshot('live', null);
  await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await client.query("SET LOCAL statement_timeout = '5000ms'");
    for (const [key, sql] of reads) {
      const result = await client.query(sql);
      data.truncated ||= result.rows.length > 200;
      // Each query above is the serialization contract, not raw DB rows.
      (data[key] as unknown[]) = result.rows.slice(0, 200);
    }
    const stats = await client.query(statsSelect);
    data.stats = stats.rows[0]?.value;
    data.intakes = data.intakes.map(i => ({ ...i, missingInformation: Array.isArray(i.missingInformation) ? i.missingInformation.filter((v): v is string => typeof v === 'string') : [] }));
    data.services = data.services?.map(s => ({ ...s, queued: s.queued === null ? null : Number(s.queued), running: s.running === null ? null : Number(s.running), failed: s.failed === null ? null : Number(s.failed), uncertain: s.uncertain === null ? null : Number(s.uncertain) }));
    await client.query('COMMIT');
    return data;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
