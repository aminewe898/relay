-- V1 completion. Apply as ticket_owner after isolated validation. No seed data.
-- Existing ingress/Phase-2 functions and retention policy are deliberately unchanged.
BEGIN;
DO $$ BEGIN
  IF current_user <> 'ticket_owner' OR current_database() <> 'ticket_system'
    OR current_setting('server_version_num')::integer / 10000 <> 18 THEN
    RAISE EXCEPTION '005 requires ticket_owner, ticket_system, PostgreSQL 18';
  END IF;
END $$;

ALTER TABLE ticket_intake.outbox
  ADD COLUMN IF NOT EXISTS dispatch_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS completed_lease_token uuid;

CREATE OR REPLACE FUNCTION ticket_intake.v1_name(p text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT NULLIF(lower(regexp_replace(btrim(p),'[[:space:]]+',' ','g')),'')
$$;

CREATE OR REPLACE FUNCTION ticket_intake.v1_email(p text) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
DECLARE e text:=btrim(p); l text; d text; label text;
BEGIN
 IF e IS NULL OR length(e) NOT BETWEEN 3 AND 254 OR e ~ '[[:space:]]'
   OR e !~ '^[A-Za-z0-9.!#$%&''*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+$' THEN RETURN NULL; END IF;
 l:=split_part(e,'@',1); d:=split_part(e,'@',2);
 IF length(l)>64 OR left(l,1)='.' OR right(l,1)='.' OR position('..' IN l)>0
   OR length(d)>253 OR position('.' IN d)=0 OR d !~ '\.[A-Za-z]{2,63}$' THEN RETURN NULL; END IF;
 FOREACH label IN ARRAY string_to_array(d,'.') LOOP
   IF length(label) NOT BETWEEN 1 AND 63 OR label !~ '^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$'
     THEN RETURN NULL; END IF;
 END LOOP;
 RETURN lower(e);
END $$;

CREATE OR REPLACE FUNCTION ticket_intake.v1_enqueue(p_intake uuid,p_interaction uuid,
 p_ticket uuid,p_kind text,p_key text,p_text text,p_force boolean DEFAULT false)
RETURNS uuid LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE i ticket_intake.intakes%ROWTYPE; o uuid;
BEGIN
 SELECT * INTO STRICT i FROM ticket_intake.intakes WHERE id=p_intake;
 IF length(p_text) NOT BETWEEN 1 AND 3800 OR length(p_key) NOT BETWEEN 1 AND 200
   OR p_kind NOT IN ('prompt','confirmation','status','failure','reminder') THEN
   RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid outbox payload'; END IF;
 INSERT INTO ticket_intake.outbox(intake_id,interaction_id,ticket_id,bot_id,operator_chat_id,
   kind,delivery_key,payload,max_attempts)
 VALUES(i.id,p_interaction,p_ticket,i.bot_id,i.operator_chat_id,p_kind,p_key,
   jsonb_build_object('text',p_text,'forceReply',p_force),5)
 ON CONFLICT(delivery_key) DO NOTHING RETURNING id INTO o;
 IF o IS NULL THEN SELECT id INTO STRICT o FROM ticket_intake.outbox WHERE delivery_key=p_key; END IF;
 RETURN o;
END $$;

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
   IF x.kind<>p_kind OR x.context IS DISTINCT FROM p_context OR x.expected_intake_revision<>i.revision THEN
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

CREATE OR REPLACE FUNCTION ticket_intake.v1_finalize(p_intake uuid) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE i ticket_intake.intakes%ROWTYPE; c ticket_intake.clients%ROWTYPE;
 ct ticket_intake.client_contacts%ROWTYPE; t ticket_intake.tickets%ROWTYPE; priority text; category text;
BEGIN
 SELECT * INTO STRICT i FROM ticket_intake.intakes WHERE id=p_intake FOR UPDATE;
 SELECT * INTO c FROM ticket_intake.clients WHERE id=i.client_id AND active;
 SELECT * INTO ct FROM ticket_intake.client_contacts WHERE id=i.contact_id AND client_id=i.client_id AND active;
 IF c.id IS NULL OR ct.id IS NULL OR ticket_intake.v1_email(ct.email_original) IS DISTINCT FROM ct.email_norm
   OR NOT ticket_intake.phase2_extraction_valid(i.extraction) OR i.extraction_validated_at IS NULL THEN
   RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='finalization prerequisites missing'; END IF;
 priority:=i.final_priority;
 IF priority IS NULL THEN
   priority:=i.extraction->>'prioritySuggestion';
   IF priority IS NULL OR priority='unknown' THEN priority:=i.policy_snapshot#>>'{priorityPolicy,unknownDefault}'; END IF;
   IF priority IS NULL THEN priority:='normal'; END IF;
 END IF;
 IF priority NOT IN ('low','normal','high','critical') THEN
   RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid priority policy'; END IF;
 IF priority='critical' AND i.priority_confirmed_by_message_id IS NULL THEN
   RETURN ticket_intake.v1_wait(i.id,'priority_confirmation','{}'::jsonb,
     '⚠️ Prioridad crítica sugerida. Responde CONFIRMAR para aprobarla o NORMAL para usar prioridad normal.');
 END IF;
 category:=COALESCE(i.extraction->>'category','unknown');
 INSERT INTO ticket_intake.tickets(intake_id,client_id,contact_id,summary,description,category,
   priority,technical_details,structured_data)
 VALUES(i.id,c.id,ct.id,i.extraction->>'summary',i.extraction->>'description',category,priority,
   CASE WHEN jsonb_typeof(i.extraction->'technicalDetails')='array' THEN i.extraction->'technicalDetails' ELSE '[]'::jsonb END,
   jsonb_build_object('extraction',i.extraction,'transcriptIntakeId',i.id,'schemaVersion',i.extraction_metadata->>'schemaVersion'))
 ON CONFLICT(intake_id) DO NOTHING RETURNING * INTO t;
 IF t.id IS NULL THEN
   SELECT * INTO STRICT t FROM ticket_intake.tickets WHERE intake_id=i.id;
   IF t.client_id<>c.id OR t.contact_id<>ct.id OR t.priority<>priority THEN
     RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='conflicting ticket replay'; END IF;
 END IF;
 IF i.state<>'completed' THEN
   UPDATE ticket_intake.intakes SET state='completed',final_priority=priority,revision=revision+1,
     failed_stage=NULL,last_error_code=NULL,last_error_summary=NULL WHERE id=i.id RETURNING * INTO i;
 END IF;
 PERFORM ticket_intake.v1_enqueue(i.id,NULL,t.id,'confirmation','ticket:'||t.id::text,
   '✅ Ticket creado'||E'\n\n'||'Ticket: TI-'||t.ticket_number::text||E'\nCliente: '||c.display_name||
   E'\nPrioridad: '||priority||E'\nProblema: '||t.summary,false);
 RETURN jsonb_build_object('outcome','completed','intakeId',i.id,'state',i.state,
   'revision',i.revision::text,'ticketId',t.id,'ticketNumber','TI-'||t.ticket_number::text);
END $$;

CREATE OR REPLACE FUNCTION ticket_intake.v1_resolve(p_intake uuid,p_selected uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE i ticket_intake.intakes%ROWTYPE; candidates uuid[]; cid uuid; contact uuid;
 e text; original text; source text; kind text; display text; matches jsonb; prompt text; n integer;
BEGIN
 SELECT * INTO STRICT i FROM ticket_intake.intakes WHERE id=p_intake FOR UPDATE;
 IF NOT ticket_intake.phase2_extraction_valid(i.extraction) OR i.extraction_validated_at IS NULL
   OR i.transcript_original IS NULL THEN
   RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='validated extraction required'; END IF;
 original:=COALESCE(i.email_original,i.extraction->>'email'); e:=ticket_intake.v1_email(original);
 source:=COALESCE(i.email_source,'transcript');
 IF original IS NOT NULL AND e IS NULL THEN
   -- An invalid AI suggestion never creates a contact or bypasses the email prompt.
   original:=NULL;
 END IF;
 IF e IS NOT NULL THEN
   PERFORM pg_advisory_xact_lock(hashtextextended('ticket-client-email:'||e,0));
   SELECT array_agg(DISTINCT c.id ORDER BY c.id) INTO candidates
   FROM ticket_intake.client_contacts ct JOIN ticket_intake.clients c ON c.id=ct.client_id
   WHERE c.active AND ct.active AND ct.email_norm=e;
 END IF;
 IF p_selected IS NOT NULL THEN
   IF NOT EXISTS(SELECT 1 FROM ticket_intake.clients WHERE id=p_selected AND active)
     OR (candidates IS NOT NULL AND NOT p_selected=ANY(candidates)) THEN
     RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid confirmed client'; END IF;
   cid:=p_selected;
 ELSIF cardinality(candidates)=1 THEN cid:=candidates[1];
 ELSE
   IF candidates IS NULL THEN
     IF ticket_intake.v1_name(i.extraction->>'company') IS NOT NULL THEN
       SELECT array_agg(c.id ORDER BY c.id) INTO candidates FROM ticket_intake.clients c
       WHERE c.active AND c.kind='company' AND c.name_norm=ticket_intake.v1_name(i.extraction->>'company');
     ELSIF ticket_intake.v1_name(i.extraction->>'clientName') IS NOT NULL THEN
       SELECT array_agg(DISTINCT c.id ORDER BY c.id) INTO candidates
       FROM ticket_intake.clients c LEFT JOIN ticket_intake.client_contacts ct ON ct.client_id=c.id AND ct.active
       WHERE c.active AND ((c.kind='individual' AND c.name_norm=ticket_intake.v1_name(i.extraction->>'clientName'))
         OR ct.name_norm=ticket_intake.v1_name(i.extraction->>'clientName'));
     END IF;
   END IF;
   IF cardinality(candidates)=1 THEN cid:=candidates[1];
   ELSIF cardinality(candidates)>1 THEN
     IF cardinality(candidates)>10 THEN
       UPDATE ticket_intake.intakes SET state='needs_operator',revision=revision+1,
         last_error_code='ambiguous_client',last_error_summary='client identity requires operator review' WHERE id=i.id;
       PERFORM ticket_intake.v1_enqueue(i.id,NULL,NULL,'failure','ambiguity:'||i.id::text,
         '⚠️ Demasiados clientes coinciden. La identidad requiere revisión manual.',false);
       RETURN jsonb_build_object('outcome','needs_operator','intakeId',i.id,'reason','ambiguous_client');
     END IF;
     SELECT jsonb_agg(jsonb_build_object('id',c.id,'name',c.display_name) ORDER BY c.id) INTO matches
       FROM ticket_intake.clients c WHERE c.id=ANY(candidates);
     SELECT string_agg(ord::text||'. '||left(value->>'name',100),E'\n' ORDER BY ord) INTO prompt
       FROM jsonb_array_elements(matches) WITH ORDINALITY a(value,ord);
     RETURN ticket_intake.v1_wait(i.id,'client_selection',jsonb_build_object('candidates',matches),
       '❓ Hay varios clientes posibles. Responde con el número del cliente correcto:'||E'\n'||prompt);
   END IF;
 END IF;
 IF cid IS NOT NULL AND e IS NULL THEN
   SELECT count(*), (array_agg(id ORDER BY id))[1] INTO n,contact
     FROM ticket_intake.client_contacts WHERE client_id=cid AND active
       AND ticket_intake.v1_email(email_original)=email_norm;
   IF n=1 THEN
     UPDATE ticket_intake.intakes SET client_id=cid,contact_id=contact,
       resolution_method=CASE WHEN p_selected IS NULL THEN 'exact_name' ELSE 'operator_selection' END WHERE id=i.id;
     RETURN ticket_intake.v1_finalize(i.id);
   END IF;
 END IF;
 IF e IS NULL THEN
   RETURN ticket_intake.v1_wait(i.id,'email',jsonb_build_object('selectedClientId',cid),
     '❓ Falta el correo electrónico del cliente.'||E'\n\nCliente: '||
     COALESCE(i.extraction->>'company',i.extraction->>'clientName','Sin identificar')||
     E'\nProblema: '||(i.extraction->>'summary')||E'\n\nResponde con el correo electrónico del cliente.');
 END IF;
 IF cid IS NULL THEN
   kind:=CASE WHEN ticket_intake.v1_name(i.extraction->>'company') IS NULL THEN 'individual' ELSE 'company' END;
   display:=COALESCE(NULLIF(btrim(i.extraction->>'company'),''),NULLIF(btrim(i.extraction->>'clientName'),''),e);
   INSERT INTO ticket_intake.clients(kind,display_name,name_norm)
     VALUES(kind,display,ticket_intake.v1_name(display)) RETURNING id INTO cid;
 END IF;
 SELECT id INTO contact FROM ticket_intake.client_contacts WHERE client_id=cid AND active AND email_norm=e ORDER BY id LIMIT 1;
 IF contact IS NULL THEN
   INSERT INTO ticket_intake.client_contacts(client_id,display_name,name_norm,email_original,email_norm,
     email_source,email_syntax_validated_at)
   VALUES(cid,i.extraction->>'clientName',ticket_intake.v1_name(i.extraction->>'clientName'),
     original,e,source,clock_timestamp()) RETURNING id INTO contact;
 END IF;
 UPDATE ticket_intake.intakes SET client_id=cid,contact_id=contact,email_original=original,email_norm=e,
   email_source=source,email_validated_at=clock_timestamp(),
   resolution_method=CASE WHEN p_selected IS NOT NULL THEN 'operator_selection' ELSE 'exact_email_or_name' END WHERE id=i.id;
 RETURN ticket_intake.v1_finalize(i.id);
END $$;

CREATE OR REPLACE FUNCTION ticket_intake.claim_v1_work(p_owner text,p_bot bigint,p_user bigint,p_chat bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE w ticket_intake.work_items%ROWTYPE; rev bigint;
BEGIN
 IF p_owner IS NULL OR length(btrim(p_owner)) NOT BETWEEN 1 AND 200 OR p_bot IS NULL OR p_bot<=0
   OR p_user IS NULL OR p_user<=0 OR p_chat IS NULL OR p_chat<=0 THEN
   RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid V1 worker configuration'; END IF;
 SELECT q.* INTO w FROM ticket_intake.work_items q
 LEFT JOIN ticket_intake.intakes i ON i.id=q.intake_id
 LEFT JOIN ticket_intake.processed_messages m ON m.id=q.message_id
 WHERE ((q.stage='resolve_client' AND i.bot_id=p_bot AND i.operator_user_id=p_user
   AND i.operator_chat_id=p_chat AND i.state IN ('extracted','retry_pending','resolving_client'))
   OR (q.stage='operator_reply' AND m.bot_id=p_bot AND m.operator_user_id=p_user AND m.chat_id=p_chat AND m.kind='text'))
   AND ((q.status='queued' AND q.available_at<=clock_timestamp())
     OR (q.status='leased' AND q.lease_expires_at<=clock_timestamp()))
 ORDER BY CASE q.stage WHEN 'operator_reply' THEN 0 ELSE 1 END,q.available_at,q.created_at,q.id
 FOR UPDATE OF q SKIP LOCKED LIMIT 1;
 IF NOT FOUND THEN RETURN jsonb_build_object('outcome','idle'); END IF;
 IF w.attempt_count>=w.max_attempts THEN
   UPDATE ticket_intake.work_items SET status='needs_operator',lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,
     last_failure_class='configuration',last_error_code='attempt_budget_exhausted',
     last_error_summary='database work requires operator review' WHERE id=w.id;
   IF w.intake_id IS NOT NULL THEN
     UPDATE ticket_intake.intakes SET state='needs_operator',revision=revision+1,
       last_error_code='attempt_budget_exhausted',last_error_summary='database work requires operator review' WHERE id=w.intake_id;
   END IF;
   RETURN jsonb_build_object('outcome','needs_operator','workId',w.id); END IF;
 SELECT revision INTO rev FROM ticket_intake.intakes WHERE id=w.intake_id;
 UPDATE ticket_intake.work_items SET status='leased',attempt_count=attempt_count+1,
   lease_owner=p_owner,lease_token=gen_random_uuid(),lease_expires_at=clock_timestamp()+interval '60 seconds',
   stage_revision=rev WHERE id=w.id RETURNING * INTO w;
 RETURN jsonb_build_object('outcome','claimed','workId',w.id,'stage',w.stage,
   'leaseToken',w.lease_token,'revision',rev::text,'attemptCount',w.attempt_count);
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
     WHERE p.status='open' AND p.bot_id=m.bot_id AND p.operator_user_id=m.operator_user_id
       AND p.operator_chat_id=m.chat_id AND p.created_at<=m.received_at
       AND o.status='sent' AND o.telegram_message_id=m.reply_to_message_id;
   ELSE
     SELECT count(*),(array_agg(id))[1] INTO count_pending,selection FROM ticket_intake.pending_interactions
     WHERE status='open' AND bot_id=m.bot_id AND operator_user_id=m.operator_user_id
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
     IF x.status<>'open' OR x.expected_intake_revision<>i.revision
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

CREATE OR REPLACE FUNCTION ticket_intake.claim_v1_outbox(p_owner text,p_bot bigint,p_chat bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE o ticket_intake.outbox%ROWTYPE;
BEGIN
 IF p_owner IS NULL OR length(btrim(p_owner)) NOT BETWEEN 1 AND 200 OR p_bot IS NULL OR p_bot<=0 OR p_chat IS NULL OR p_chat<=0 THEN
   RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid outbox configuration'; END IF;
 SELECT * INTO o FROM ticket_intake.outbox WHERE bot_id=p_bot AND operator_chat_id=p_chat
   AND ((status='queued' AND available_at<=clock_timestamp()) OR (status='leased' AND lease_expires_at<=clock_timestamp()))
 ORDER BY available_at,created_at,id FOR UPDATE SKIP LOCKED LIMIT 1;
 IF NOT FOUND THEN RETURN jsonb_build_object('outcome','idle'); END IF;
 IF (o.status='leased' AND o.dispatch_started_at IS NOT NULL) OR o.attempt_count>=o.max_attempts THEN
   UPDATE ticket_intake.outbox SET status=CASE WHEN o.dispatch_started_at IS NOT NULL THEN 'uncertain' ELSE 'needs_operator' END,
     lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,last_error_code=CASE WHEN o.dispatch_started_at IS NOT NULL THEN 'delivery_unknown' ELSE 'attempt_budget_exhausted' END,
     last_error_summary='Telegram delivery requires operator review' WHERE id=o.id;
   RETURN jsonb_build_object('outcome','needs_operator','outboxId',o.id); END IF;
 UPDATE ticket_intake.outbox SET status='leased',attempt_count=attempt_count+1,lease_owner=p_owner,
   lease_token=gen_random_uuid(),lease_expires_at=clock_timestamp()+interval '300 seconds',dispatch_started_at=NULL
   WHERE id=o.id RETURNING * INTO o;
 RETURN jsonb_build_object('outcome','claimed','outboxId',o.id,'leaseToken',o.lease_token,'attemptCount',o.attempt_count);
END $$;

CREATE OR REPLACE FUNCTION ticket_intake.begin_v1_delivery(p_outbox uuid,p_token uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE o ticket_intake.outbox%ROWTYPE;
BEGIN
 SELECT * INTO o FROM ticket_intake.outbox WHERE id=p_outbox FOR UPDATE;
 IF o.id IS NULL OR o.status<>'leased' OR p_token IS NULL OR o.lease_token IS DISTINCT FROM p_token
   OR o.lease_expires_at<=clock_timestamp() OR o.dispatch_started_at IS NOT NULL THEN
   RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='stale_or_dispatched_delivery'; END IF;
 IF o.payload - ARRAY['text','forceReply']<>'{}'::jsonb OR NOT o.payload ?& ARRAY['text','forceReply']
   OR jsonb_typeof(o.payload->'text') IS DISTINCT FROM 'string' OR length(o.payload->>'text') NOT BETWEEN 1 AND 3800
   OR jsonb_typeof(o.payload->'forceReply') IS DISTINCT FROM 'boolean' THEN
   RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid delivery payload'; END IF;
 UPDATE ticket_intake.outbox SET dispatch_started_at=clock_timestamp() WHERE id=o.id;
 RETURN jsonb_build_object('outcome','dispatch','outboxId',o.id,'leaseToken',o.lease_token,
   'chatId',o.operator_chat_id::text,'text',o.payload->>'text','forceReply',o.payload->'forceReply');
END $$;

CREATE OR REPLACE FUNCTION ticket_intake.finish_v1_delivery(p_outbox uuid,p_token uuid,p_message bigint,
 p_class text DEFAULT NULL,p_delay integer DEFAULT 30) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE o ticket_intake.outbox%ROWTYPE; s text;
BEGIN
 SELECT * INTO o FROM ticket_intake.outbox WHERE id=p_outbox FOR UPDATE;
 IF o.status='sent' AND p_token IS NOT NULL AND o.completed_lease_token=p_token AND p_message=o.telegram_message_id THEN
   RETURN jsonb_build_object('outcome','already_applied','outboxId',o.id); END IF;
 IF o.id IS NULL OR o.status<>'leased' OR p_token IS NULL OR o.lease_token IS DISTINCT FROM p_token
   OR o.lease_expires_at<=clock_timestamp() OR o.dispatch_started_at IS NULL THEN
   RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='stale_lease'; END IF;
 IF p_delay IS NULL OR p_delay NOT BETWEEN 1 AND 3600 THEN
   RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid retry delay'; END IF;
 IF p_message IS NOT NULL THEN
   IF p_message<=0 OR p_class IS NOT NULL THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid delivery receipt'; END IF;
   UPDATE ticket_intake.outbox SET status='sent',telegram_message_id=p_message,sent_at=clock_timestamp(),completed_lease_token=p_token,
     lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,last_error_code=NULL,last_error_summary=NULL WHERE id=o.id;
   RETURN jsonb_build_object('outcome','sent','outboxId',o.id);
 END IF;
 IF p_class IS NULL OR p_class NOT IN ('rate_limited','rejected_transient','configuration','permanent_external','delivery_unknown') THEN
   RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid delivery classification'; END IF;
 s:=CASE WHEN p_class='delivery_unknown' THEN 'uncertain'
   WHEN p_class IN ('rate_limited','rejected_transient') AND o.attempt_count<o.max_attempts THEN 'queued' ELSE 'needs_operator' END;
 UPDATE ticket_intake.outbox SET status=s,available_at=CASE WHEN s='queued' THEN clock_timestamp()+make_interval(secs=>p_delay) ELSE available_at END,
   dispatch_started_at=CASE WHEN s='queued' THEN NULL ELSE dispatch_started_at END,
   lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,last_error_code=p_class,
   last_error_summary=CASE WHEN p_class='delivery_unknown' THEN 'Telegram delivery outcome unknown; do not resend automatically'
     ELSE 'Telegram rejected delivery; sanitized classification only' END WHERE id=o.id;
 RETURN jsonb_build_object('outcome',s,'outboxId',o.id);
END $$;

-- Helpers are owner-only. Runtime can call only the bounded, fenced entry points.
REVOKE ALL ON FUNCTION ticket_intake.v1_name(text),ticket_intake.v1_email(text),
 ticket_intake.v1_enqueue(uuid,uuid,uuid,text,text,text,boolean),ticket_intake.v1_wait(uuid,text,jsonb,text),
 ticket_intake.v1_finalize(uuid),ticket_intake.v1_resolve(uuid,uuid),
 ticket_intake.claim_v1_work(text,bigint,bigint,bigint),ticket_intake.process_v1_work(uuid,uuid),
 ticket_intake.claim_v1_outbox(text,bigint,bigint),ticket_intake.begin_v1_delivery(uuid,uuid),
 ticket_intake.finish_v1_delivery(uuid,uuid,bigint,text,integer) FROM PUBLIC,ticket_n8n;
GRANT EXECUTE ON FUNCTION ticket_intake.claim_v1_work(text,bigint,bigint,bigint),
 ticket_intake.process_v1_work(uuid,uuid),ticket_intake.claim_v1_outbox(text,bigint,bigint),
 ticket_intake.begin_v1_delivery(uuid,uuid),ticket_intake.finish_v1_delivery(uuid,uuid,bigint,text,integer) TO ticket_n8n;
COMMIT;
