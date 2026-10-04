# Installation

Install Docker with Compose v2 and Node.js >=22.15. Allocate space for images, PostgreSQL and n8n volumes and encrypted backups. Obtain a dedicated Telegram bot and Groq key. Production Telegram ingress requires a publicly reachable HTTPS domain and reverse proxy.

1. Clone your reviewed Relay repository into an empty directory. Do not copy an old development folder.
2. Copy `.env.example` to `.env`. Set distinct random database passwords, console password and n8n encryption key, each at least 32 characters. Never paste them into issue reports or shell history.
3. Keep `POSTGRES_DB=ticket_system`; the immutable migration chain enforces this name. Set `SERVICE_DESK_DATABASE_URL` to `postgresql://relay_reader:<URL-encoded-reader-password>@postgres:5432/ticket_system`. Set the console username and match the reader password to `RELAY_READER_PASSWORD`.
4. Run `sh scripts/setup.sh` or `powershell -File scripts/setup.ps1`. It checks local configuration, builds the console, starts a project-scoped deployment, applies migrations only to a fresh volume and verifies local readiness. It does not import or execute workflows.
5. Open localhost:5678 and create the n8n owner account. Follow n8n-setup.md to create credentials, import six inactive workflows and bind TI-00.
6. Configure your own non-secret bot/operator IDs in TI-00. Configure HTTPS proxy and set N8N_HOST, N8N_PROTOCOL and N8N_WEBHOOK_URL consistently. Restart n8n after deployment-variable changes.
7. Manually publish maintenance and workers, then ingress, following the safe order in n8n-setup.md. Register the webhook only after ingress authentication and scope have been reviewed.
8. Using your own bot, manually send a short voice incident. Supply missing email or customer selection when requested. Verify a Telegram confirmation and matching ticket in Relay. This external end-to-end action is an operator test; setup and verification do not perform it.

Fresh installations start empty. No database dump, hidden environment file, production credential export or real customer fixture is required. Initial Postgres bootstrap is one-shot. If it fails, diagnose it in the disposable environment; never delete a production volume to restart initialization.

## Updates

Back up application DB, n8n state and its encryption key; test restoration separately. Read changelog and compare migrations. Never change or rerun applied migrations. `scripts/migrate.*` starts a fresh database and verifies existing migration history; it does not apply future migrations automatically. This release contains 001–006 only. Future migrations require a reviewed explicit runner before deployment. Pin dependency/images and test in a separate project before changing production. Do not run `docker compose down -v` in production.

The disposable install test result and limitations are in release-report.md. A clean local infrastructure test does not substitute for the operator's real Telegram/Groq acceptance test.
