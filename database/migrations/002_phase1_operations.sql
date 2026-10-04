-- Not applied. Phase 1: durable ingress and read-only reconciliation ONLY.
-- Authentication/actual operator allowlist are enforced by the future ingress workflow.
-- This function receives authorized metadata and trusted nonsecret policy separately.
BEGIN;
DO $$ BEGIN
  IF current_database() <> 'ticket_system' OR current_user <> 'ticket_owner'
      OR current_setting('server_version_num')::integer / 10000 <> 18 THEN
    RAISE EXCEPTION '002 requires ticket_system, ticket_owner, PostgreSQL 18';
  END IF;
END $$;

CREATE FUNCTION ticket_intake.lookup_message(
  p_bot_id bigint, p_update_id bigint DEFAULT NULL,
  p_chat_id bigint DEFAULT NULL, p_message_id bigint DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_update ticket_intake.processed_messages%ROWTYPE;
  v_chat ticket_intake.processed_messages%ROWTYPE;
  v_message ticket_intake.processed_messages%ROWTYPE;
  v_intake ticket_intake.intakes%ROWTYPE;
  v_ticket ticket_intake.tickets%ROWTYPE;
  v_work ticket_intake.work_items%ROWTYPE;
BEGIN
  IF p_bot_id IS NULL OR p_bot_id <= 0
    OR (p_update_id IS NULL AND (p_chat_id IS NULL OR p_message_id IS NULL))
    OR ((p_chat_id IS NULL) <> (p_message_id IS NULL))
    OR (p_update_id IS NOT NULL AND p_update_id < 0)
    OR (p_chat_id IS NOT NULL AND p_chat_id <= 0)
    OR (p_message_id IS NOT NULL AND p_message_id <= 0) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid lookup identifiers';
  END IF;
  IF p_update_id IS NOT NULL THEN
    SELECT * INTO v_update FROM ticket_intake.processed_messages
    WHERE bot_id = p_bot_id AND update_id = p_update_id;
  END IF;
  IF p_chat_id IS NOT NULL THEN
    SELECT * INTO v_chat FROM ticket_intake.processed_messages
    WHERE bot_id = p_bot_id AND chat_id = p_chat_id AND message_id = p_message_id;
  END IF;
  IF v_update.id IS NOT NULL AND v_chat.id IS NOT NULL AND v_update.id <> v_chat.id THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'conflicting lookup identifiers';
  END IF;
  IF v_update.id IS NOT NULL THEN v_message := v_update;
  ELSIF v_chat.id IS NOT NULL THEN v_message := v_chat;
  ELSE RETURN jsonb_build_object('found', false);
  END IF;
  IF (p_update_id IS NOT NULL AND v_message.update_id <> p_update_id)
    OR (p_chat_id IS NOT NULL AND
      (v_message.chat_id <> p_chat_id OR v_message.message_id <> p_message_id)) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'conflicting lookup identifiers';
  END IF;
  IF v_message.intake_id IS NOT NULL THEN
    SELECT intake_number, state, revision
      INTO v_intake.intake_number, v_intake.state, v_intake.revision
      FROM ticket_intake.intakes WHERE id = v_message.intake_id;
    SELECT id, ticket_number INTO v_ticket.id, v_ticket.ticket_number
      FROM ticket_intake.tickets WHERE intake_id = v_message.intake_id;
  END IF;
  SELECT id, stage, status INTO v_work.id, v_work.stage, v_work.status
  FROM ticket_intake.work_items
  WHERE message_id = v_message.id
    OR (v_message.intake_id IS NOT NULL AND intake_id = v_message.intake_id)
  ORDER BY CASE status WHEN 'leased' THEN 0 WHEN 'queued' THEN 1
    WHEN 'needs_operator' THEN 2 ELSE 3 END, created_at DESC, id
  LIMIT 1;
  -- Identifiers encoded as text for JavaScript bigint safety; no transcript/audio/PII.
  RETURN jsonb_build_object(
    'found', true, 'messageId', v_message.id, 'updateId', v_message.update_id::text,
    'telegramMessageId', v_message.message_id::text, 'messageStatus', v_message.status,
    'intakeId', v_message.intake_id, 'intakeNumber', v_intake.intake_number::text,
    'intakeState', v_intake.state, 'revision', v_intake.revision::text,
    'ticketId', v_ticket.id, 'ticketNumber', v_ticket.ticket_number::text,
    'workId', v_work.id, 'workStage', v_work.stage, 'workStatus', v_work.status);
END;
$$;
REVOKE ALL ON FUNCTION ticket_intake.lookup_message(bigint,bigint,bigint,bigint) FROM PUBLIC;

CREATE FUNCTION ticket_intake.ingest_message(
  p_bot_id bigint, p_update_id bigint, p_operator_user_id bigint,
  p_chat_id bigint, p_message_id bigint, p_kind text,
  p_message jsonb, p_policy jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_update ticket_intake.processed_messages%ROWTYPE;
  v_chat ticket_intake.processed_messages%ROWTYPE;
  v_existing ticket_intake.processed_messages%ROWTYPE;
  v_message_id uuid;
  v_intake_id uuid;
  v_text text;
  v_file_id text;
  v_unique_id text;
  v_mime text;
  v_reply bigint;
  v_size bigint;
  v_duration integer;
  v_sent_at timestamptz;
  v_attempts integer;
  v_new_intake boolean := false;
  v_key text;
BEGIN
  IF p_bot_id IS NULL OR p_bot_id <= 0 OR p_update_id IS NULL OR p_update_id < 0
    OR p_operator_user_id IS NULL OR p_operator_user_id <= 0
    OR p_chat_id IS NULL OR p_chat_id <= 0 OR p_message_id IS NULL OR p_message_id <= 0
    OR p_kind IS NULL OR p_kind NOT IN ('voice','text') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid ingress identifiers or kind';
  END IF;
  IF p_message IS NULL OR jsonb_typeof(p_message) <> 'object'
    OR octet_length(p_message::text) > 32768 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid sanitized message object';
  END IF;
  IF p_kind = 'voice' THEN
    IF p_message - ARRAY['fileId','fileUniqueId','mimeType','sizeBytes','durationSeconds','sentAt'] <> '{}'::jsonb
      OR jsonb_typeof(p_message->'fileId') IS DISTINCT FROM 'string'
      OR jsonb_typeof(p_message->'fileUniqueId') IS DISTINCT FROM 'string'
      OR length(btrim(p_message->>'fileId')) NOT BETWEEN 1 AND 1024
      OR length(btrim(p_message->>'fileUniqueId')) NOT BETWEEN 1 AND 256 THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid voice metadata';
    END IF;
    v_file_id := p_message->>'fileId'; v_unique_id := p_message->>'fileUniqueId';
    v_mime := p_message->>'mimeType';
    IF v_mime IS NOT NULL AND
      (jsonb_typeof(p_message->'mimeType') <> 'string' OR length(v_mime) > 200) THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid MIME metadata';
    END IF;
  ELSE
    IF p_message - ARRAY['text','replyToMessageId','sentAt'] <> '{}'::jsonb
      OR jsonb_typeof(p_message->'text') IS DISTINCT FROM 'string'
      OR length(btrim(p_message->>'text')) NOT BETWEEN 1 AND 8000 THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid text metadata';
    END IF;
    v_text := p_message->>'text';
  END IF;
  FOREACH v_key IN ARRAY ARRAY['replyToMessageId','sizeBytes','durationSeconds'] LOOP
    IF p_message->>v_key IS NOT NULL AND (p_message->>v_key) !~ '^[0-9]{1,15}$' THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid numeric message metadata';
    END IF;
  END LOOP;
  v_reply := (p_message->>'replyToMessageId')::bigint;
  v_size := (p_message->>'sizeBytes')::bigint;
  IF p_message->>'durationSeconds' IS NOT NULL AND
    (p_message->>'durationSeconds')::bigint > 2147483647 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid duration metadata';
  END IF;
  v_duration := (p_message->>'durationSeconds')::integer;
  IF v_reply IS NOT NULL AND v_reply <= 0 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid reply identifier';
  END IF;
  IF p_message->>'sentAt' IS NOT NULL THEN
    IF jsonb_typeof(p_message->'sentAt') <> 'string' THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid message timestamp';
    END IF;
    BEGIN
      v_sent_at := (p_message->>'sentAt')::timestamptz;
      IF NOT isfinite(v_sent_at) THEN RAISE EXCEPTION 'invalid timestamp'; END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid message timestamp';
    END;
  END IF;
  IF p_policy IS NULL OR jsonb_typeof(p_policy) <> 'object'
    OR octet_length(p_policy::text) > 16384
    OR jsonb_typeof(p_policy#>'{retryPolicy,stageMaxAttempts}') IS DISTINCT FROM 'number'
    OR (p_policy#>>'{retryPolicy,stageMaxAttempts}') !~ '^[0-9]{1,2}$' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid nonsecret ingress policy';
  END IF;
  v_attempts := (p_policy#>>'{retryPolicy,stageMaxAttempts}')::integer;
  IF v_attempts NOT BETWEEN 1 AND 20 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid attempt budget';
  END IF;

  -- Brief V1 bot-scoped transaction lock covers both message and voice identity races.
  -- Hash collisions only serialize unrelated bots; correctness rests on unique indexes.
  PERFORM pg_advisory_xact_lock(hashtextextended('ticket-ingress:' || p_bot_id::text, 0));
  SELECT * INTO v_update FROM ticket_intake.processed_messages
    WHERE bot_id = p_bot_id AND update_id = p_update_id;
  SELECT * INTO v_chat FROM ticket_intake.processed_messages
    WHERE bot_id = p_bot_id AND chat_id = p_chat_id AND message_id = p_message_id;
  IF v_update.id IS NOT NULL AND v_chat.id IS NOT NULL AND v_update.id <> v_chat.id THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'conflicting stored Telegram identifiers';
  END IF;
  IF v_update.id IS NOT NULL THEN v_existing := v_update;
  ELSIF v_chat.id IS NOT NULL THEN v_existing := v_chat;
  END IF;
  IF v_existing.id IS NOT NULL THEN
    IF v_existing.update_id <> p_update_id OR v_existing.chat_id <> p_chat_id
      OR v_existing.message_id <> p_message_id
      OR v_existing.operator_user_id <> p_operator_user_id OR v_existing.kind <> p_kind
      OR v_existing.text_content IS DISTINCT FROM v_text
      OR v_existing.reply_to_message_id IS DISTINCT FROM v_reply
      OR v_existing.voice_file_unique_id IS DISTINCT FROM v_unique_id THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'conflicting replay of stored Telegram message';
    END IF;
    RETURN ticket_intake.lookup_message(p_bot_id,p_update_id,p_chat_id,p_message_id)
      || jsonb_build_object('outcome', 'duplicate_message');
  END IF;

  INSERT INTO ticket_intake.processed_messages
    (bot_id,update_id,operator_user_id,chat_id,message_id,kind,reply_to_message_id,
     text_content,voice_file_id,voice_file_unique_id,voice_mime_type,
     voice_size_bytes,voice_duration_seconds,telegram_sent_at)
  VALUES (p_bot_id,p_update_id,p_operator_user_id,p_chat_id,p_message_id,p_kind,
    v_reply,v_text,v_file_id,v_unique_id,v_mime,v_size,v_duration,v_sent_at)
  RETURNING id INTO v_message_id;
  IF p_kind = 'voice' THEN
    INSERT INTO ticket_intake.intakes
      (source_message_id,bot_id,operator_user_id,operator_chat_id,source_file_unique_id,policy_snapshot)
    VALUES (v_message_id,p_bot_id,p_operator_user_id,p_chat_id,v_unique_id,p_policy)
    ON CONFLICT (bot_id,operator_user_id,source_file_unique_id) DO NOTHING
    RETURNING id INTO v_intake_id;
    v_new_intake := v_intake_id IS NOT NULL;
    IF NOT v_new_intake THEN
      SELECT id INTO STRICT v_intake_id FROM ticket_intake.intakes
      WHERE bot_id = p_bot_id AND operator_user_id = p_operator_user_id
        AND source_file_unique_id = v_unique_id;
      -- A change in configured private chat does not silently reuse another chat's intake.
      IF NOT EXISTS (SELECT 1 FROM ticket_intake.intakes WHERE id = v_intake_id
          AND operator_chat_id = p_chat_id) THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'voice identity belongs to a different operator chat';
      END IF;
    ELSE
      INSERT INTO ticket_intake.work_items (intake_id,stage,max_attempts)
      VALUES (v_intake_id,'download',v_attempts);
    END IF;
    UPDATE ticket_intake.processed_messages
    SET intake_id = v_intake_id, status = 'handled', handled_at = clock_timestamp()
    WHERE id = v_message_id;
  ELSE
    INSERT INTO ticket_intake.work_items (message_id,stage,max_attempts)
    VALUES (v_message_id,'operator_reply',v_attempts);
  END IF;
  RETURN ticket_intake.lookup_message(p_bot_id,p_update_id,p_chat_id,p_message_id)
    || jsonb_build_object('outcome', CASE
      WHEN p_kind = 'voice' AND NOT v_new_intake THEN 'duplicate_voice' ELSE 'accepted' END);
END;
$$;
REVOKE ALL ON FUNCTION ticket_intake.ingest_message(bigint,bigint,bigint,bigint,bigint,text,jsonb,jsonb)
  FROM PUBLIC;
COMMIT;
