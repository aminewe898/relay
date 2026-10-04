# Architecture

```mermaid
flowchart LR
 Telegram --> TI01[TI-01 secure ingress]
 TI01 --> Queue[(PostgreSQL queue)]
 Queue --> TI02[TI-02 intake worker]
 TI02 <--> Groq
 TI02 --> TI03[TI-03 deterministic resolution]
 TI03 --> DB[(PostgreSQL tickets and customers)]
 DB --> TI04[TI-04 persistent outbox]
 TI04 --> Telegram
 TI05[TI-05 bounded maintenance] --> Queue
```

```mermaid
flowchart LR
 Browser --> Auth[Console authentication]
 Auth --> Next[Next.js UI and GET-only BFF]
 Next --> Projections[Whitelisted business projections]
 Projections --> DB[(PostgreSQL)]
 Workers[n8n runtime role] --> Functions[SECURITY DEFINER functions]
 Functions --> DB
```

```mermaid
stateDiagram-v2
 [*] --> queued
 queued --> leased: claim with token and expiry
 leased --> succeeded: fenced checkpoint
 leased --> queued: retryable failure or expired lease recovery
 leased --> needs_operator: exhausted or unsafe outcome
 succeeded --> [*]
 needs_operator --> [*]: explicit operator handling
```

The database persists queue ownership and checkpoints independently of n8n executions. TI-02 executes one download, transcription or extraction stage, then persists the result. A new execution claims subsequent work. A lease allows recovery after a crash; token/revision fencing prevents a late worker from overwriting newer work. Ingress identities and delivery keys deduplicate messages and sends.

AI provides transcription and schema-validated incident suggestions, never authoritative customer IDs or unrestricted actions. Deterministic database functions resolve identities, require missing information, gate critical priority and atomically finalize tickets. Original transcript is retained as evidence; it may contain personal information.

The outbox tracks send attempts durably. A timeout or malformed provider result can mean a message was sent; ambiguous outcomes become uncertain and require reconciliation. They are never automatically retried as if definitely rejected.

TI-05 runs bounded maintenance. Database backend_policy controls audio hard retention and interaction expiry; audio purge does not imply transcript deletion. Backups may retain deleted audio. The browser receives selected business fields and aggregated service observations, never credentials, raw audio, lease tokens or raw provider payloads. Persisted observations do not prove current worker availability.

The packaged PostgreSQL role model is documented in security.md. Read-only BFF column privileges are separate from the workflow runtime's function-only privileges. No raw n8n state is needed by the frontend.
