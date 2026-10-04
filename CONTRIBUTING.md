# Contributing

Read docs/development.md and AGENTS.md. Install root/frontend dependencies with npm ci. Use small branches and focused PRs explaining the behavior, risk and validation. Run root/frontend checks and the disposable install rehearsal for deployment changes.

Never modify an already-applied migration. Add forward migrations with reviewed upgrade and fresh-install behavior. Keep workflow exports inactive, remove credential/instance references and private data, preserve every intended node and connection, and document credential rebinding. Workflow repair requires diagnosis, validation, semantic diff and inactive/version-fenced updates.

Use synthetic fixtures and loopback/mocked providers; never test against production without explicit authorization. Preserve idempotency, fencing, interaction correlation, retention and uncertain-send rules. Do not add fixture fallbacks to the runtime console. Security-sensitive changes need explicit threat/privilege review. Report vulnerabilities privately using SECURITY.md. Never include secrets, personal data, audio, screenshots of production or raw dumps in issues/PRs.
