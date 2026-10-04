-- Phase-1 capability grants; no broad table/sequence permissions for n8n.
BEGIN;
DO $$ BEGIN
  IF current_database() <> 'ticket_system' OR current_user <> 'ticket_owner' THEN
    RAISE EXCEPTION '003 requires ticket_system and ticket_owner';
  END IF;
END $$;
REVOKE ALL ON DATABASE ticket_system FROM PUBLIC;
GRANT CONNECT ON DATABASE ticket_system TO ticket_n8n;
REVOKE ALL ON SCHEMA ticket_intake FROM PUBLIC, ticket_n8n;
GRANT USAGE ON SCHEMA ticket_intake TO ticket_n8n;
REVOKE ALL ON ALL TABLES IN SCHEMA ticket_intake FROM PUBLIC, ticket_n8n;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA ticket_intake FROM PUBLIC, ticket_n8n;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ticket_intake FROM PUBLIC, ticket_n8n;
ALTER DEFAULT PRIVILEGES FOR ROLE ticket_owner REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ticket_intake.lookup_message(bigint,bigint,bigint,bigint)
  TO ticket_n8n;
GRANT EXECUTE ON FUNCTION ticket_intake.ingest_message(bigint,bigint,bigint,bigint,bigint,text,jsonb,jsonb)
  TO ticket_n8n;
COMMIT;
