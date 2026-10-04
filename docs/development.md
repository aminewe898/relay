# Development

The repository contains src/ (TypeScript workflow-builder MCP), test/ (mock/loopback and synthetic workflow tests), frontend/ (Next.js UI and read-only BFF), database/ (immutable migration chain and fresh bootstrap), n8n/ (inactive sanitized workflow exports), scripts/ (portable Node operations with shell/PowerShell wrappers), and docs/.

Install Node >=22.15 and run npm ci at root and frontend. Root npm run check runs typecheck, mock/loopback tests, synthetic workflow contracts and build. Frontend npm run check runs typecheck, tests, build and loopback smoke tests. Run frontend npm run dev for a localhost console; use SERVICE_DESK_TRANSPORT=pg with a disposable DB and reader credentials. Do not mount the Docker socket into the deployed frontend.

The BFF is colocated in Next.js under app/api/v1 and accepts GET-only business projections. No separate relay-api process exists. Failure/disconnected modes show real empty/error states instead of fixtures. Assets and external imports are not implemented.

The builder is developer tooling, not a required runtime service. Build with npm run build and start with npm run start:env only after configuring an ignored local builder environment. See src/config.ts for validated inputs. Default to N8N_DRY_RUN=true; a preview is not a created workflow. Never expose tokens or automatically execute/activate workflows.

Edit workflows only in a separate inactive development instance. Export without IDs, credentials, static/pinned/execution data; rebind credentials and TI-00 explicitly. Validate structure and review node schemas against installed n8n docs. Preserve queues, fencing and uncertain-send handling. Repair workflow failures using AGENTS.md's diagnose/validate/diff/version-fenced update procedure.

**Never modify an already-applied migration.** Add a new numbered migration after 006 for future changes, update the reviewed runner/checksum manifest and fresh/upgrade tests. The retained .proposed suffix on 004 is historical; its bytes and migration-history name must not change.

Use disposable Compose project names, named volumes, mock providers and synthetic data. Never run archived development scripts against the live instance. Package release evidence as concise summaries rather than raw payloads. Review dependency audits without blind major upgrades, scan the working tree and every historical ref, verify fresh install and restoration, select license, then obtain explicit publishing authorization. No tag/push is part of this sprint.

`test/database-isolated.mjs` preserves backend idempotency, fencing, concurrency, operator-interaction, retention, privilege and uncertain-delivery tests. It requires RELAY_TEST_CONTAINER matching a dedicated relay-ci-<hex>-postgres-1 container and independently verifies Compose project/service labels. Never weaken this guard. It creates/drops only its randomized test database in that disposable cluster; baseline ticket_system is checked unchanged. Create ignored audit-local/ before running it. The default npm test excludes this opt-in Docker integration test.

No existing formatter or lint command is configured. TypeScript validation, tests and builds are enforced; adding a new lint policy is a follow-up and must not be represented as a passed check.

For a full fresh checkout/install rehearsal, install Python 3 and run `python scripts/clean-install-test.py`. It creates a new synthetic Git snapshot under ignored audit-local/, sets local-only secrets, runs both dependency installs/checks, starts uniquely named disposable Compose services, imports workflows inactive, runs the guarded backend suite, and tests application backup/restore. It never invokes Telegram/Groq. Test loopback ports 33100/35678 must be free. Run `python scripts/n8n-state-rehearsal.py` afterwards for a stopped-volume n8n restore drill of those inactive imports. Inspect the recorded project names before stopping/removing disposable services; never use production projects. Original repository history is not certified by this synthetic snapshot.
