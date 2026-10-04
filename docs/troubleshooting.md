# Troubleshooting

Start with `node scripts/ops.mjs verify-installation` and `docker compose ps`. Both operate on local installation services. Never post unreviewed logs, compose environment output or database rows. Logs may include payloads despite configured saving limits; inspect them privately and report category/error code only.

| Symptom | Check and safe next step |
| --- | --- |
| Telegram webhook empty | Privately inspect getWebhookInfo; register the intended published HTTPS endpoint manually |
| Telegram 400 illegal secret_token | Use only letters, digits, underscore and hyphen, at most 256 characters; match Header Auth |
| Telegram Trigger replaced production webhook | Stop the conflicting trigger manually, restore intended registration and use a separate test bot |
| Voice not received | Check published TI-01, HTTPS, proxy, secret header, authorized private-chat IDs and voice metadata limits |
| Groq 429 | Check rate limit/quota; honor bounded retry delay and stage attempts, never spin up unrestricted retries |
| Transcription failed | Check bound Groq credential/model, audio limits and MIME/container validation; inspect error evidence privately |
| Extraction validation failed | Compare schema-required fields and validator bounds; do not persist unvalidated model output |
| Work item stuck | Check worker schedule, lease expiry, TI-05 recovery and needs_operator; never reset tokens or replay unsafe work blindly |
| Ambiguous pending reply | Reply to the exact prompt; TI-03 rejects stale or ambiguous correlations |
| Telegram delivery uncertain | Inspect provider/recipient evidence and use a reviewed reconciliation decision; do not blindly retry |
| Database unavailable | Check Compose postgres health, private network, reader/runtime credentials and privileges |
| Migration failure | Compare checksums and required role/database names; never edit an applied file or retry one-shot bootstrap on production |
| n8n unavailable | Check container health, port, encryption-key availability, volume permissions and proxy routing |

Local schema diagnostics without customer rows:

```sh
docker compose exec postgres sh -c 'psql -X -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT version,filename FROM ticket_intake.migration_history ORDER BY version"'
```

For a workflow failure, use its manually produced execution ID: diagnose execution, inspect matching workflow, propose the smallest complete repair, validate, review semantic diff, update only while inactive with version fencing, and fetch back. Do not execute, activate or retry a workflow automatically. See AGENTS.md.
