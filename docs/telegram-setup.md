# Telegram setup

Create a dedicated bot with @BotFather using /newbot. Store the token only in n8n's Telegram credential or an ignored operator secret environment. Never include it in a URL in logs, command arguments, screenshots or Git. Set bot ID/username and your operator user/chat IDs in TI-00 from your own verified account information; do not use an untrusted ID-discovery bot for private information.

Use a random webhook secret containing only A–Z, a–z, 0–9, underscore and hyphen (1–256 characters). Bind the same value to Header Auth named X-Telegram-Bot-Api-Secret-Token. The endpoint is `https://relay.example.com/webhook/relay-telegram-ingress`; replace the example domain and confirm the exact production URL in the Webhook node. Use production `/webhook/`, not temporary `/webhook-test/`.

Telegram requires publicly reachable HTTPS for the production callback. Configure reverse proxy forwarding and N8N_WEBHOOK_URL correctly. Expose the webhook route deliberately; restrict the n8n editor and other administrative endpoints.

To register a webhook, invoke Bot API `setWebhook` from a trusted local tool, using `url`, `secret_token`, and `allowed_updates:["message"]`. The token is part of the Bot API URL internally, so the tool must suppress URL/error logging. Do not use token-bearing curl examples in shared shell history. `getWebhookInfo` reports url, pending_update_count and last_error_message; redact private endpoint/error details before sharing. No Relay script registers or deletes webhooks automatically.

One webhook exists per bot. A native Telegram Trigger or test integration can overwrite it. Use a dedicated test bot. A blank getWebhookInfo URL means registration is absent. An illegal-secret error usually means the secret contains disallowed characters. For receive failures, check HTTPS, Header Auth, the published TI-01 URL, operator/private-chat scope and supported message kind. See troubleshooting.md.

Official reference: [Telegram Bot API](https://core.telegram.org/bots/api#setwebhook).
