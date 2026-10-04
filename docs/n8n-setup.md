# n8n installation and workflow binding

Use a new n8n instance/project. Imports have no production workflow IDs, no credential references, no static or pinned data, and `active:false`. Import each JSON from `n8n/workflows/` through the editor's Import from File. Never import into an unrelated production workflow.

1. Create a Postgres credential: host `postgres`, port `5432`, database `ticket_system`, user `ticket_n8n`, password matching TICKET_RUNTIME_PASSWORD. This private Compose connection does not use a published database port.
2. Create a Telegram API credential for your bot token. TI-02 downloads voice and TI-04 sends replies with this same bot.
3. Create Header Auth with name `X-Telegram-Bot-Api-Secret-Token` and value matching your webhook secret. Bind it to TI-01's generic Webhook node. Do not store the value in TI-00.
4. Create a Groq API credential and bind both transcription and extraction HTTP Request nodes in TI-02.
5. Import TI-00 through TI-05. Keep them inactive while binding every applicable node. `n8n/credential-bindings.json` lists node names and credential types, without any real IDs.
6. In every `Load TI-00 Configuration` Execute Sub-workflow node, select your newly imported TI-00. Blank exported references intentionally require this selection. Do not paste an ID from the original deployment.
7. Edit TI-00's configuration Code node: botId, botUsername, operatorUserId, operatorChatId. Numeric IDs must be positive decimal strings, including chat ID; V1 supports an authorized private chat, not group chats. Empty values fail closed. Configure ingress/retry/priority policies as documented in configuration.md. Environment setup inputs are not automatically substituted into TI-00.
8. Review schedule intervals, execution-data saving (disabled), outbound credentials, backend_policy and retention. Manually publish TI-00 if required for subworkflow calls, then TI-05, TI-03, TI-04, TI-02, and TI-01 last. All activation/publishing is a user action.
9. Register your Telegram webhook with the secret after the production endpoint is reachable over HTTPS. Then run the manual voice acceptance test.

TI-01 uses a generic POST Webhook with Header Auth so Telegram's secret header is validated before authorized updates reach the persistent queue. The native Telegram Trigger manages bot webhook registration and can replace the production URL during tests. Telegram allows one webhook per bot: use a separate test bot and never attach a Telegram Trigger to your production bot.

Workflow structural validation passed for all six exports. Structural validation does not prove installed node schemas, credentials or execution success. Redacted binary fields and one TI-02 connection were recovered from the matching local proposal; deployment-only binaryMode was omitted. Import into disposable n8n is separately checked in release-report.md.

Official references: [n8n Docker](https://docs.n8n.io/hosting/installation/docker/), [CLI import](https://docs.n8n.io/hosting/cli-commands/), [webhook endpoints](https://docs.n8n.io/hosting/configuration/environment-variables/endpoints/). Current docs use N8N_WEBHOOK_URL; the older WEBHOOK_URL alias is deprecated.
