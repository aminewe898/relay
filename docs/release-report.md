# Relay v1.0.0 candidate: release engineering report

Date: 2026-10-04 (Europe/Madrid). **NO-GO for public push.** Historical packaging report. Apache-2.0 and intentional sanitized-history provenance are now resolved. See [final pre-public report](final-pre-public-report.md) for current checks and remaining operator gates. The repository is private; no tag or GitHub Release exists.

## A. Final repository tree

See [repository-tree.txt](repository-tree.txt). It enumerates only shipping files. The operator also has a ZIP of this same distribution beside the package; dependencies, builds and private test artifacts are excluded.

## B. Files removed

No original local files or production objects were deleted. The public distribution excludes local environment and credential files, raw deployment evidence, original screenshots, production provisioning/cleanup scripts, dumps/audio, dependency trees, caches and agent-local artifacts. The operator's artifact-inventory.tsv classifies each original file; do-not-commit.txt lists exact private paths. Removal here means exclusion from shipping.

## C. Files sanitized

All six n8n exports: removed workflow/credential/instance identifiers, activation metadata, sharing/static/pinned/execution data and notes; cleared TI-00 deployment identities and subworkflow references; generalized webhook path. Every export is inactive. Two redacted binary settings and binary node properties plus one connection were resolved from the local matching proposal; no redaction placeholder remains in workflow JSON. Optional deployment binaryMode was omitted. Credential/subworkflow bindings are explicitly documented.

Replaced installation/docs/environment examples and fixed deployment names through project-scoped Compose services. Added a distinct SELECT-column reader instead of the desktop owner/Docker transport. Original six migration files are byte-for-byte unchanged, with a checksum manifest. Synthetic backend tests use a disposable-container label/name guard. Root builder keeps its independent 2.0.0 version; Relay VERSION and console metadata prepare product v1.0.0.

## D. Secret/privacy scans

Gitleaks 8.30.1 directory scan of the public package: **0 findings**. Post-packaging custom privacy scan: **0 unresolved findings**, including comparison against five local secret values without printing them. The private-IP test fixture is a reviewed synthetic forwarded-header rejection case. No media/dumps/audio ship. Pattern scanning cannot prove all privacy categories.

Original source scan, with generated/dependency artifacts excluded, found only these scanner categories (values withheld):

| File | Category |
| --- | --- |
| .env | JWT/API credential |
| planning/ticket-intake-v1/ti05-creation-verification.json | Generic API-key candidate |
| deployment/ticket-postgres/secrets/admin-password.txt | Local database credential file (privacy inventory) |
| deployment/ticket-postgres/secrets/runtime-password.txt | Local database credential file (privacy inventory) |

All are excluded. The generic API-key candidate requires private operator review, not an assumption of exposure. Original .env variants, screenshots and reports remain private. No production credentials were rotated.

## E. Git-history scan

The release intentionally uses a new sanitized history rooted at parentless commit `7a044cf9423ae9ef908a0360fdf07e14136d4872`, produced from the verified release candidate. It does not preserve or import private development history, which may remain private. The release graph and all release refs are scanned independently. This provenance gate is PASS. Historical credential remediation in private development remains a separate operator responsibility; it is not a requirement to import private history.

## F. Docker clean install

Fresh disposable Git snapshot checked out using checkout-index; dependencies installed from lockfiles; frontend image built; new named PostgreSQL/n8n volumes; all three services healthy; authenticated frontend database projections reachable; setup safely rerunnable. No hidden original environment/secret/DB state was copied. Six workflows imported into disposable n8n and exported back: **all inactive**. Node credential rebinding and actual provider execution remain manual. PostgreSQL has no host port; editor/console ports bind loopback.

Recorded checks (exit 0 is success):

- clean-root-npm-ci: 0
- clean-root-check: 0
- clean-frontend-check: 0
- compose-config: 0
- compose-build: 0
- compose-up: 0
- installation-verify: 0
- setup-rerun: 0
- workflow-import: 0
- workflow-export: 0
- workflow-export-read: 0
- database-hardening: 0
- synthetic-backup-fixture: 0
- backup: 0
- restore-bootstrap: 0
- restore: 0
- restore-record-verification: 0

## G. Fresh migrations and recovery

PostgreSQL 18.6: migrations 001–006 applied to empty ticket_system under ticket_owner. Six ledger checksums match unchanged source files; required functions and retention policy verified. Selected-column frontend grants verified through actual authenticated BFF reads. Migration 004 retains its historical .proposed filename to preserve migration ledger identity.

Backend isolated suite: **35 passed**; randomized test database removed and baseline application DB/cluster roles unchanged. Application pg_dump/pg_restore rehearsal into a second new disposable project succeeded; the synthetic Acme Demo SL record was restored. A separate consistent stopped n8n state archive restored six inactive workflows with its key preserved. Real credential decryption and external provider acceptance were not tested.

## H. Code quality and dependencies

Original and packaged root/frontend checks pass: typecheck, tests and production builds. Root generic suite: 78 passed. Packaged synthetic workflow contracts: 35 passed. Frontend suite and loopback smoke checks pass. Fresh-copy npm ci/check and Docker frontend build pass. No configured formatter/linter exists; neither is claimed passed. New artifacts use explicit LF/text/JSON formatting; a formal lint/format policy is deferred.

Root and frontend npm audit: **0 known vulnerabilities**. Frontend npm outdated: no outdated packages. Root's newer major TypeScript and @types/node are intentionally deferred; current supported versions pass. Direct runtime dependencies are used by the implementation; no obvious unused runtime package was found. No blind major upgrades were performed. Image/CVE auditing beyond npm audit remains an operator/deployment review item.

## I. Documentation

README, SECURITY, CONTRIBUTING, proposed CHANGELOG, VERSION, environment example, configuration/architecture/installation/n8n/Telegram/security/troubleshooting/development/migration-center/backup guides and release checklist created. Docs files: architecture.md, artifact-classification.md, backup-restore.md, configuration.md, development.md, github-presentation.md, installation.md, migration-center.md, n8n-setup.md, release-checklist.md, security.md, telegram-setup.md, troubleshooting.md, workflow-settings.json. Production screenshots are excluded, with no fake synthetic screenshot claim. Assets/Jira/Zendesk/write operations are described as unimplemented.

## J. Remaining manual setup

Configure your own secrets and URL-encoded reader connection string. Create n8n owner and Postgres/Telegram/Header Auth/Groq credentials. Import workflows, bind every credential and TI-00 reference, configure your bot/operator identities, review schedules/retention, publish manually in documented order, configure HTTPS and register the Telegram webhook manually. Complete a manual voice-to-ticket test using a separate test bot. Enable private vulnerability reporting on the chosen GitHub repository.

## K. License

The operator selected Apache-2.0. The canonical Apache text is included unchanged in LICENSE; package metadata and README agree. Dependency licenses remain independent.

## L. Remaining concerns

Intentional sanitized release history; real credential/provider acceptance untested; single-reader Basic Auth needs HTTPS and deployment-specific access controls; transcripts/backups retain personal information beyond audio purge; uncertain sends require explicit reconciliation. No complete identity/multi-user authorization exists. Formatter/linter policy and image-level vulnerability audit are deferred and transparently reported. None of these justify touching production data or rotating credentials without approval.

## M. Files that must not be committed

Publish only the reviewed package. Exact original private paths are in the operator's do-not-commit.txt; excluded categories include .env and all .env variants except .env.example, credential text/exports, planning/ evidence, original screenshot directories, result/application JSON from local deployment tests, audit-local/ (including scanner logs, synthetic secrets, Git test snapshots and restore archives), backups/, node_modules/, .next/, dist/, audio/dumps and local IDE/agent files. The ZIP allowlist excludes all of them. Do not commit the packaging scratch scripts or the original parent workspace accidentally.

## N. GitHub proposal

Name: **relay**. About: **Self-hosted AI-assisted IT ticket intake with Telegram voice, PostgreSQL queues, n8n automation, Groq and a read-only operations console.** Topics: n8n, telegram, postgresql, itsm, helpdesk, ticketing, automation, ai, groq, self-hosted, typescript, nextjs.

## O. GO / NO-GO

**NO-GO for public GitHub push.** Local packaging, fresh installation, inactive imports, backend tests and restore rehearsals passed. Complete manual provider acceptance, review the remaining deployment controls, and obtain explicit publication authorization. No workflow execution, activation, deletion, production DB mutation, credential rotation, release tag or public push occurred in this sprint.
