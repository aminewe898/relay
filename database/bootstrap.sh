#!/usr/bin/env bash
set -Eeuo pipefail
test "$POSTGRES_DB" = ticket_system || { echo 'Immutable migrations require ticket_system'; exit 1; }
cd /opt/relay/database
export MIGRATION_SHA256=$(sha256sum migrations/006_backend_hardening.sql | cut -d ' ' -f1)
psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -f roles.sql
for file in migrations/00*.sql; do
  { printf 'SET ROLE ticket_owner;\n'; cat "$file"; } | psql -X -v ON_ERROR_STOP=1 -v migration_sha256="$MIGRATION_SHA256" -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null
done
psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -f reader.sql
echo 'Relay migrations 001-006 applied to fresh database.'
