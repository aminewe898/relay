-- Explicit column privileges for the existing read-only BFF; no raw queue payload access.
GRANT CONNECT ON DATABASE ticket_system TO relay_reader;
GRANT USAGE ON SCHEMA ticket_intake TO relay_reader;
GRANT SELECT (id,display_name,kind,active,created_at) ON ticket_intake.clients TO relay_reader;
GRANT SELECT (id,client_id,display_name,email_original,active,created_at) ON ticket_intake.client_contacts TO relay_reader;
GRANT SELECT (id,ticket_number,intake_id,client_id,contact_id,summary,description,category,priority,status,created_at,updated_at,technical_details) ON ticket_intake.tickets TO relay_reader;
GRANT SELECT (id,intake_number,state,extraction_validated_at,extraction,transcript_original,client_id,created_at,updated_at,transcribed_at,audio_purged_at) ON ticket_intake.intakes TO relay_reader;
GRANT SELECT (id,intake_id,kind,status,created_at,resolved_at) ON ticket_intake.pending_interactions TO relay_reader;
GRANT SELECT (id,intake_id,stage,status,attempt_count,max_attempts,created_at,updated_at) ON ticket_intake.work_items TO relay_reader;
GRANT SELECT (id,intake_id,kind,status,attempt_count,created_at,updated_at,sent_at) ON ticket_intake.outbox TO relay_reader;
GRANT SELECT (id,intake_id,kind,received_at) ON ticket_intake.processed_messages TO relay_reader;
\getenv audio_hours AUDIO_RETENTION_HOURS
\getenv interaction_hours INTERACTION_EXPIRY_HOURS
UPDATE ticket_intake.backend_policy SET audio_hard_ttl_hours=:'audio_hours'::integer,interaction_ttl_hours=:'interaction_hours'::integer WHERE singleton;
