-- Deployment preparation only. Not applied or database-tested.
-- Target: PostgreSQL 18; execute as ticket_owner in dedicated ticket_system DB.
-- Migration is intentionally one-shot; existing objects cause an error.
-- No configuration values, credential secrets, seed clients or operator IDs.
BEGIN;
DO $$ BEGIN
  IF current_database() <> 'ticket_system' OR current_user <> 'ticket_owner'
      OR current_setting('server_version_num')::integer / 10000 <> 18 THEN
    RAISE EXCEPTION '001_schema requires ticket_system, ticket_owner, PostgreSQL 18';
  END IF;
END $$;
CREATE SCHEMA ticket_intake;
REVOKE ALL ON SCHEMA ticket_intake FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE ticket_owner REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

CREATE TABLE ticket_intake.clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('company','individual')),
  display_name text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 300),
  name_norm text NOT NULL CHECK (length(name_norm) BETWEEN 1 AND 300),
  normalization_version integer NOT NULL DEFAULT 1 CHECK (normalization_version > 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX clients_name ON ticket_intake.clients (kind, name_norm) WHERE active;

CREATE TABLE ticket_intake.client_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES ticket_intake.clients(id),
  display_name text,
  name_norm text,
  email_original text NOT NULL CHECK (length(email_original) BETWEEN 3 AND 254),
  email_norm text NOT NULL CHECK (length(email_norm) BETWEEN 3 AND 254),
  email_source text NOT NULL CHECK (email_source IN ('operator','transcript','import')),
  email_syntax_validated_at timestamptz NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, id)
);
-- Shared addresses are permitted; ambiguity is resolved by the operator.
CREATE INDEX contacts_email ON ticket_intake.client_contacts (email_norm) WHERE active;
CREATE INDEX contacts_name ON ticket_intake.client_contacts (client_id, name_norm) WHERE active;

CREATE TABLE ticket_intake.processed_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bot_id bigint NOT NULL,
  update_id bigint NOT NULL,
  operator_user_id bigint NOT NULL,
  chat_id bigint NOT NULL,
  message_id bigint NOT NULL,
  kind text NOT NULL CHECK (kind IN ('voice','text','unsupported')),
  reply_to_message_id bigint,
  text_content text,
  voice_file_id text,
  voice_file_unique_id text,
  voice_mime_type text,
  voice_size_bytes bigint CHECK (voice_size_bytes >= 0),
  voice_duration_seconds integer CHECK (voice_duration_seconds >= 0),
  telegram_sent_at timestamptz,
  status text NOT NULL DEFAULT 'received'
    CHECK (status IN ('received','handled','ignored','needs_operator')),
  received_at timestamptz NOT NULL DEFAULT now(),
  handled_at timestamptz,
  UNIQUE (bot_id, update_id),
  UNIQUE (bot_id, chat_id, message_id),
  CHECK (kind <> 'voice' OR
    (voice_file_id IS NOT NULL AND voice_file_unique_id IS NOT NULL))
);

CREATE TABLE ticket_intake.intakes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  intake_number bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  source_message_id uuid NOT NULL UNIQUE REFERENCES ticket_intake.processed_messages(id),
  bot_id bigint NOT NULL,
  operator_user_id bigint NOT NULL,
  operator_chat_id bigint NOT NULL,
  source_file_unique_id text NOT NULL,
  state text NOT NULL DEFAULT 'received' CHECK (state IN (
    'received','downloading','audio_ready','transcribing','transcribed',
    'extracting','extracted','resolving_client','awaiting_client_selection',
    'awaiting_email','awaiting_details','awaiting_priority_confirmation',
    'ready_to_create','ticket_created','completed','retry_pending',
    'needs_operator','cancelled')),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  policy_snapshot jsonb NOT NULL CHECK (jsonb_typeof(policy_snapshot) = 'object'),
  audio_bytes bytea,
  audio_mime_type text,
  audio_sha256 text CHECK (audio_sha256 IS NULL OR audio_sha256 ~ '^[0-9a-f]{64}$'),
  audio_stored_at timestamptz,
  audio_purge_after timestamptz,
  audio_purged_at timestamptz,
  audio_purge_reason text,
  transcript_original text,
  transcription_metadata jsonb,
  extraction jsonb CHECK (extraction IS NULL OR jsonb_typeof(extraction) = 'object'),
  extraction_validated_at timestamptz,
  validation_version integer,
  client_id uuid REFERENCES ticket_intake.clients(id),
  contact_id uuid,
  resolution_method text,
  identity_confirmed_by_message_id uuid REFERENCES ticket_intake.processed_messages(id),
  email_original text,
  email_norm text,
  email_source text CHECK (email_source IS NULL OR email_source IN ('operator','transcript','import')),
  email_validated_at timestamptz,
  final_priority text CHECK (final_priority IN ('low','normal','high','critical')),
  priority_confirmed_by_message_id uuid REFERENCES ticket_intake.processed_messages(id),
  failed_stage text,
  last_error_code text,
  last_error_summary text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (client_id, contact_id)
    REFERENCES ticket_intake.client_contacts(client_id, id),
  UNIQUE (bot_id, operator_user_id, source_file_unique_id),
  CHECK (contact_id IS NULL OR client_id IS NOT NULL),
  CHECK (extraction_validated_at IS NULL OR
    (extraction IS NOT NULL AND validation_version IS NOT NULL)),
  CHECK (final_priority IS DISTINCT FROM 'critical' OR
    priority_confirmed_by_message_id IS NOT NULL),
  CHECK (audio_bytes IS NULL OR
    (audio_stored_at IS NOT NULL AND audio_purge_after IS NOT NULL
     AND audio_purged_at IS NULL))
);
CREATE INDEX intakes_state ON ticket_intake.intakes (state, updated_at);
CREATE INDEX intakes_audio_purge ON ticket_intake.intakes (audio_purge_after)
  WHERE audio_bytes IS NOT NULL;
CREATE INDEX intakes_audio_hash ON ticket_intake.intakes
  (bot_id, operator_user_id, audio_sha256) WHERE audio_sha256 IS NOT NULL;

-- Persist duplicate voice -> original intake mapping without a ninth table.
ALTER TABLE ticket_intake.processed_messages
  ADD COLUMN intake_id uuid REFERENCES ticket_intake.intakes(id);
CREATE INDEX messages_intake ON ticket_intake.processed_messages (intake_id)
  WHERE intake_id IS NOT NULL;

CREATE TABLE ticket_intake.pending_interactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  intake_id uuid NOT NULL REFERENCES ticket_intake.intakes(id),
  bot_id bigint NOT NULL,
  operator_user_id bigint NOT NULL,
  operator_chat_id bigint NOT NULL,
  kind text NOT NULL CHECK (kind IN ('email','client_selection','details','priority_confirmation')),
  correlation_token uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','cancelled')),
  expected_intake_revision bigint NOT NULL,
  context jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(context) = 'object'),
  response_message_id uuid UNIQUE REFERENCES ticket_intake.processed_messages(id),
  response_value jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  reminder_after timestamptz,
  last_reminded_at timestamptz,
  resolved_at timestamptz,
  CHECK (status <> 'resolved' OR
    (response_message_id IS NOT NULL AND resolved_at IS NOT NULL))
);
CREATE UNIQUE INDEX one_open_interaction_per_intake
  ON ticket_intake.pending_interactions (intake_id) WHERE status = 'open';
CREATE INDEX interactions_operator ON ticket_intake.pending_interactions
  (bot_id, operator_user_id, operator_chat_id, kind) WHERE status = 'open';

CREATE TABLE ticket_intake.tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_number bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  intake_id uuid NOT NULL UNIQUE REFERENCES ticket_intake.intakes(id),
  client_id uuid NOT NULL REFERENCES ticket_intake.clients(id),
  contact_id uuid NOT NULL,
  summary text NOT NULL CHECK (length(btrim(summary)) BETWEEN 1 AND 200),
  description text NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 12000),
  category text NOT NULL CHECK (category IN (
    'hardware','software','network','access','security','other','unknown')),
  priority text NOT NULL CHECK (priority IN ('low','normal','high','critical')),
  technical_details jsonb NOT NULL CHECK (jsonb_typeof(technical_details) = 'array'),
  structured_data jsonb NOT NULL CHECK (jsonb_typeof(structured_data) = 'object'),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','resolved','closed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (client_id, contact_id)
    REFERENCES ticket_intake.client_contacts(client_id, id)
);
CREATE INDEX tickets_client ON ticket_intake.tickets (client_id, created_at DESC);

CREATE TABLE ticket_intake.work_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  intake_id uuid REFERENCES ticket_intake.intakes(id),
  message_id uuid REFERENCES ticket_intake.processed_messages(id),
  stage text NOT NULL CHECK (stage IN (
    'download','transcribe','extract','resolve_client','finalize','operator_reply')),
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','leased','succeeded','needs_operator','cancelled')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts integer NOT NULL CHECK (max_attempts > 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_owner text,
  lease_token uuid,
  lease_expires_at timestamptz,
  last_error_code text,
  last_error_summary text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(intake_id, message_id) = 1),
  CHECK ((stage = 'operator_reply') = (message_id IS NOT NULL)),
  CHECK ((status = 'leased' AND lease_owner IS NOT NULL AND lease_token IS NOT NULL
          AND lease_expires_at IS NOT NULL)
      OR (status <> 'leased' AND lease_owner IS NULL AND lease_token IS NULL
          AND lease_expires_at IS NULL))
);
CREATE UNIQUE INDEX work_intake_stage ON ticket_intake.work_items (intake_id, stage)
  WHERE intake_id IS NOT NULL;
CREATE UNIQUE INDEX work_message_stage ON ticket_intake.work_items (message_id, stage)
  WHERE message_id IS NOT NULL;
CREATE UNIQUE INDEX one_intake_runnable_job ON ticket_intake.work_items (intake_id)
  WHERE status IN ('queued','leased') AND intake_id IS NOT NULL;
CREATE INDEX work_due ON ticket_intake.work_items (stage, available_at, created_at)
  WHERE status = 'queued';
CREATE INDEX work_expired ON ticket_intake.work_items (lease_expires_at)
  WHERE status = 'leased';

CREATE TABLE ticket_intake.outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  intake_id uuid REFERENCES ticket_intake.intakes(id),
  ticket_id uuid REFERENCES ticket_intake.tickets(id),
  interaction_id uuid REFERENCES ticket_intake.pending_interactions(id),
  bot_id bigint NOT NULL,
  operator_chat_id bigint NOT NULL,
  channel text NOT NULL DEFAULT 'telegram' CHECK (channel = 'telegram'),
  kind text NOT NULL CHECK (kind IN ('prompt','confirmation','status','failure','reminder')),
  delivery_key text NOT NULL UNIQUE,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','leased','sent','uncertain','needs_operator','cancelled')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts integer NOT NULL CHECK (max_attempts > 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_owner text,
  lease_token uuid,
  lease_expires_at timestamptz,
  telegram_message_id bigint,
  sent_at timestamptz,
  last_error_code text,
  last_error_summary text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'leased' AND lease_owner IS NOT NULL AND lease_token IS NOT NULL
          AND lease_expires_at IS NOT NULL)
      OR (status <> 'leased' AND lease_owner IS NULL AND lease_token IS NULL
          AND lease_expires_at IS NULL)),
  CHECK (status <> 'sent' OR (telegram_message_id IS NOT NULL AND sent_at IS NOT NULL))
);
CREATE INDEX outbox_due ON ticket_intake.outbox (available_at, created_at)
  WHERE status = 'queued';
CREATE INDEX outbox_expired ON ticket_intake.outbox (lease_expires_at)
  WHERE status = 'leased';
CREATE INDEX outbox_reply_lookup ON ticket_intake.outbox (bot_id, operator_chat_id, telegram_message_id)
  WHERE interaction_id IS NOT NULL AND telegram_message_id IS NOT NULL;

CREATE FUNCTION ticket_intake.touch_updated_at()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER clients_touch BEFORE UPDATE ON ticket_intake.clients
  FOR EACH ROW EXECUTE FUNCTION ticket_intake.touch_updated_at();
CREATE TRIGGER contacts_touch BEFORE UPDATE ON ticket_intake.client_contacts
  FOR EACH ROW EXECUTE FUNCTION ticket_intake.touch_updated_at();
CREATE TRIGGER intakes_touch BEFORE UPDATE ON ticket_intake.intakes
  FOR EACH ROW EXECUTE FUNCTION ticket_intake.touch_updated_at();
CREATE TRIGGER tickets_touch BEFORE UPDATE ON ticket_intake.tickets
  FOR EACH ROW EXECUTE FUNCTION ticket_intake.touch_updated_at();
CREATE TRIGGER work_touch BEFORE UPDATE ON ticket_intake.work_items
  FOR EACH ROW EXECUTE FUNCTION ticket_intake.touch_updated_at();
CREATE TRIGGER outbox_touch BEFORE UPDATE ON ticket_intake.outbox
  FOR EACH ROW EXECUTE FUNCTION ticket_intake.touch_updated_at();

-- Claim ONE job just before processing it. Do not claim a batch and let leases expire.
CREATE FUNCTION ticket_intake.claim_work(p_stage text, p_owner text, p_lease_seconds integer)
RETURNS SETOF ticket_intake.work_items LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF p_owner IS NULL OR btrim(p_owner) = '' OR p_lease_seconds IS NULL
      OR p_lease_seconds NOT BETWEEN 30 AND 3600 THEN
    RAISE EXCEPTION 'invalid lease configuration';
  END IF;
  IF p_stage = 'operator_reply' THEN
    RETURN QUERY
    WITH candidate AS (
      SELECT w.id FROM ticket_intake.work_items w
      WHERE w.stage = p_stage AND w.status = 'queued'
        AND w.available_at <= clock_timestamp() AND w.attempt_count < w.max_attempts
      ORDER BY w.available_at, w.created_at, w.id
      FOR UPDATE SKIP LOCKED LIMIT 1
    )
    UPDATE ticket_intake.work_items w
    SET status = 'leased', attempt_count = w.attempt_count + 1,
        lease_owner = p_owner, lease_token = gen_random_uuid(),
        lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds)
    FROM candidate c WHERE w.id = c.id RETURNING w.*;
    RETURN;
  END IF;
  RETURN QUERY
  WITH candidate AS (
    SELECT w.id FROM ticket_intake.work_items w
    JOIN ticket_intake.intakes i ON i.id = w.intake_id
    WHERE w.stage = p_stage AND w.status = 'queued'
      AND w.available_at <= clock_timestamp() AND w.attempt_count < w.max_attempts
      AND i.state NOT IN ('needs_operator','cancelled','completed','ticket_created')
      AND (p_stage <> 'transcribe' OR i.audio_bytes IS NOT NULL)
    ORDER BY w.available_at, w.created_at, w.id
    FOR UPDATE OF w, i SKIP LOCKED LIMIT 1
  )
  UPDATE ticket_intake.work_items w
  SET status = 'leased', attempt_count = w.attempt_count + 1,
      lease_owner = p_owner, lease_token = gen_random_uuid(),
      lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds)
  FROM candidate c WHERE w.id = c.id RETURNING w.*;
END;
$$;

CREATE FUNCTION ticket_intake.renew_work(p_id uuid, p_token uuid, p_lease_seconds integer)
RETURNS boolean LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_id uuid;
BEGIN
  IF p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 30 AND 3600 THEN
    RAISE EXCEPTION 'invalid lease configuration';
  END IF;
  UPDATE ticket_intake.work_items
  SET lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds)
  WHERE id = p_id AND status = 'leased' AND lease_token = p_token
    AND lease_expires_at > clock_timestamp() RETURNING id INTO v_id;
  RETURN v_id IS NOT NULL;
END;
$$;

-- Successful transcript checkpoint means audio is no longer required for recovery.
-- Hard retention expiry purges even unresolved/failed intakes, then requests new audio
-- if transcription never succeeded. Other workers must fence their writes by lease.
CREATE FUNCTION ticket_intake.purge_audio(p_limit integer)
RETURNS TABLE (intake_id uuid, reason text) LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'invalid purge batch size';
  END IF;
  RETURN QUERY
  WITH candidates AS (
    SELECT i.id FROM ticket_intake.intakes i
    WHERE i.audio_bytes IS NOT NULL AND i.audio_purge_after <= clock_timestamp()
      AND NOT EXISTS (
        SELECT 1 FROM ticket_intake.work_items w
        WHERE w.intake_id = i.id AND w.status = 'leased'
          AND w.lease_expires_at > clock_timestamp())
    ORDER BY i.audio_purge_after, i.id FOR UPDATE SKIP LOCKED LIMIT p_limit
  ), changed AS (
    UPDATE ticket_intake.intakes i
    SET audio_bytes = NULL, audio_purged_at = clock_timestamp(),
        audio_purge_reason = CASE WHEN i.transcript_original IS NULL
          THEN 'hard_retention_expired_before_transcription' ELSE 'retention_elapsed' END,
        state = CASE WHEN i.transcript_original IS NULL
          AND i.state NOT IN ('cancelled','completed') THEN 'needs_operator' ELSE i.state END,
        last_error_code = CASE WHEN i.transcript_original IS NULL
          AND i.state NOT IN ('cancelled','completed') THEN 'audio_expired' ELSE i.last_error_code END,
        revision = i.revision + 1
    FROM candidates c WHERE i.id = c.id RETURNING i.id, i.audio_purge_reason
  ) SELECT changed.id, changed.audio_purge_reason FROM changed;
END;
$$;

-- Auxiliary worker/purge functions remain SECURITY INVOKER and owner-only in Phase 1.
-- Runtime receives only the two narrowly scoped operation grants in 003_grants.sql.
REVOKE ALL ON ALL TABLES IN SCHEMA ticket_intake FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA ticket_intake FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ticket_intake FROM PUBLIC;
COMMIT;
