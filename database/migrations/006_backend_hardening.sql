-- 006 backend hardening. psql -v migration_sha256=<exact file SHA-256>.
BEGIN;
DO $$ BEGIN IF current_user<>'ticket_owner' OR current_database()<>'ticket_system' OR current_setting('server_version_num')::integer/10000<>18 THEN RAISE EXCEPTION '006 requires ticket_owner, ticket_system, PostgreSQL 18'; END IF; END $$;
-- Source fragment for generation of migration 006. Never apply this fragment.
CREATE TABLE IF NOT EXISTS ticket_intake.backend_policy (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 interaction_ttl_hours integer NOT NULL DEFAULT 48 CHECK(interaction_ttl_hours BETWEEN 1 AND 720),
 audio_hard_ttl_hours integer NOT NULL DEFAULT 72 CHECK(audio_hard_ttl_hours BETWEEN 1 AND 72),
 audio_success_grace_minutes integer NOT NULL DEFAULT 60 CHECK(audio_success_grace_minutes BETWEEN 1 AND 4320),
 batch_limit integer NOT NULL DEFAULT 50 CHECK(batch_limit BETWEEN 1 AND 100),
 last_maintenance_at timestamptz,
 last_maintenance_counts jsonb
);
INSERT INTO ticket_intake.backend_policy(singleton) VALUES(true) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS ticket_intake.migration_history (
 version integer PRIMARY KEY CHECK(version>0),filename text NOT NULL UNIQUE,
 sha256 text NOT NULL CHECK(sha256 ~ '^[0-9a-f]{64}$'),
 verification text NOT NULL CHECK(verification IN ('legacy_source_verified','applied')),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE OR REPLACE FUNCTION ticket_intake.backend_record_migration(p_version integer,p_file text,p_hash text,p_verification text)
RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE previous ticket_intake.migration_history%ROWTYPE;
BEGIN
 IF p_hash IS NULL OR p_hash !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'invalid migration checksum'; END IF;
 SELECT * INTO previous FROM ticket_intake.migration_history WHERE version=p_version FOR UPDATE;
 IF FOUND THEN
   IF previous.filename<>p_file OR previous.sha256<>p_hash OR previous.verification<>p_verification THEN
     RAISE EXCEPTION 'conflicting migration history'; END IF;
 ELSE INSERT INTO ticket_intake.migration_history(version,filename,sha256,verification)
   VALUES(p_version,p_file,p_hash,p_verification); END IF;
END $$;
CREATE OR REPLACE FUNCTION ticket_intake.backend_expiry_deadline() RETURNS timestamptz
LANGUAGE sql VOLATILE SET search_path=pg_catalog,pg_temp AS $$
 SELECT clock_timestamp()+make_interval(hours=>interaction_ttl_hours) FROM ticket_intake.backend_policy WHERE singleton
$$;
ALTER TABLE ticket_intake.pending_interactions ADD COLUMN IF NOT EXISTS expires_at timestamptz;
ALTER TABLE ticket_intake.pending_interactions ADD COLUMN IF NOT EXISTS expired_at timestamptz;
UPDATE ticket_intake.pending_interactions SET expires_at=created_at+make_interval(hours=>
 (SELECT interaction_ttl_hours FROM ticket_intake.backend_policy WHERE singleton)) WHERE expires_at IS NULL;
ALTER TABLE ticket_intake.pending_interactions ALTER COLUMN expires_at SET NOT NULL;
ALTER TABLE ticket_intake.pending_interactions ALTER COLUMN expires_at SET DEFAULT ticket_intake.backend_expiry_deadline();
ALTER TABLE ticket_intake.pending_interactions DROP CONSTRAINT IF EXISTS pending_interactions_status_check;
ALTER TABLE ticket_intake.pending_interactions ADD CONSTRAINT pending_interactions_status_check
 CHECK(status IN ('open','resolved','cancelled','expired'));
ALTER TABLE ticket_intake.pending_interactions DROP CONSTRAINT IF EXISTS interaction_expiry_timestamp;
ALTER TABLE ticket_intake.pending_interactions ADD CONSTRAINT interaction_expiry_timestamp
 CHECK((status='expired')=(expired_at IS NOT NULL));
CREATE INDEX IF NOT EXISTS interactions_expiry ON ticket_intake.pending_interactions(expires_at,id) WHERE status='open';
-- Shared email across clients remains allowed; duplicate active email within one client does not.
CREATE UNIQUE INDEX IF NOT EXISTS contact_active_client_email ON ticket_intake.client_contacts(client_id,email_norm) WHERE active;

ALTER TABLE ticket_intake.outbox ADD COLUMN IF NOT EXISTS parent_outbox_id uuid REFERENCES ticket_intake.outbox(id);
CREATE UNIQUE INDEX IF NOT EXISTS outbox_one_admin_retry ON ticket_intake.outbox(parent_outbox_id) WHERE parent_outbox_id IS NOT NULL;
ALTER TABLE ticket_intake.outbox DROP CONSTRAINT IF EXISTS outbox_status_check;
ALTER TABLE ticket_intake.outbox ADD CONSTRAINT outbox_status_check
 CHECK(status IN ('queued','leased','sent','uncertain','needs_operator','cancelled','delivered_admin','retry_authorized'));
CREATE TABLE IF NOT EXISTS ticket_intake.delivery_admin_actions (
 request_id uuid PRIMARY KEY,
 outbox_id uuid NOT NULL REFERENCES ticket_intake.outbox(id),
 action text NOT NULL CHECK(action IN ('mark_delivered','retry_once','cancel')),
 actor_id text NOT NULL CHECK(length(btrim(actor_id)) BETWEEN 1 AND 200),
 performed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 supplied_message_id bigint CHECK(supplied_message_id>0),
 child_outbox_id uuid REFERENCES ticket_intake.outbox(id),
 outcome jsonb NOT NULL
);

CREATE OR REPLACE FUNCTION ticket_intake.run_backend_maintenance(p_bot bigint,p_user bigint,p_chat bigint,p_limit integer DEFAULT 50)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE cfg ticket_intake.backend_policy%ROWTYPE; p ticket_intake.pending_interactions%ROWTYPE;
 i ticket_intake.intakes%ROWTYPE; candidate uuid; pc integer:=0; ec integer:=0; has_open boolean; locked uuid;
BEGIN
 IF p_bot IS NULL OR p_bot<=0 OR p_user IS NULL OR p_user<=0 OR p_chat IS NULL OR p_chat<=0
   OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN
   RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid maintenance scope'; END IF;
 SELECT * INTO STRICT cfg FROM ticket_intake.backend_policy WHERE singleton;
 p_limit:=LEAST(p_limit,cfg.batch_limit);
 IF NOT pg_try_advisory_xact_lock(hashtextextended('ticket-maintenance:'||p_bot||':'||p_user||':'||p_chat,0)) THEN
   RETURN jsonb_build_object('outcome','busy','purgedAudio',0,'expiredInteractions',0); END IF;
 FOR p IN SELECT * FROM ticket_intake.pending_interactions
   WHERE status='open' AND bot_id=p_bot AND operator_user_id=p_user AND operator_chat_id=p_chat
     AND expires_at<=clock_timestamp() ORDER BY expires_at,id FOR UPDATE SKIP LOCKED LIMIT p_limit LOOP
   SELECT * INTO i FROM ticket_intake.intakes WHERE id=p.intake_id FOR UPDATE SKIP LOCKED;
   IF NOT FOUND THEN CONTINUE; END IF;
   UPDATE ticket_intake.pending_interactions SET status='expired',expired_at=clock_timestamp() WHERE id=p.id;
   IF i.state IN ('awaiting_email','awaiting_client_selection','awaiting_details','awaiting_priority_confirmation') THEN
     UPDATE ticket_intake.intakes SET state='needs_operator',revision=revision+1,
       last_error_code='interaction_expired',last_error_summary='operator response deadline expired' WHERE id=i.id;
   END IF;
   -- Unsent obsolete prompts are closed, not delivered later. Possible sends are never retried.
   UPDATE ticket_intake.outbox SET status='cancelled' WHERE interaction_id=p.id AND status='queued';
   ec:=ec+1;
 END LOOP;
 FOR candidate IN SELECT id FROM ticket_intake.intakes x
   WHERE x.bot_id=p_bot AND x.operator_user_id=p_user AND x.operator_chat_id=p_chat AND x.audio_bytes IS NOT NULL
     AND LEAST(x.audio_purge_after,x.audio_stored_at+make_interval(hours=>cfg.audio_hard_ttl_hours),
       CASE WHEN x.transcript_original IS NOT NULL THEN COALESCE(x.extraction_validated_at,x.transcribed_at)+make_interval(mins=>cfg.audio_success_grace_minutes) ELSE NULL END)<=clock_timestamp()
   ORDER BY x.audio_purge_after,x.id LIMIT p_limit LOOP
   -- Match reply-worker lock order; skip contested pending/intake rows instead of waiting.
   SELECT EXISTS(SELECT 1 FROM ticket_intake.pending_interactions WHERE intake_id=candidate AND status='open') INTO has_open;
   IF has_open THEN
     SELECT id INTO locked FROM ticket_intake.pending_interactions WHERE intake_id=candidate AND status='open' FOR UPDATE SKIP LOCKED;
     IF NOT FOUND THEN CONTINUE; END IF;
   END IF;
   SELECT * INTO i FROM ticket_intake.intakes WHERE id=candidate AND audio_bytes IS NOT NULL FOR UPDATE SKIP LOCKED;
   IF NOT FOUND OR EXISTS(SELECT 1 FROM ticket_intake.work_items WHERE intake_id=candidate AND status='leased' AND lease_expires_at>clock_timestamp()) THEN CONTINUE; END IF;
   IF LEAST(i.audio_purge_after,i.audio_stored_at+make_interval(hours=>cfg.audio_hard_ttl_hours),
       CASE WHEN i.transcript_original IS NOT NULL THEN COALESCE(i.extraction_validated_at,i.transcribed_at)+make_interval(mins=>cfg.audio_success_grace_minutes) ELSE NULL END)>clock_timestamp() THEN CONTINUE; END IF;
   UPDATE ticket_intake.intakes SET audio_bytes=NULL,audio_purged_at=clock_timestamp(),
     audio_purge_reason=CASE WHEN transcript_original IS NULL THEN 'hard_retention_expired_before_transcription' ELSE 'retention_elapsed' END,
     state=CASE WHEN transcript_original IS NULL AND state NOT IN ('cancelled','completed') THEN 'needs_operator' ELSE state END,
     last_error_code=CASE WHEN transcript_original IS NULL THEN 'audio_expired' ELSE last_error_code END,
     last_error_summary=CASE WHEN transcript_original IS NULL THEN 'audio retention expired before transcription' ELSE last_error_summary END,
     revision=CASE WHEN transcript_original IS NULL THEN revision+1 ELSE revision END
     WHERE id=candidate;
   -- Audio-only deletion does not invalidate a valid pending interaction/business revision.
   IF i.transcript_original IS NULL THEN
     UPDATE ticket_intake.work_items SET status='needs_operator',lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,
       last_failure_class='invalid_input',last_error_code='audio_expired',last_error_summary='audio retention expired before transcription'
       WHERE intake_id=candidate AND stage IN ('download','transcribe','extract') AND status IN ('queued','leased');
   END IF;
   pc:=pc+1;
 END LOOP;
 UPDATE ticket_intake.backend_policy SET last_maintenance_at=clock_timestamp(),last_maintenance_counts=
   jsonb_build_object('purgedAudio',pc,'expiredInteractions',ec) WHERE singleton;
 RETURN jsonb_build_object('outcome','completed','purgedAudio',pc,'expiredInteractions',ec,'at',clock_timestamp());
END $$;

CREATE OR REPLACE FUNCTION ticket_intake.admin_uncertain_deliveries(p_bot bigint,p_chat bigint,p_limit integer DEFAULT 50)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE result jsonb;
BEGIN
 IF p_bot IS NULL OR p_bot<=0 OR p_chat IS NULL OR p_chat<=0 OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN
   RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid admin read scope'; END IF;
 SELECT COALESCE(jsonb_agg(jsonb_build_object('id',id,'state',status,'reasonCode',last_error_code,
   'summary',last_error_summary,'lastAttemptAt',dispatch_started_at,'destinationChatId',operator_chat_id::text,
   'intakeId',intake_id,'ticketId',ticket_id,'messageType',kind,'telegramMessageId',telegram_message_id::text,
   'version',updated_at,'retryOf',parent_outbox_id) ORDER BY created_at,id),'[]') INTO result
 FROM (SELECT * FROM ticket_intake.outbox WHERE bot_id=p_bot AND operator_chat_id=p_chat
   AND status='uncertain' ORDER BY created_at,id LIMIT p_limit) x;
 RETURN jsonb_build_object('items',result);
END $$;

CREATE OR REPLACE FUNCTION ticket_intake.admin_reconcile_delivery(p_id uuid,p_action text,p_actor text,
 p_request uuid,p_expected timestamptz,p_receipt bigint DEFAULT NULL,p_ack_duplicate boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE old ticket_intake.delivery_admin_actions%ROWTYPE; o ticket_intake.outbox%ROWTYPE; child uuid; result jsonb;
BEGIN
 IF p_id IS NULL OR p_request IS NULL OR p_expected IS NULL OR p_action IS NULL
   OR p_action NOT IN ('mark_delivered','retry_once','cancel') OR p_actor IS NULL OR length(btrim(p_actor)) NOT BETWEEN 1 AND 200
   OR (p_receipt IS NOT NULL AND p_receipt<=0) THEN
   RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid administrative action'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('ticket-admin-request:'||p_request,0));
 SELECT * INTO old FROM ticket_intake.delivery_admin_actions WHERE request_id=p_request;
 IF FOUND THEN
   IF old.outbox_id<>p_id OR old.action<>p_action OR old.actor_id<>p_actor OR old.supplied_message_id IS DISTINCT FROM p_receipt THEN
     RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='conflicting administrative request replay'; END IF;
   RETURN old.outcome||jsonb_build_object('replayed',true);
 END IF;
 SELECT * INTO o FROM ticket_intake.outbox WHERE id=p_id FOR UPDATE;
 IF NOT FOUND OR o.status<>'uncertain' OR o.updated_at IS DISTINCT FROM p_expected THEN
   RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='stale_delivery_version'; END IF;
 IF p_action='retry_once' THEN
   IF p_ack_duplicate IS DISTINCT FROM true OR p_receipt IS NOT NULL THEN
     RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='explicit duplicate-risk acknowledgement required'; END IF;
   IF o.interaction_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM ticket_intake.pending_interactions
       WHERE id=o.interaction_id AND status='open' AND expires_at>clock_timestamp()) THEN
     RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='obsolete prompt cannot be retried'; END IF;
   INSERT INTO ticket_intake.outbox(intake_id,ticket_id,interaction_id,bot_id,operator_chat_id,kind,delivery_key,payload,max_attempts,parent_outbox_id)
     VALUES(o.intake_id,o.ticket_id,o.interaction_id,o.bot_id,o.operator_chat_id,o.kind,'admin-retry:'||o.id,o.payload,1,o.id)
     RETURNING id INTO child;
   UPDATE ticket_intake.outbox SET status='retry_authorized' WHERE id=o.id;
 ELSIF p_action='mark_delivered' THEN
   -- Keep original receipt/dispatch/error history; evidence is recorded in the audit row.
   UPDATE ticket_intake.outbox SET status='delivered_admin' WHERE id=o.id;
 ELSE UPDATE ticket_intake.outbox SET status='cancelled' WHERE id=o.id;
 END IF;
 result:=jsonb_build_object('id',o.id,'action',p_action,'state',CASE p_action WHEN 'retry_once' THEN 'retry_authorized'
   WHEN 'mark_delivered' THEN 'delivered_admin' ELSE 'cancelled' END,'newDeliveryId',child,'requestId',p_request,'at',clock_timestamp());
 INSERT INTO ticket_intake.delivery_admin_actions(request_id,outbox_id,action,actor_id,supplied_message_id,child_outbox_id,outcome)
   VALUES(p_request,o.id,p_action,p_actor,p_receipt,child,result);
 RETURN result;
END $$;

CREATE OR REPLACE FUNCTION ticket_intake.automation_health(p_bot bigint,p_user bigint,p_chat bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE r jsonb;
BEGIN
 IF p_bot IS NULL OR p_bot<=0 OR p_user IS NULL OR p_user<=0 OR p_chat IS NULL OR p_chat<=0 THEN
   RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid health scope'; END IF;
 WITH msgs AS(SELECT * FROM ticket_intake.processed_messages WHERE bot_id=p_bot AND operator_user_id=p_user AND chat_id=p_chat),
 ins AS(SELECT * FROM ticket_intake.intakes WHERE bot_id=p_bot AND operator_user_id=p_user AND operator_chat_id=p_chat),
 w AS(SELECT * FROM ticket_intake.work_items WHERE intake_id IN(SELECT id FROM ins) OR message_id IN(SELECT id FROM msgs)),
 o AS(SELECT * FROM ticket_intake.outbox WHERE bot_id=p_bot AND operator_chat_id=p_chat),
 p AS(SELECT * FROM ticket_intake.pending_interactions WHERE bot_id=p_bot AND operator_user_id=p_user AND operator_chat_id=p_chat),
 t AS(SELECT * FROM ticket_intake.tickets WHERE intake_id IN(SELECT id FROM ins))
 SELECT jsonb_build_object('schemaVersion','automation-health-1','at',clock_timestamp(),
 'work',jsonb_build_object('queuedByKind',(SELECT COALESCE(jsonb_object_agg(stage,n),'{}') FROM(SELECT stage,count(*) n FROM w WHERE status='queued' GROUP BY stage) a),
   'failed',(SELECT count(*) FROM w WHERE status='needs_operator'),'leased',(SELECT count(*) FROM w WHERE status='leased'),
   'expiredLeases',(SELECT count(*) FROM w WHERE status='leased' AND lease_expires_at<=clock_timestamp()),
   'oldestQueuedAgeSeconds',(SELECT extract(epoch FROM clock_timestamp()-min(created_at)) FROM w WHERE status='queued'),
   'attemptsDistribution',(SELECT COALESCE(jsonb_object_agg(attempt_count,n),'{}') FROM(SELECT attempt_count,count(*) n FROM w GROUP BY attempt_count) a)),
 'outbox',jsonb_build_object('queued',(SELECT count(*) FROM o WHERE status='queued'),'sending',(SELECT count(*) FROM o WHERE status='leased'),
   'sent',(SELECT count(*) FROM o WHERE status='sent'),'failed',(SELECT count(*) FROM o WHERE status='needs_operator'),
   'uncertain',(SELECT count(*) FROM o WHERE status='uncertain'),'administrativelyDelivered',(SELECT count(*) FROM o WHERE status='delivered_admin'),
   'oldestPendingAgeSeconds',(SELECT extract(epoch FROM clock_timestamp()-min(created_at)) FROM o WHERE status IN ('queued','leased','uncertain'))),
 'interactions',jsonb_build_object('open',(SELECT count(*) FROM p WHERE status='open' AND expires_at>clock_timestamp()),
   'expired',(SELECT count(*) FROM p WHERE status='expired'),'overdue',(SELECT count(*) FROM p WHERE status='open' AND expires_at<=clock_timestamp()),
   'ambiguous',(SELECT CASE WHEN count(*)>1 THEN 1 ELSE 0 END FROM p WHERE status='open' AND expires_at>clock_timestamp()),
   'oldestOpenAgeSeconds',(SELECT extract(epoch FROM clock_timestamp()-min(created_at)) FROM p WHERE status='open' AND expires_at>clock_timestamp())),
 'intakes',jsonb_build_object('processing',(SELECT count(*) FROM ins WHERE state IN ('received','downloading','audio_ready','transcribing','transcribed','extracting','extracted','resolving_client','ready_to_create','retry_pending')),
   'awaitingOperator',(SELECT count(*) FROM ins WHERE state LIKE 'awaiting_%'),'completed',(SELECT count(*) FROM ins WHERE state='completed'),
   'failed',(SELECT count(*) FROM ins WHERE state='needs_operator')),
 'lastSuccess',jsonb_build_object('ingress',(SELECT max(received_at) FROM msgs),'transcription',(SELECT max(transcribed_at) FROM ins),
   'extraction',(SELECT max(extraction_validated_at) FROM ins),'ticket',(SELECT max(created_at) FROM t),'telegramSend',(SELECT max(sent_at) FROM o WHERE status='sent')),
 'latencySeconds',jsonb_build_object('ingressToExtraction',(SELECT jsonb_build_object('mean',avg(extract(epoch FROM extraction_validated_at-created_at)),'p95',percentile_cont(0.95) WITHIN GROUP(ORDER BY extract(epoch FROM extraction_validated_at-created_at))) FROM ins WHERE extraction_validated_at IS NOT NULL),
   'extractionToResolution',(SELECT avg(extract(epoch FROM w.updated_at-i.extraction_validated_at)) FROM ins i JOIN w ON w.intake_id=i.id AND w.stage='resolve_client' AND w.status='succeeded'),
   'ingressToTicket',(SELECT avg(extract(epoch FROM t.created_at-i.created_at)) FROM ins i JOIN t ON t.intake_id=i.id)),
 'retention',jsonb_build_object('audioRemaining',(SELECT count(*) FROM ins WHERE audio_bytes IS NOT NULL),'audioPurged',(SELECT count(*) FROM ins WHERE audio_purged_at IS NOT NULL),
   'lastMaintenanceAt',(SELECT last_maintenance_at FROM ticket_intake.backend_policy WHERE singleton))) INTO r;
 RETURN r;
END $$;

GRANT USAGE ON SCHEMA ticket_intake TO ticket_backend_read,ticket_backend_admin;
GRANT CONNECT ON DATABASE ticket_system TO ticket_backend_read,ticket_backend_admin;
REVOKE ALL ON TABLE ticket_intake.backend_policy,ticket_intake.migration_history,ticket_intake.delivery_admin_actions FROM PUBLIC,ticket_n8n,ticket_backend_read,ticket_backend_admin;
REVOKE ALL ON FUNCTION ticket_intake.backend_expiry_deadline(),ticket_intake.run_backend_maintenance(bigint,bigint,bigint,integer),
 ticket_intake.backend_record_migration(integer,text,text,text),
 ticket_intake.admin_uncertain_deliveries(bigint,bigint,integer),ticket_intake.admin_reconcile_delivery(uuid,text,text,uuid,timestamptz,bigint,boolean),
 ticket_intake.automation_health(bigint,bigint,bigint) FROM PUBLIC,ticket_n8n,ticket_backend_read,ticket_backend_admin;
GRANT EXECUTE ON FUNCTION ticket_intake.run_backend_maintenance(bigint,bigint,bigint,integer) TO ticket_n8n;
GRANT EXECUTE ON FUNCTION ticket_intake.automation_health(bigint,bigint,bigint) TO ticket_backend_read,ticket_backend_admin;
GRANT EXECUTE ON FUNCTION ticket_intake.admin_uncertain_deliveries(bigint,bigint,integer),
 ticket_intake.admin_reconcile_delivery(uuid,text,text,uuid,timestamptz,bigint,boolean) TO ticket_backend_admin;

-- Expiry guard only; all existing V1 business logic retained.
CREATE OR REPLACE FUNCTION ticket_intake.v1_wait(p_intake uuid,p_kind text,p_context jsonb,p_text text)
RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE i ticket_intake.intakes%ROWTYPE; x ticket_intake.pending_interactions%ROWTYPE; s text;
BEGIN
 SELECT * INTO STRICT i FROM ticket_intake.intakes WHERE id=p_intake FOR UPDATE;
 s:=CASE p_kind WHEN 'email' THEN 'awaiting_email' WHEN 'client_selection' THEN 'awaiting_client_selection'
   WHEN 'priority_confirmation' THEN 'awaiting_priority_confirmation' ELSE NULL END;
 IF s IS NULL THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='unsupported interaction'; END IF;
 SELECT * INTO x FROM ticket_intake.pending_interactions WHERE intake_id=i.id AND status='open' FOR UPDATE;
 IF x.id IS NOT NULL THEN
   IF x.expires_at<=clock_timestamp() OR x.kind<>p_kind OR x.context IS DISTINCT FROM p_context OR x.expected_intake_revision<>i.revision THEN
     RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='conflicting interaction'; END IF;
 ELSE
   UPDATE ticket_intake.intakes SET state=s,revision=revision+1 WHERE id=i.id RETURNING * INTO i;
   INSERT INTO ticket_intake.pending_interactions(intake_id,bot_id,operator_user_id,operator_chat_id,
     kind,expected_intake_revision,context)
   VALUES(i.id,i.bot_id,i.operator_user_id,i.operator_chat_id,p_kind,i.revision,p_context)
   RETURNING * INTO x;
 END IF;
 PERFORM ticket_intake.v1_enqueue(i.id,x.id,NULL,'prompt','interaction:'||x.id::text,p_text,true);
 RETURN jsonb_build_object('outcome','waiting','intakeId',i.id,'interactionId',x.id,'state',s,'revision',i.revision::text);
END $$;

CREATE OR REPLACE FUNCTION ticket_intake.process_v1_work(p_work uuid,p_token uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE w ticket_intake.work_items%ROWTYPE; i ticket_intake.intakes%ROWTYPE;
 m ticket_intake.processed_messages%ROWTYPE; x ticket_intake.pending_interactions%ROWTYPE;
 receipt jsonb; count_pending integer; selection uuid; n integer; email text; text_value text;
BEGIN
 SELECT * INTO w FROM ticket_intake.work_items WHERE id=p_work FOR UPDATE;
 IF w.status='succeeded' AND p_token IS NOT NULL AND w.completed_lease_token=p_token THEN
   RETURN w.checkpoint_receipt||jsonb_build_object('outcome','already_applied'); END IF;
 IF w.id IS NULL OR w.stage NOT IN ('resolve_client','operator_reply') OR w.status<>'leased'
   OR p_token IS NULL OR w.lease_token IS DISTINCT FROM p_token OR w.lease_expires_at<=clock_timestamp() THEN
   RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='stale_lease'; END IF;
 IF w.stage='resolve_client' THEN
   SELECT * INTO STRICT i FROM ticket_intake.intakes WHERE id=w.intake_id;
   PERFORM pg_advisory_xact_lock(hashtextextended('ticket-v1:'||i.bot_id||':'||i.operator_user_id||':'||i.operator_chat_id,0));
   SELECT * INTO STRICT i FROM ticket_intake.intakes WHERE id=w.intake_id FOR UPDATE;
   IF i.revision IS DISTINCT FROM w.stage_revision OR i.state NOT IN ('extracted','retry_pending','resolving_client') THEN
     RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='stale_lease'; END IF;
   receipt:=ticket_intake.v1_resolve(i.id);
 ELSE
   SELECT * INTO STRICT m FROM ticket_intake.processed_messages WHERE id=w.message_id FOR UPDATE;
   PERFORM pg_advisory_xact_lock(hashtextextended('ticket-v1:'||m.bot_id||':'||m.operator_user_id||':'||m.chat_id,0));
   IF m.kind<>'text' OR m.status<>'received' THEN
     RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid operator reply work'; END IF;
   IF m.reply_to_message_id IS NOT NULL THEN
     SELECT count(DISTINCT p.id),(array_agg(DISTINCT p.id))[1] INTO count_pending,selection
     FROM ticket_intake.pending_interactions p JOIN ticket_intake.outbox o ON o.interaction_id=p.id
     WHERE p.status='open' AND p.expires_at>clock_timestamp() AND p.bot_id=m.bot_id AND p.operator_user_id=m.operator_user_id
       AND p.operator_chat_id=m.chat_id AND p.created_at<=m.received_at
       AND o.status='sent' AND o.telegram_message_id=m.reply_to_message_id;
   ELSE
     SELECT count(*),(array_agg(id))[1] INTO count_pending,selection FROM ticket_intake.pending_interactions
     WHERE status='open' AND expires_at>clock_timestamp() AND bot_id=m.bot_id AND operator_user_id=m.operator_user_id
       AND operator_chat_id=m.chat_id AND created_at<=m.received_at;
   END IF;
   IF count_pending=0 THEN
     UPDATE ticket_intake.processed_messages SET status='ignored',handled_at=clock_timestamp() WHERE id=m.id;
     receipt:=jsonb_build_object('outcome','ignored','reason','no_matching_interaction');
   ELSIF count_pending<>1 THEN
     INSERT INTO ticket_intake.outbox(bot_id,operator_chat_id,kind,delivery_key,payload,max_attempts)
     VALUES(m.bot_id,m.chat_id,'status','reply-correlation:'||m.id::text,
       jsonb_build_object('text','❓ Hay varias solicitudes pendientes. Usa Responder sobre el mensaje concreto que quieres contestar.','forceReply',false),5)
     ON CONFLICT(delivery_key) DO NOTHING;
     UPDATE ticket_intake.processed_messages SET status='needs_operator',handled_at=clock_timestamp() WHERE id=m.id;
     receipt:=jsonb_build_object('outcome','needs_operator','reason','ambiguous_reply');
   ELSE
     SELECT * INTO STRICT x FROM ticket_intake.pending_interactions WHERE id=selection FOR UPDATE;
     SELECT * INTO STRICT i FROM ticket_intake.intakes WHERE id=x.intake_id FOR UPDATE;
     IF x.status<>'open' OR x.expires_at<=clock_timestamp() OR x.expected_intake_revision<>i.revision
       OR i.bot_id<>m.bot_id OR i.operator_user_id<>m.operator_user_id OR i.operator_chat_id<>m.chat_id
       OR i.state IS DISTINCT FROM (CASE x.kind WHEN 'email' THEN 'awaiting_email'
         WHEN 'client_selection' THEN 'awaiting_client_selection' WHEN 'priority_confirmation' THEN 'awaiting_priority_confirmation' ELSE NULL END) THEN
       RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='stale_interaction'; END IF;
     text_value:=btrim(m.text_content); email:=ticket_intake.v1_email(text_value); selection:=NULL;
     IF x.kind='email' AND email IS NULL THEN
       PERFORM ticket_intake.v1_enqueue(i.id,x.id,NULL,'prompt','invalid-email:'||m.id::text,
         '❌ El correo no parece válido. Envíame un correo electrónico válido para continuar.',true);
       receipt:=jsonb_build_object('outcome','invalid_email','intakeId',i.id,'interactionId',x.id);
     ELSIF x.kind='client_selection' AND (CASE WHEN text_value ~ '^[1-9][0-9]?$'
       THEN text_value::integer>jsonb_array_length(x.context->'candidates') ELSE true END) THEN
       PERFORM ticket_intake.v1_enqueue(i.id,x.id,NULL,'prompt','invalid-selection:'||m.id::text,
         '❌ Responde con uno de los números de cliente indicados.',true);
       receipt:=jsonb_build_object('outcome','invalid_selection','intakeId',i.id,'interactionId',x.id);
     ELSIF x.kind='priority_confirmation' AND upper(text_value) NOT IN ('CONFIRMAR','NORMAL') THEN
       PERFORM ticket_intake.v1_enqueue(i.id,x.id,NULL,'prompt','invalid-priority:'||m.id::text,
         '❌ Responde CONFIRMAR o NORMAL.',true);
       receipt:=jsonb_build_object('outcome','invalid_priority','intakeId',i.id,'interactionId',x.id);
     ELSE
       UPDATE ticket_intake.pending_interactions SET status='resolved',response_message_id=m.id,
         response_value=CASE WHEN x.kind='email' THEN jsonb_build_object('email',email) ELSE jsonb_build_object('selection',text_value) END,
         resolved_at=clock_timestamp() WHERE id=x.id;
       UPDATE ticket_intake.intakes SET identity_confirmed_by_message_id=CASE WHEN x.kind IN ('email','client_selection') THEN m.id ELSE identity_confirmed_by_message_id END WHERE id=i.id;
       IF x.kind='email' THEN
         UPDATE ticket_intake.intakes SET email_original=text_value,email_norm=email,email_source='operator',
           email_validated_at=clock_timestamp() WHERE id=i.id;
         selection:=(x.context->>'selectedClientId')::uuid;
         receipt:=ticket_intake.v1_resolve(i.id,selection);
       ELSIF x.kind='client_selection' THEN
         selection:=(x.context->'candidates'->(text_value::integer-1)->>'id')::uuid;
         receipt:=ticket_intake.v1_resolve(i.id,selection);
       ELSE
         UPDATE ticket_intake.intakes SET final_priority=CASE WHEN upper(text_value)='CONFIRMAR' THEN 'critical' ELSE 'normal' END,
           priority_confirmed_by_message_id=CASE WHEN upper(text_value)='CONFIRMAR' THEN m.id ELSE NULL END WHERE id=i.id;
         receipt:=ticket_intake.v1_finalize(i.id);
       END IF;
     END IF;
     UPDATE ticket_intake.processed_messages SET status='handled',handled_at=clock_timestamp(),intake_id=i.id WHERE id=m.id;
   END IF;
 END IF;
 IF w.lease_expires_at<=clock_timestamp() THEN RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='stale_lease'; END IF;
 receipt:=receipt||jsonb_build_object('workId',w.id);
 UPDATE ticket_intake.work_items SET status='succeeded',completed_lease_token=p_token,
   checkpoint_receipt=receipt,lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL WHERE id=w.id;
 RETURN receipt;
END $$;

SELECT ticket_intake.backend_record_migration(1,'001_schema.sql','e46697eda8160a060fc740fadd54ecf8997dc7dbaf85dd4c693c405879e33fb8','legacy_source_verified');
SELECT ticket_intake.backend_record_migration(2,'002_phase1_operations.sql','01f1e43cc93515a8d4ea083c62d91d081c2aff5bf23380721104b86173ed459c','legacy_source_verified');
SELECT ticket_intake.backend_record_migration(3,'003_grants.sql','1ce1a06b91abe1a339e5405550d0ec0252a629e94693a3a37112a394fa48535a','legacy_source_verified');
SELECT ticket_intake.backend_record_migration(4,'004_phase2a_worker.proposed.sql','7609cf7df21b164d2a40791793d06d8e906375f9008393c8506cf98bdc83bc08','legacy_source_verified');
SELECT ticket_intake.backend_record_migration(5,'005_v1_completion.sql','81569491dce0d4965b5585e3a8fbaa45273602b5a489c397ffeadcc9c3bde959','legacy_source_verified');
SELECT ticket_intake.backend_record_migration(6,'006_backend_hardening.sql',:'migration_sha256','applied');
COMMIT;
