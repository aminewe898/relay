import { ApiError, readJson } from '../data';
import { activitySelect, healthSelect, rowsJson, ticketSelect } from './projections';
import { pageOptions, uuid } from './sql';
import type { Ticket } from '../model';

export async function tickets(params: URLSearchParams) {
  let options;
  try { options = pageOptions(params); } catch { throw new ApiError(400, 'Invalid pagination.'); }
  const { q, page, limit, offset } = options;
  const status = params.get('status') ?? 'all';
  const priority = params.get('priority') ?? 'all';
  const sort = params.get('sort') ?? 'priority';
  const customerId = params.get('clientId');
  if (!['all','open','in_progress','resolved','closed'].includes(status) || !['all','low','normal','high','critical'].includes(priority) || (customerId && !uuid(customerId))) throw new ApiError(400, 'Invalid ticket filter.');
  const sorting: Record<string,string> = { priority: `CASE t.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,t.created_at`, created: 't.created_at DESC', updated: 't.updated_at DESC', id: 't.ticket_number DESC', summary: 't.summary ASC' };
  if (!sorting[sort]) throw new ApiError(400, 'Invalid sort.');
  const where = ` WHERE ($1='' OR strpos(lower(t.summary||' '||t.ticket_number::text||' TI-'||t.ticket_number::text||' '||c.display_name),lower($1))>0) AND ($2='all' OR t.status=$2) AND ($3='all' OR t.priority=$3) AND ($4::uuid IS NULL OR t.client_id=$4::uuid)`;
  return readJson(`SELECT jsonb_build_object('data',${rowsJson(`${ticketSelect}${where} ORDER BY ${sorting[sort]},t.id LIMIT $5 OFFSET $6`)},'total',(SELECT count(*) FROM (${ticketSelect}${where}) counted),'page',$7::integer,'limit',$5::integer,'source','live','capturedAt',clock_timestamp()) AS value`, [q,status,priority,customerId,limit,offset,page]);
}
export async function ticket(id: string) {
  if (!uuid(id)) throw new ApiError(400, 'Invalid ticket ID.');
  const result = await readJson<{ ticket: Ticket | null; intake: unknown; events: unknown[] }>(`SELECT jsonb_build_object(
    'ticket',(SELECT to_jsonb(record) FROM (${ticketSelect} WHERE t.id=$1::uuid) record),
    'intake',(SELECT jsonb_build_object('id',i.id,'number',i.intake_number::text,'state',i.state,'transcript',i.transcript_original,'categorySuggestion',CASE WHEN i.extraction_validated_at IS NOT NULL THEN i.extraction->>'category' END,'prioritySuggestion',CASE WHEN i.extraction_validated_at IS NOT NULL THEN i.extraction->>'prioritySuggestion' END,'businessImpact',CASE WHEN i.extraction_validated_at IS NOT NULL THEN i.extraction->>'businessImpact' END,'missingInformation',CASE WHEN i.extraction_validated_at IS NOT NULL THEN i.extraction->'missingInformation' ELSE '[]'::jsonb END,'createdAt',i.created_at,'updatedAt',i.updated_at) FROM ticket_intake.intakes i JOIN ticket_intake.tickets t ON t.intake_id=i.id WHERE t.id=$1::uuid),
    'events',${rowsJson(`SELECT id,kind,title,"occurredAt",href,provenance FROM (${activitySelect}) related WHERE href='/tickets/'||$1::text OR href='/automations?intake='||(SELECT intake_id::text FROM ticket_intake.tickets WHERE id=$1::uuid) ORDER BY "occurredAt" ASC,id LIMIT 200`)},'source','live','capturedAt',clock_timestamp()) AS value`, [id]);
  if (!result.ticket) throw new ApiError(404, 'Ticket not found.');
  return result;
}
const clientSelect = `SELECT c.id,c.display_name AS name,c.kind,c.active,c.created_at AS "createdAt",
 (SELECT count(*) FROM ticket_intake.tickets t WHERE t.client_id=c.id AND t.status IN ('open','in_progress')) AS "openTickets",
 (SELECT count(*) FROM ticket_intake.client_contacts cc WHERE cc.client_id=c.id AND cc.active) AS "contactCount"
 FROM ticket_intake.clients c`;
export async function clients(params: URLSearchParams) {
  let options;
  try { options = pageOptions(params); } catch { throw new ApiError(400, 'Invalid pagination.'); }
  const { q,page,limit,offset } = options;
  const where = ` WHERE ($1='' OR strpos(lower(c.display_name),lower($1))>0 OR EXISTS(SELECT 1 FROM ticket_intake.client_contacts cc WHERE cc.client_id=c.id AND strpos(lower(coalesce(cc.display_name,'')||' '||cc.email_original),lower($1))>0))`;
  return readJson(`SELECT jsonb_build_object('data',${rowsJson(`${clientSelect}${where} ORDER BY c.display_name,c.id LIMIT $2 OFFSET $3`)},'total',(SELECT count(*) FROM ticket_intake.clients c${where}),'page',$4::integer,'limit',$2::integer,'source','live','capturedAt',clock_timestamp()) AS value`, [q,limit,offset,page]);
}
export async function client(id: string) {
  if (!uuid(id)) throw new ApiError(400, 'Invalid client ID.');
  const result = await readJson<{ client: unknown; contacts: unknown[]; tickets: Ticket[]; historyLimit: number }>(`SELECT jsonb_build_object(
    'client',(SELECT to_jsonb(record) FROM (${clientSelect} WHERE c.id=$1::uuid) record),
    'contacts',${rowsJson(`SELECT cc.id,cc.client_id AS "customerId",cc.display_name AS name,cc.email_original AS email,cc.active FROM ticket_intake.client_contacts cc WHERE cc.client_id=$1::uuid ORDER BY cc.created_at LIMIT 200`)},
    'tickets',${rowsJson(`${ticketSelect} WHERE t.client_id=$1::uuid ORDER BY t.created_at DESC,t.id LIMIT 200`)},
    'historyLimit',200,'source','live','capturedAt',clock_timestamp()) AS value`,[id]);
  if (!result.client) throw new ApiError(404, 'Client not found.');
  return result;
}
export async function interactions(params: URLSearchParams) {
  const status = params.get('status') ?? 'open';
  if (!['open','resolved','cancelled','all'].includes(status)) throw new ApiError(400,'Invalid interaction status.');
  return readJson(`SELECT jsonb_build_object('data',${rowsJson(`SELECT p.id,p.intake_id AS "intakeId",i.intake_number::text AS "intakeNumber",CASE WHEN i.extraction_validated_at IS NOT NULL THEN i.extraction->>'summary' END AS summary,p.kind,p.status,p.created_at AS "createdAt",p.resolved_at AS "resolvedAt" FROM ticket_intake.pending_interactions p JOIN ticket_intake.intakes i ON i.id=p.intake_id WHERE ($1='all' OR p.status=$1) ORDER BY p.created_at DESC LIMIT 200`)},'limit',200,'source','live','capturedAt',clock_timestamp()) AS value`,[status]);
}
export async function activity() { return readJson(`SELECT jsonb_build_object('data',${rowsJson(`${activitySelect} LIMIT 100`)},'limit',100,'source','live','capturedAt',clock_timestamp()) AS value`); }
export async function automationHealth() { return readJson(`SELECT jsonb_build_object('data',${rowsJson(healthSelect)},'source','live','capturedAt',clock_timestamp()) AS value`); }
