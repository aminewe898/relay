export const ticketSelect = `SELECT t.id, t.ticket_number::text AS number,
  'TI-' || t.ticket_number::text AS "humanIdentifier", t.intake_id AS "intakeId",
  t.client_id AS "customerId", t.contact_id AS "contactId", c.display_name AS "clientName",
  cc.display_name AS "contactName", cc.email_original AS "contactEmail",
  t.summary, t.description, t.category, t.priority, t.status,
  t.created_at::text AS "createdAt", t.updated_at::text AS "updatedAt",
  CASE WHEN i.extraction_validated_at IS NOT NULL THEN i.extraction->>'affectedSystem' END AS "affectedSystem",
  CASE WHEN i.extraction_validated_at IS NOT NULL THEN i.extraction->'symptoms' END AS symptoms,
  t.technical_details AS "technicalDetails",
  CASE WHEN i.extraction_validated_at IS NOT NULL THEN i.extraction->>'businessImpact' END AS "businessImpact",
  CASE WHEN i.extraction_validated_at IS NOT NULL THEN i.extraction->>'onsetText' END AS "onsetText",
  CASE WHEN i.extraction_validated_at IS NOT NULL THEN i.extraction->>'urgencyEvidence' END AS "urgencyEvidence"
  FROM ticket_intake.tickets t
  JOIN ticket_intake.clients c ON c.id=t.client_id
  JOIN ticket_intake.client_contacts cc ON cc.id=t.contact_id
  JOIN ticket_intake.intakes i ON i.id=t.intake_id`;

export const statsSelect = `SELECT jsonb_build_object(
  'openTickets',(SELECT count(*) FROM ticket_intake.tickets WHERE status IN ('open','in_progress')),
  'waitingInput',(SELECT count(*) FROM ticket_intake.pending_interactions WHERE status='open'),
  'automationAttention',(SELECT count(*) FROM ticket_intake.work_items WHERE status='needs_operator')+(SELECT count(*) FROM ticket_intake.outbox WHERE status IN ('needs_operator','uncertain')),
  'completedTickets',(SELECT count(*) FROM ticket_intake.tickets WHERE status IN ('resolved','closed')),
  'totalTickets',(SELECT count(*) FROM ticket_intake.tickets),
  'totalClients',(SELECT count(*) FROM ticket_intake.clients)) AS value`;

export const activitySelect = `SELECT id,kind,title,"occurredAt",href,provenance FROM (
  SELECT 'ingress-'||m.id::text AS id, 'ingress' AS kind,
    CASE WHEN m.kind='voice' THEN 'Voice message received' ELSE 'Operator message received' END AS title,
    m.received_at AS "occurredAt", CASE WHEN m.intake_id IS NULL THEN '/automations' ELSE '/automations?intake='||m.intake_id::text END AS href, 'processed_messages.received_at' AS provenance
    FROM ticket_intake.processed_messages m WHERE m.kind IN ('voice','text')
  UNION ALL SELECT 'transcript-'||i.id::text,'transcription','Transcript checkpoint recorded',i.transcribed_at,'/automations?intake='||i.id::text,'intakes.transcribed_at' FROM ticket_intake.intakes i WHERE i.transcribed_at IS NOT NULL
  UNION ALL SELECT 'extract-'||i.id::text,'extraction','Structured extraction validated',i.extraction_validated_at,'/automations?intake='||i.id::text,'intakes.extraction_validated_at' FROM ticket_intake.intakes i WHERE i.extraction_validated_at IS NOT NULL
  UNION ALL SELECT 'ticket-'||t.id::text,'ticket','Ticket TI-'||t.ticket_number::text||' created',t.created_at,'/tickets/'||t.id::text,'tickets.created_at' FROM ticket_intake.tickets t
  UNION ALL SELECT 'client-'||c.id::text,'client','Client record created: '||c.display_name,c.created_at,'/customers/'||c.id::text,'clients.created_at' FROM ticket_intake.clients c
  UNION ALL SELECT 'interaction-'||p.id::text,'interaction',replace(p.kind,'_',' ')||' requested from operator',p.created_at,'/automations?intake='||p.intake_id::text,'pending_interactions.created_at' FROM ticket_intake.pending_interactions p
  UNION ALL SELECT 'reply-'||p.id::text,'reply','Operator interaction resolved: '||replace(p.kind,'_',' '),p.resolved_at,'/automations?intake='||p.intake_id::text,'pending_interactions.resolved_at' FROM ticket_intake.pending_interactions p WHERE p.resolved_at IS NOT NULL
  UNION ALL SELECT 'delivery-'||o.id::text,'delivery','Telegram '||o.kind||' sent',o.sent_at,CASE WHEN o.intake_id IS NULL THEN '/automations' ELSE '/automations?intake='||o.intake_id::text END,'outbox.sent_at' FROM ticket_intake.outbox o WHERE o.status='sent' AND o.sent_at IS NOT NULL
  UNION ALL SELECT 'work-'||w.id::text,'attention',replace(w.stage,'_',' ')||' requires operator attention',w.updated_at,'/automations','work_items.updated_at (current attention state)' FROM ticket_intake.work_items w WHERE w.status='needs_operator'
) events ORDER BY "occurredAt" DESC,id DESC`;

export const healthSelect = `SELECT key,name,status,"lastSuccessAt",queued,running,failed,uncertain,"oldestAt",NULL::integer AS "averageLatencyMs",evidence FROM (
 SELECT 'telegramIngress' AS key,'Telegram Ingress' AS name,
   CASE WHEN count(*)>0 THEN 'observed' ELSE 'no_evidence' END AS status,
   max(received_at) AS "lastSuccessAt",NULL::bigint AS queued,NULL::bigint AS running,
   NULL::bigint AS failed,NULL::bigint AS uncertain,NULL::timestamptz AS "oldestAt",
   'Last persisted receipt; webhook availability is not measured.' AS evidence
 FROM ticket_intake.processed_messages
 UNION ALL
 SELECT stage,CASE stage WHEN 'download' THEN 'Intake Worker / Download' WHEN 'transcribe' THEN 'Transcription' WHEN 'extract' THEN 'Extraction' WHEN 'resolve_client' THEN 'Client Resolution' WHEN 'operator_reply' THEN 'Operator Reply' ELSE 'Ticket Finalization' END,
 CASE WHEN count(*) FILTER(WHERE status='needs_operator')>0 THEN 'needs_attention' WHEN count(*) FILTER(WHERE status='leased')>0 THEN 'running' WHEN count(*) FILTER(WHERE status='queued')>0 THEN 'queued' WHEN count(*) FILTER(WHERE status='succeeded')>0 THEN 'observed' ELSE 'no_evidence' END,
 max(updated_at) FILTER(WHERE status='succeeded'),count(*) FILTER(WHERE status='queued'),count(*) FILTER(WHERE status='leased'),count(*) FILTER(WHERE status='needs_operator'),NULL::bigint,
 min(created_at) FILTER(WHERE status IN ('queued','leased','needs_operator')),
 'Persisted worker state. Needs attention counts operator-held work, not provider outages.'
 FROM (SELECT stages.stage,w.status,w.created_at,w.updated_at FROM (VALUES ('download'),('transcribe'),('extract'),('resolve_client'),('operator_reply'),('finalize')) stages(stage) LEFT JOIN ticket_intake.work_items w ON w.stage=stages.stage) work GROUP BY stage
 UNION ALL
 SELECT 'telegramOutbox','Telegram Outbox',CASE WHEN count(*) FILTER(WHERE status IN ('needs_operator','uncertain'))>0 THEN 'needs_attention' WHEN count(*) FILTER(WHERE status='leased')>0 THEN 'running' WHEN count(*) FILTER(WHERE status='queued')>0 THEN 'queued' WHEN count(*) FILTER(WHERE status='sent')>0 THEN 'observed' ELSE 'no_evidence' END,
 max(sent_at) FILTER(WHERE status='sent'),count(*) FILTER(WHERE status='queued'),count(*) FILTER(WHERE status='leased'),count(*) FILTER(WHERE status='needs_operator'),count(*) FILTER(WHERE status='uncertain'),min(created_at) FILTER(WHERE status IN ('queued','leased','needs_operator','uncertain')),
 'Sent is confirmed; uncertain requires verification before retry.' FROM ticket_intake.outbox
 UNION ALL SELECT 'retention','Retention',CASE WHEN max(audio_purged_at) IS NULL THEN 'no_evidence' ELSE 'observed' END,max(audio_purged_at),NULL::bigint,NULL::bigint,NULL::bigint,NULL::bigint,NULL::timestamptz,'Last persisted audio purge; recovery scheduler availability is not measured.' FROM ticket_intake.intakes
) services`;

export function rowsJson(select: string) { return `(SELECT coalesce(jsonb_agg(to_jsonb(record)), '[]'::jsonb) FROM (${select}) record)`; }
