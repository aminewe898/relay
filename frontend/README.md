# Relay console

Next.js frontend with a colocated read-only BFF. Deploy using root Compose with PostgreSQL transport and a dedicated column-restricted relay_reader login. Configure Basic Auth and HTTPS off loopback. No runtime mocks or writes exist. Assets and external imports are unimplemented.

Run npm ci, npm run check, npm run dev for local development. The local-docker transport is desktop developer tooling only and is excluded from deployment configuration. See ../docs/development.md, ../docs/configuration.md and ../docs/security.md.
