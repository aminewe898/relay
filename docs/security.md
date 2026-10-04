# Security and privacy

Secrets belong in ignored local environment files, a secret manager and n8n credentials. Docker environment inspection is privileged access; protect the host and avoid publishing `docker compose config` output. Setup uses `config --quiet`. No credential export is included. Keep n8n encryption key separate from encrypted state backups and preserve it across updates.

Ingress validates Telegram's secret header and independently authorizes operator user, private chat, human sender and supported update kind. A correct webhook secret alone does not authorize ticket intake. Use HTTPS, limit ingress at the proxy and keep n8n editor private. Console Basic Auth is an initial single-reader gate, not multi-user authorization; use TLS off loopback. Rate limits and identity integration require deployment review.

## Database roles

The bootstrap login migrates a fresh database. ticket_owner is NOLOGIN and owns objects; it is not a runtime credential. ticket_n8n is a restricted LOGIN role receiving the preserved SECURITY DEFINER function grants, not broad table privileges. Functions fix their search_path and enforce fencing/scope. ticket_backend_read and ticket_backend_admin are NOLOGIN capabilities from hardening; no login is automatically granted the reconciliation capability.

relay_reader is a separate read-only LOGIN, granted only selected business/projection columns needed by the existing BFF. It has no access to audio, raw message payloads, lease tokens, provider outputs, or outbox payloads. Transcript/extraction business fields are readable because the UI displays incident context; restrict console users accordingly. Read-only defaults supplement explicit privilege restrictions. V1 exposes no write-capable frontend/API role. Do not grant the bootstrap/owner or reconciliation privileges to the console.

Audio, transcripts, emails and customer records are personal data. Define an organizational retention/legal basis and restrict backup access. Audio retention does not purge transcripts. n8n execution saving is disabled to avoid duplicate payload persistence. Deleted audio remains in older backups until backup retention expires. Encrypt offsite copies and test restore into an isolated environment.

AI output is untrusted: schema validation and deterministic customer resolution form the boundary. Do not allow model-provided identities, SQL or arbitrary URLs to become trusted actions. Uncertain Telegram sends require evidence and explicit reconciliation; never blindly resend.

## Source/history remediation

The release repository intentionally begins with the verified sanitized candidate as a new parentless commit. Private development history is not part of this distribution and may remain private. No private history is imported. Scan all release refs before publication. Separately, if credentials were ever committed or shared in private development, arrange operator-approved remediation; sanitizing the release does not revoke exposed credentials.

The release excludes local environment/credential files, production evidence, screenshots, dumps and operational cleanup scripts. Publish only the reviewed distribution. Provenance passes when the release graph matches this intentional history; private historical exposure is a separate security responsibility.

With Gitleaks installed, run `gitleaks dir --redact=100 --config .gitleaks.toml .` against the intended distribution and `gitleaks git --redact=100 --log-opts="--all --reflog" .` against every original checkout/history source. Store any reports only under ignored audit-local/. Publish findings as file plus category; do not post raw match/context/author data. The generated/dependency/audit exclusions are explicit in .gitleaks.toml and do not exempt application source or environment files from scanning.
