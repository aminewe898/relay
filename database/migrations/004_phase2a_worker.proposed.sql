-- REVIEW ONLY. Never mounted into init/bootstrap automatically. PostgreSQL 18.
-- Apply, only after approval, as ticket_owner in ticket_system; one transaction.
-- Provider revision: Groq transcription; Groq extraction, NVIDIA reviewed fallback.
-- Prior live validation covered the archived pre-Groq variant, not this revision.
BEGIN;
DO $$ BEGIN
  IF current_database() <> 'ticket_system' OR current_user <> 'ticket_owner'
    OR current_setting('server_version_num')::integer / 10000 <> 18 THEN
    RAISE EXCEPTION '004 requires ticket_system, ticket_owner, PostgreSQL 18';
  END IF;
END $$;

ALTER TABLE ticket_intake.intakes
  ADD COLUMN audio_size_bytes bigint CHECK (audio_size_bytes > 0),
  ADD COLUMN transcribed_at timestamptz,
  ADD COLUMN extraction_metadata jsonb CHECK (jsonb_typeof(extraction_metadata) = 'object'),
  ADD COLUMN phase2_policy jsonb CHECK (jsonb_typeof(phase2_policy) = 'object');
ALTER TABLE ticket_intake.work_items
  ADD COLUMN stage_revision bigint CHECK (stage_revision >= 0),
  ADD COLUMN external_started_at timestamptz,
  ADD COLUMN completed_lease_token uuid,
  ADD COLUMN checkpoint_digest text,
  ADD COLUMN checkpoint_receipt jsonb,
  ADD COLUMN last_failure_class text CHECK (last_failure_class IN (
    'transient_external','malformed_output','invalid_input','configuration',
    'permanent_external','stale_lease','provider_unknown_result'));

-- Owner-only helpers; schema-qualified objects, fixed search_path, no dynamic SQL.
CREATE FUNCTION ticket_intake.phase2_policy_valid(p jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
 SELECT COALESCE(jsonb_typeof(p) = 'object'
   AND p ?& ARRAY['version','maxAudioBytes','maxDurationSeconds','leaseSeconds','hardTtlHours','successGraceHours']
   AND p - ARRAY['version','maxAudioBytes','maxDurationSeconds','leaseSeconds','hardTtlHours','successGraceHours'] = '{}'::jsonb
   AND p->>'version' = 'phase2a-1'
   AND jsonb_typeof(p->'maxAudioBytes') = 'number' AND p->>'maxAudioBytes' = '10000000'
   AND jsonb_typeof(p->'maxDurationSeconds') = 'number' AND p->>'maxDurationSeconds' = '600'
   AND jsonb_typeof(p->'leaseSeconds') = 'number' AND p->>'leaseSeconds' = '300'
   AND jsonb_typeof(p->'hardTtlHours') = 'number' AND p->>'hardTtlHours' = '72'
   AND jsonb_typeof(p->'successGraceHours') = 'number' AND p->>'successGraceHours' = '1', false)
$$;

CREATE FUNCTION ticket_intake.phase2_extraction_valid(p jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
DECLARE k text; a jsonb; v text;
  keys text[] := ARRAY['clientName','company','email','summary','description','category',
    'prioritySuggestion','affectedSystem','symptoms','technicalDetails','onsetText',
    'businessImpact','urgencyEvidence','confidence','missingInformation'];
BEGIN
  IF p IS NULL OR jsonb_typeof(p) <> 'object' OR NOT p ?& keys
    OR p - keys <> '{}'::jsonb OR octet_length(p::text) > 262144 THEN RETURN false; END IF;
  FOREACH k IN ARRAY ARRAY['clientName','company','email','summary','description',
      'category','prioritySuggestion','affectedSystem','onsetText','businessImpact','urgencyEvidence'] LOOP
    IF jsonb_typeof(p->k) NOT IN ('string','null') THEN RETURN false; END IF;
    v := p->>k;
    IF v IS NOT NULL AND (length(btrim(v)) = 0 OR length(v) > CASE k
      WHEN 'summary' THEN 200 WHEN 'description' THEN 12000 WHEN 'email' THEN 254
      WHEN 'clientName' THEN 300 WHEN 'company' THEN 300 ELSE 1000 END) THEN RETURN false; END IF;
  END LOOP;
  IF p->>'summary' IS NULL OR p->>'description' IS NULL THEN RETURN false; END IF;
  IF p->>'category' IS NOT NULL AND p->>'category' NOT IN
    ('hardware','software','network','access','security','other','unknown') THEN RETURN false; END IF;
  IF p->>'prioritySuggestion' IS NOT NULL AND p->>'prioritySuggestion' NOT IN
    ('low','normal','high','critical','unknown') THEN RETURN false; END IF;
  IF p->>'email' IS NOT NULL AND (p->>'email' ~ '[[:space:]]'
    OR p->>'email' !~ '^[A-Za-z0-9.!#$%&''*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$') THEN RETURN false; END IF;
  FOREACH k IN ARRAY ARRAY['symptoms','technicalDetails','missingInformation'] LOOP
    IF jsonb_typeof(p->k) = 'null' THEN CONTINUE; END IF;
    IF jsonb_typeof(p->k) <> 'array' THEN RETURN false; END IF;
    IF jsonb_array_length(p->k) > 50 THEN RETURN false; END IF;
    FOR a IN SELECT value FROM jsonb_array_elements(p->k) LOOP
      IF jsonb_typeof(a) <> 'string' OR length(btrim(a #>> '{}')) NOT BETWEEN 1 AND 1000 THEN RETURN false; END IF;
    END LOOP;
  END LOOP;
  IF jsonb_typeof(p->'confidence') = 'null' THEN RETURN true; END IF;
  IF jsonb_typeof(p->'confidence') <> 'number' THEN RETURN false; END IF;
  RETURN (p->>'confidence')::numeric BETWEEN 0 AND 1;
END $$;

CREATE FUNCTION ticket_intake.phase2_lock(p_work uuid, p_token uuid, p_revision bigint)
RETURNS ticket_intake.intakes LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE w ticket_intake.work_items%ROWTYPE; i ticket_intake.intakes%ROWTYPE;
BEGIN
  SELECT * INTO w FROM ticket_intake.work_items WHERE id = p_work FOR UPDATE;
  IF NOT FOUND OR w.stage NOT IN ('download','transcribe','extract') OR w.status <> 'leased'
    OR p_token IS NULL OR w.lease_token IS DISTINCT FROM p_token
    OR w.lease_expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'stale_lease';
  END IF;
  SELECT * INTO STRICT i FROM ticket_intake.intakes WHERE id = w.intake_id FOR UPDATE;
  IF w.lease_expires_at <= clock_timestamp() OR p_revision IS NULL OR i.revision <> p_revision THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'stale_lease';
  END IF;
  RETURN i;
END $$;

-- One scoped candidate across ALL THREE stages, including at most one expired job.
-- Old claim_work(text,text,integer) stays owner-only and is NOT granted to n8n.
CREATE FUNCTION ticket_intake.claim_work(p_owner text, p_bot bigint, p_user bigint,
  p_chat bigint, p_policy jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $$
DECLARE w ticket_intake.work_items%ROWTYPE; i ticket_intake.intakes%ROWTYPE; c text;
BEGIN
  IF p_owner IS NULL OR length(btrim(p_owner)) NOT BETWEEN 1 AND 200
    OR p_bot IS NULL OR p_bot <= 0 OR p_user IS NULL OR p_user <= 0
    OR p_chat IS NULL OR p_chat <= 0 OR NOT ticket_intake.phase2_policy_valid(p_policy) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid phase2 worker configuration';
  END IF;
  SELECT q.* INTO w FROM ticket_intake.work_items q
  JOIN ticket_intake.intakes x ON x.id = q.intake_id
  WHERE q.stage IN ('download','transcribe','extract')
    AND x.bot_id = p_bot AND x.operator_user_id = p_user AND x.operator_chat_id = p_chat
    AND x.state IN ('received','downloading','audio_ready','transcribing','transcribed','extracting','retry_pending')
    AND ((q.status = 'queued' AND q.available_at <= clock_timestamp())
      OR (q.status = 'leased' AND q.lease_expires_at <= clock_timestamp()))
  ORDER BY q.available_at,q.created_at,q.id FOR UPDATE OF q SKIP LOCKED LIMIT 1;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome','idle'); END IF;
  SELECT * INTO i FROM ticket_intake.intakes WHERE id = w.intake_id FOR UPDATE SKIP LOCKED;
  IF NOT FOUND OR i.state NOT IN ('received','downloading','audio_ready','transcribing','transcribed','extracting','retry_pending') THEN
    RETURN jsonb_build_object('outcome','idle'); END IF;
  IF w.attempt_count >= w.max_attempts OR
    (w.status = 'leased' AND w.stage IN ('transcribe','extract') AND w.external_started_at IS NOT NULL) THEN
    c := CASE WHEN w.attempt_count >= w.max_attempts THEN 'attempt_budget_exhausted' ELSE 'provider_unknown_result' END;
    UPDATE ticket_intake.work_items SET status='needs_operator',lease_owner=NULL,lease_token=NULL,
      lease_expires_at=NULL,last_error_code=c,last_error_summary=c,
      last_failure_class=CASE WHEN c='provider_unknown_result' THEN c ELSE 'permanent_external' END WHERE id=w.id;
    UPDATE ticket_intake.intakes SET state='needs_operator',failed_stage=w.stage,last_error_code=c,
      last_error_summary=c,revision=revision+1 WHERE id=i.id;
    RETURN jsonb_build_object('outcome','needs_operator','workId',w.id,'reason',c);
  END IF;
  IF i.phase2_policy IS NULL THEN
    UPDATE ticket_intake.intakes SET phase2_policy=p_policy WHERE id=i.id;
  ELSIF i.phase2_policy IS DISTINCT FROM p_policy THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='phase2 policy mismatch requires review';
  END IF;
  UPDATE ticket_intake.work_items SET status='leased',attempt_count=attempt_count+1,
    lease_owner=p_owner,lease_token=gen_random_uuid(),lease_expires_at=clock_timestamp()+interval '300 seconds',
    stage_revision=NULL,external_started_at=NULL WHERE id=w.id RETURNING * INTO w;
  RETURN jsonb_build_object('outcome','claimed','workId',w.id,'intakeId',i.id,
    'stage',w.stage,'revision',i.revision::text,'attemptCount',w.attempt_count,
    'leaseToken',w.lease_token,'leaseExpiresAt',w.lease_expires_at);
END $$;

CREATE FUNCTION ticket_intake.begin_stage(p_work uuid,p_token uuid,p_revision bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE w ticket_intake.work_items%ROWTYPE; i ticket_intake.intakes%ROWTYPE; s text; payload jsonb;
BEGIN
  i := ticket_intake.phase2_lock(p_work,p_token,p_revision);
  SELECT * INTO STRICT w FROM ticket_intake.work_items WHERE id=p_work;
  s := CASE w.stage WHEN 'download' THEN 'downloading' WHEN 'transcribe' THEN 'transcribing' ELSE 'extracting' END;
  IF w.stage_revision IS NOT NULL THEN
    IF w.stage_revision <> i.revision OR i.state <> s THEN
      RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='stale_lease'; END IF;
  ELSE
    IF NOT ticket_intake.phase2_policy_valid(i.phase2_policy) OR
      (w.stage='download' AND (i.audio_bytes IS NOT NULL OR i.transcript_original IS NOT NULL OR i.extraction IS NOT NULL
        OR i.state NOT IN ('received','downloading','retry_pending'))) OR
      (w.stage='transcribe' AND (i.audio_bytes IS NULL OR i.audio_purge_after <= clock_timestamp()
        OR i.transcript_original IS NOT NULL OR i.state NOT IN ('audio_ready','transcribing','retry_pending'))) OR
      (w.stage='extract' AND (i.transcript_original IS NULL OR i.extraction IS NOT NULL
        OR i.state NOT IN ('transcribed','extracting','retry_pending'))) THEN
      RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid stage prerequisites'; END IF;
    UPDATE ticket_intake.intakes SET state=s,revision=revision+1 WHERE id=i.id RETURNING * INTO i;
    UPDATE ticket_intake.work_items SET stage_revision=i.revision WHERE id=w.id;
  END IF;
  IF w.stage='download' THEN
    SELECT jsonb_build_object('fileId',voice_file_id,'fileUniqueId',voice_file_unique_id,
      'declaredMimeType',voice_mime_type,'declaredSizeBytes',voice_size_bytes,
      'durationSeconds',voice_duration_seconds) INTO payload
      FROM ticket_intake.processed_messages WHERE id=i.source_message_id;
  ELSIF w.stage='transcribe' THEN
    payload := jsonb_build_object('audioBase64',encode(i.audio_bytes,'base64'),
      'mimeType',i.audio_mime_type,'sizeBytes',i.audio_size_bytes,'sha256',i.audio_sha256);
  ELSE payload := jsonb_build_object('transcriptOriginal',i.transcript_original); END IF;
  RETURN jsonb_build_object('outcome','begun','workId',w.id,'intakeId',i.id,'stage',w.stage,
    'revision',i.revision::text,'leaseToken',w.lease_token,'leaseExpiresAt',w.lease_expires_at,
    'policy',i.phase2_policy,'payload',payload);
END $$;

-- Must succeed immediately before each external call; persists possible provider dispatch.
-- A renewed token never revives an expired lease. Deadline is bounded by workflow timeout.
CREATE FUNCTION ticket_intake.renew_work(p_work uuid,p_token uuid,p_revision bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE i ticket_intake.intakes%ROWTYPE; w ticket_intake.work_items%ROWTYPE;
BEGIN
  i := ticket_intake.phase2_lock(p_work,p_token,p_revision);
  SELECT * INTO STRICT w FROM ticket_intake.work_items WHERE id=p_work;
  IF w.stage_revision IS DISTINCT FROM p_revision THEN
    RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='stale_lease'; END IF;
  UPDATE ticket_intake.work_items SET lease_expires_at=clock_timestamp()+interval '300 seconds',
    external_started_at=COALESCE(external_started_at,clock_timestamp()) WHERE id=p_work RETURNING * INTO w;
  RETURN jsonb_build_object('outcome','renewed','leaseExpiresAt',w.lease_expires_at);
END $$;

CREATE FUNCTION ticket_intake.checkpoint_stage(p_work uuid,p_token uuid,p_revision bigint,p_result jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE w ticket_intake.work_items%ROWTYPE; i ticket_intake.intakes%ROWTYPE;
  b bytea; h text; digest text; n text; s text; meta jsonb; receipt jsonb; earlier uuid;
BEGIN
  IF p_result IS NULL OR jsonb_typeof(p_result)<>'object' OR octet_length(p_result::text)>14000000 THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid stage result'; END IF;
  digest := encode(sha256(convert_to(p_result::text,'UTF8')),'hex');
  SELECT * INTO w FROM ticket_intake.work_items WHERE id=p_work FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='stale_lease'; END IF;
  IF w.status='succeeded' AND p_token IS NOT NULL AND w.completed_lease_token=p_token THEN
    IF w.stage_revision IS DISTINCT FROM p_revision OR w.checkpoint_digest IS DISTINCT FROM digest THEN
      RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='conflicting checkpoint replay'; END IF;
    RETURN w.checkpoint_receipt || jsonb_build_object('outcome','already_applied');
  END IF;
  i := ticket_intake.phase2_lock(p_work,p_token,p_revision);
  IF w.stage_revision IS DISTINCT FROM p_revision OR w.external_started_at IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='stale_lease'; END IF;
  IF w.stage='download' THEN
    IF i.state<>'downloading' OR p_result - ARRAY['audioBase64','mimeType','sizeBytes','sha256']<>'{}'::jsonb
      OR NOT p_result ?& ARRAY['audioBase64','mimeType','sizeBytes','sha256']
      OR jsonb_typeof(p_result->'audioBase64')<>'string' OR length(p_result->>'audioBase64')>13333336
      OR p_result->>'mimeType' IS DISTINCT FROM 'audio/ogg'
      OR jsonb_typeof(p_result->'sha256') IS DISTINCT FROM 'string' OR p_result->>'sha256' !~ '^[0-9a-f]{64}$'
      OR jsonb_typeof(p_result->'sizeBytes')<>'number' OR p_result->>'sizeBytes' !~ '^[0-9]{1,8}$' THEN
      RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid audio checkpoint'; END IF;
    BEGIN b := decode(p_result->>'audioBase64','base64');
    EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid audio encoding'; END;
    IF octet_length(b) NOT BETWEEN 1 AND 10000000 OR octet_length(b)<>(p_result->>'sizeBytes')::bigint
      OR substring(b FROM 1 FOR 4)<>decode('4f676753','hex') THEN
      RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid audio bytes'; END IF;
    h := encode(sha256(b),'hex');
    IF h<>p_result->>'sha256' THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='audio hash mismatch'; END IF;
    -- Hash matches hold the new intake for review; never merge incident identity silently.
    PERFORM pg_advisory_xact_lock(hashtextextended(i.bot_id::text||':'||i.operator_user_id::text||':'||h,0));
    SELECT id INTO earlier FROM ticket_intake.intakes WHERE id<>i.id AND bot_id=i.bot_id
      AND operator_user_id=i.operator_user_id AND audio_sha256=h ORDER BY created_at,id LIMIT 1;
    UPDATE ticket_intake.intakes SET audio_bytes=b,audio_mime_type='audio/ogg',audio_size_bytes=octet_length(b),
      audio_sha256=h,audio_stored_at=clock_timestamp(),audio_purge_after=clock_timestamp()+interval '72 hours',
      audio_purged_at=NULL,audio_purge_reason=NULL WHERE id=i.id;
    n := 'transcribe'; s := 'audio_ready';
  ELSIF w.stage='transcribe' THEN
    meta := p_result->'metadata';
    IF i.state<>'transcribing' OR p_result - ARRAY['transcriptOriginal','metadata']<>'{}'::jsonb
      OR NOT p_result ?& ARRAY['transcriptOriginal','metadata']
      OR jsonb_typeof(p_result->'transcriptOriginal')<>'string'
      OR length(btrim(p_result->>'transcriptOriginal')) NOT BETWEEN 1 AND 100000
      OR jsonb_typeof(meta)<>'object' OR meta - ARRAY['provider','model','version']<>'{}'::jsonb
      OR NOT meta ?& ARRAY['provider','model','version'] OR meta->>'provider' IS DISTINCT FROM 'groq'
      OR meta->>'model' IS DISTINCT FROM 'whisper-large-v3-turbo' OR meta->>'version' IS DISTINCT FROM 'transcription-1' THEN
      RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid transcription checkpoint'; END IF;
    UPDATE ticket_intake.intakes SET transcript_original=p_result->>'transcriptOriginal',
      transcription_metadata=meta,transcribed_at=clock_timestamp() WHERE id=i.id;
    n := 'extract'; s := 'transcribed';
  ELSIF w.stage='extract' THEN
    meta := p_result->'metadata';
    IF i.state<>'extracting' OR p_result - ARRAY['extraction','metadata']<>'{}'::jsonb
      OR NOT p_result ?& ARRAY['extraction','metadata']
      OR NOT ticket_intake.phase2_extraction_valid(p_result->'extraction')
      OR jsonb_typeof(meta)<>'object' OR meta - ARRAY['provider','model','schemaVersion','promptVersion']<>'{}'::jsonb
      OR NOT meta ?& ARRAY['provider','model','schemaVersion','promptVersion']
      OR jsonb_typeof(meta->'provider') IS DISTINCT FROM 'string' OR meta->>'provider' NOT IN ('groq','nvidia')
      OR jsonb_typeof(meta->'model') IS DISTINCT FROM 'string'
      OR length(meta->>'model') NOT BETWEEN 1 AND 100
      OR (meta->>'provider'='groq' AND meta->>'model' NOT IN ('openai/gpt-oss-120b','openai/gpt-oss-20b'))
      OR (meta->>'provider'='nvidia' AND meta->>'model' IS DISTINCT FROM 'nvidia/nemotron-3-super-120b-a12b')
      OR meta->>'schemaVersion' IS DISTINCT FROM 'extraction-1' OR meta->>'promptVersion' IS DISTINCT FROM 'extract-prompt-1' THEN
      RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid extraction checkpoint'; END IF;
    IF p_result#>>'{extraction,email}' IS NOT NULL AND
      position(lower(p_result#>>'{extraction,email}') IN lower(i.transcript_original))=0 THEN
      RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='email lacks transcript evidence'; END IF;
    UPDATE ticket_intake.intakes SET extraction=p_result->'extraction',extraction_metadata=meta,
      extraction_validated_at=clock_timestamp(),validation_version=1,
      audio_purge_after=CASE WHEN audio_bytes IS NOT NULL THEN
        LEAST(audio_purge_after,clock_timestamp()+interval '1 hour') ELSE audio_purge_after END WHERE id=i.id;
    n := 'resolve_client'; s := 'extracted';
  ELSE RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='unsupported phase2 stage'; END IF;
  IF w.lease_expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='stale_lease'; END IF;
  IF earlier IS NOT NULL THEN s:='needs_operator'; n:=NULL; END IF;
  UPDATE ticket_intake.intakes SET state=s,revision=revision+1,
    failed_stage=CASE WHEN earlier IS NOT NULL THEN 'download' ELSE NULL END,
    last_error_code=CASE WHEN earlier IS NOT NULL THEN 'duplicate_audio_hash' ELSE NULL END,
    last_error_summary=CASE WHEN earlier IS NOT NULL THEN 'identical audio requires operator review' ELSE NULL END
    WHERE id=i.id RETURNING * INTO i;
  receipt:=jsonb_build_object('outcome',CASE WHEN earlier IS NULL THEN 'advanced' ELSE 'needs_operator' END,
    'intakeId',i.id,'revision',i.revision::text,'state',s,'nextStage',n,'matchingIntakeId',earlier);
  -- Release unique runnable-job constraint BEFORE enqueuing the next stage.
  UPDATE ticket_intake.work_items SET status='succeeded',completed_lease_token=p_token,
    checkpoint_digest=digest,checkpoint_receipt=receipt,lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL
    WHERE id=w.id;
  IF n IS NOT NULL THEN
    INSERT INTO ticket_intake.work_items(intake_id,stage,max_attempts) VALUES(i.id,n,w.max_attempts);
  END IF;
  RETURN receipt;
END $$;

CREATE FUNCTION ticket_intake.fail_work(p_work uuid,p_token uuid,p_revision bigint,p_class text,p_delay_seconds integer DEFAULT 30)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE i ticket_intake.intakes%ROWTYPE; w ticket_intake.work_items%ROWTYPE; retry boolean; summary text;
BEGIN
  IF p_class IS NULL OR p_class NOT IN ('transient_external','malformed_output','invalid_input',
    'configuration','permanent_external','stale_lease','provider_unknown_result')
    OR p_delay_seconds IS NULL OR p_delay_seconds NOT BETWEEN 1 AND 3600 THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid failure classification'; END IF;
  IF p_class='stale_lease' THEN RETURN jsonb_build_object('outcome','stale_lease'); END IF;
  BEGIN i:=ticket_intake.phase2_lock(p_work,p_token,p_revision);
  EXCEPTION WHEN NO_DATA_FOUND THEN RETURN jsonb_build_object('outcome','stale_lease'); END;
  SELECT * INTO STRICT w FROM ticket_intake.work_items WHERE id=p_work;
  -- Deterministic validation failure requires review; never add paid repair loops.
  -- Groq strict extraction uses one fixed-endpoint request, with no parser-repair call.
  retry:=w.attempt_count<w.max_attempts AND p_class='transient_external';
  summary:=CASE p_class WHEN 'transient_external' THEN 'temporary provider failure'
    WHEN 'malformed_output' THEN 'provider output failed deterministic validation'
    WHEN 'invalid_input' THEN 'input is unsupported or unusable'
    WHEN 'configuration' THEN 'worker credential or configuration requires review'
    WHEN 'permanent_external' THEN 'provider rejected the operation permanently'
    ELSE 'provider result is unknown; operator review required' END;
  UPDATE ticket_intake.work_items SET status=CASE WHEN retry THEN 'queued' ELSE 'needs_operator' END,
    available_at=CASE WHEN retry THEN clock_timestamp()+make_interval(secs=>p_delay_seconds) ELSE available_at END,
    last_failure_class=p_class,last_error_code=p_class,last_error_summary=summary,
    lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,stage_revision=NULL,external_started_at=NULL WHERE id=w.id;
  UPDATE ticket_intake.intakes SET state=CASE WHEN retry THEN 'retry_pending' ELSE 'needs_operator' END,
    failed_stage=w.stage,last_error_code=p_class,last_error_summary=summary,revision=revision+1 WHERE id=i.id;
  RETURN jsonb_build_object('outcome',CASE WHEN retry THEN 'retry_scheduled' ELSE 'needs_operator' END);
END $$;

-- Reconciliation does NOT claim, retry, renew, or return audio/transcript/extraction.
CREATE FUNCTION ticket_intake.inspect_work(p_work uuid,p_token uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE w ticket_intake.work_items%ROWTYPE; r bigint;
BEGIN
  SELECT * INTO w FROM ticket_intake.work_items WHERE id=p_work;
  IF NOT FOUND OR p_token IS NULL OR
    (w.lease_token IS DISTINCT FROM p_token AND w.completed_lease_token IS DISTINCT FROM p_token) THEN
    RETURN jsonb_build_object('outcome','stale_lease'); END IF;
  SELECT revision INTO r FROM ticket_intake.intakes WHERE id=w.intake_id;
  RETURN jsonb_build_object('outcome','found','status',w.status,'stage',w.stage,'revision',r::text,
    'stageRevision',w.stage_revision::text,'leaseExpiresAt',w.lease_expires_at,
    'externalStartedAt',w.external_started_at,'checkpointReceipt',w.checkpoint_receipt);
END $$;

REVOKE ALL ON FUNCTION ticket_intake.phase2_policy_valid(jsonb),
  ticket_intake.phase2_extraction_valid(jsonb),ticket_intake.phase2_lock(uuid,uuid,bigint),
  ticket_intake.claim_work(text,bigint,bigint,bigint,jsonb),ticket_intake.begin_stage(uuid,uuid,bigint),
  ticket_intake.renew_work(uuid,uuid,bigint),ticket_intake.checkpoint_stage(uuid,uuid,bigint,jsonb),
  ticket_intake.fail_work(uuid,uuid,bigint,text,integer),ticket_intake.inspect_work(uuid,uuid)
  FROM PUBLIC,ticket_n8n;
GRANT EXECUTE ON FUNCTION ticket_intake.claim_work(text,bigint,bigint,bigint,jsonb),
  ticket_intake.begin_stage(uuid,uuid,bigint),ticket_intake.renew_work(uuid,uuid,bigint),
  ticket_intake.checkpoint_stage(uuid,uuid,bigint,jsonb),
  ticket_intake.fail_work(uuid,uuid,bigint,text,integer),ticket_intake.inspect_work(uuid,uuid)
  TO ticket_n8n;
-- No table/sequence privileges, old lease helpers, purge, resolver, or ticket grants.
COMMIT;
