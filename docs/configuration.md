# Configuration reference

Environment values are server-side only. `.env.example` contains no credentials or real routing IDs. Setup inputs for Telegram/Groq help operators configure n8n manually; they are not automatically injected into credentials or TI-00. Never use NEXT_PUBLIC_ variables for secrets.

| Variable | Purpose |
| --- | --- |
| COMPOSE_PROJECT_NAME | Isolated project namespace; relay or relay-*; never the production project's name in tests |
| APP_URL | Operator-facing console URL; documentation input, no automatic proxy configuration |
| APP_PORT | Loopback console port, default 3100 |
| POSTGRES_DB | Must be ticket_system because applied migrations enforce it |
| POSTGRES_USER | Distinct bootstrap/admin login, default relay_bootstrap |
| POSTGRES_PASSWORD | Bootstrap password, minimum 32 characters |
| TICKET_RUNTIME_PASSWORD | ticket_n8n credential password, minimum 32 and distinct |
| RELAY_READER_PASSWORD | SELECT-only BFF login password, minimum 32 and distinct |
| SERVICE_DESK_DATABASE_URL | URL-encoded PostgreSQL connection URL for relay_reader on postgres/ticket_system |
| SERVICE_DESK_AUTH_USER | Console Basic Auth username |
| SERVICE_DESK_AUTH_PASSWORD | Console password, minimum 32 characters; HTTPS required off loopback |
| SERVICE_DESK_LOCAL_CONTAINER | Optional desktop-only observer target; required only for local-docker development, never used in Compose |
| SERVICE_DESK_LOCAL_DB_USER | Optional desktop-only psql user; no original deployment login/container is assumed |
| N8N_HOST | Editor/webhook hostname |
| N8N_PROTOCOL | http locally; https behind the production proxy |
| N8N_PORT | Loopback editor port, default 5678 |
| N8N_WEBHOOK_URL | Public webhook base URL with trailing slash |
| N8N_ENCRYPTION_KEY | Durable n8n credential encryption key; minimum 32; preserve with backups |
| N8N_DRY_RUN | Builder safety default true; not a switch that disables n8n schedules |
| N8N_API_KEY | Optional builder key; not used by Compose/setup; never needed for basic install |
| N8N_BASE_URL | Builder-only n8n HTTP(S) base URL; loopback example by default |
| N8N_REQUEST_TIMEOUT_MS | Builder-only bounded timeout 1–120000 ms, default 15000 |
| TELEGRAM_BOT_TOKEN | Operator setup input; configure Telegram credential |
| TELEGRAM_WEBHOOK_SECRET | Operator setup input; configure Header Auth and setWebhook |
| TELEGRAM_BOT_ID | Non-secret routing identity; manually set TI-00 |
| TELEGRAM_BOT_USERNAME | Bot username; manually set TI-00 |
| TELEGRAM_OPERATOR_USER_ID | Authorized positive decimal user ID string in TI-00 |
| TELEGRAM_OPERATOR_CHAT_ID | Authorized private-chat ID string in TI-00 |
| GROQ_API_KEY | Operator setup input; configure Groq credential |
| AUDIO_RETENTION_HOURS | Fresh bootstrap backend_policy audio hard TTL, 1–72, default 72 |
| INTERACTION_EXPIRY_HOURS | Fresh bootstrap interaction TTL, 1–720, default 48 |

Compose fixes SERVICE_DESK_MODE=live and SERVICE_DESK_TRANSPORT=pg. The desktop-only Docker socket observer is not enabled. n8n execution saving is disabled and its named data volume still contains sensitive encrypted credentials and state.

## Workflow policy

TI-00 has configVersion, bot identity and operator scope, ingressPolicy, retryPolicy and priorityPolicy. Private chat and human sender checks are mandatory. Only voice and text are supported; text is used for operator interaction replies. Maximum text: 8000 characters; file ID: 1024; unique file ID: 256; sanitized update: 32768 bytes. stageMaxAttempts defaults to 5, allowed range 1–20. blindWriteRetries must be false. unknownDefault must be normal; criticalRequiresConfirmation must be true.

Provider models: whisper-large-v3-turbo for original transcription and openai/gpt-oss-120b for structured extraction. Provider output is validated before persistence. Download size/MIME/container checks and request limits live in TI-02's Validate Download Metadata / Validate Downloaded Audio / Prepare Extraction Request Code nodes. Inspect the exported code before changing these bounds; downstream SQL enforces additional constraints. Do not extend MIME support without end-to-end validation.

TI-02's preserved policy limits audio to 10,000,000 bytes and 600 seconds. Declared MIME allowlist: audio/ogg, audio/opus, application/ogg; downloaded container bytes are independently checked. Its lease is 300 seconds, hard audio TTL 72 hours and success grace 1 hour. TI-02 polls every 15 seconds; exact TI-03/04/05 schedules are listed in workflow-settings.json. Review worker TTL constants alongside backend_policy before changing retention; the environment input alone does not override both.

Worker schedule intervals are configured in TI-02/03/04 Schedule Trigger nodes; maintenance in TI-05. Frontend SWR polls every 15 seconds while visible/online. backend_policy also has audio_success_grace_minutes=60 and batch_limit=50 (1–100). Fresh bootstrap applies env TTL inputs once; changing env later does not update a running policy. Use a reviewed operator SQL change and verify the persisted policy instead. Expiry deadlines already assigned to interactions need separate review.

See n8n/workflows for exact preserved lease/request timing and audio bounds, and database/migrations for function contracts. A generated settings inventory is supplied in workflow-settings.json. Do not assume environment changes override workflow constants.
