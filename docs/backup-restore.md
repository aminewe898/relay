# Backup and restore

Run `sh scripts/backup.sh` or `powershell -File scripts/backup.ps1`. It produces an application PostgreSQL custom-format dump in ignored backups/. The dump includes schema and personal/audio data; it does not include global roles, n8n state or encryption key. Encrypt it promptly, restrict permissions and keep independent offsite copies. Choose retention that accounts for audio remaining in old backups after live purge.

Separately back up n8n's named volume consistently while n8n is stopped during an operator-approved maintenance window. Preserve its credential encryption key in a protected secret store. Do not publish credential exports. Restore n8n state/key only into a private isolated instance; do not enable inherited schedules or webhooks unexpectedly. The application restore script does not restore n8n automatically.

For a planned maintenance window on the intended deployment, create the ignored backups/ directory and use a stopped-volume archive. These commands are manual operator actions:

```sh
mkdir -p backups
docker compose stop n8n
docker compose run --rm --no-deps --user 0 --entrypoint tar --volume "$(pwd)/backups:/backup" n8n -C /home/node/.n8n -czf /backup/n8n-state.tar.gz .
docker compose start n8n
```

Do not run a volume archive while SQLite is changing. Encrypt the archive and retain the exact N8N_ENCRYPTION_KEY separately. During an isolated restore, use a new empty n8n volume, supply that same key, keep external ingress unreachable, and extract the archive with the service stopped:

```sh
docker compose run --rm --no-deps --user 0 --entrypoint tar --volume "$(pwd)/backups:/backup:ro" n8n -C /home/node/.n8n -xzf /backup/n8n-state.tar.gz
```

Inspect restored workflow activation state before starting the restored service; backups from production can contain published schedules. The release rehearsal uses only six inactive imports. On PowerShell, replace `$(pwd)` with `${PWD}` and create the directory with `New-Item -ItemType Directory -Force backups`. Workers/credentials from a production backup require an explicit cutover plan; never assume the inactive test snapshot represents a safe production restore.

## Disposable restore rehearsal

Use a new copy with COMPOSE_PROJECT_NAME=relay-restore-<unique>, unique loopback ports and distinct local secrets. Start a fresh database with scripts/migrate.*. Keep n8n workflows inactive and external webhook registration absent. Run:

```sh
sh scripts/restore.sh /absolute/path/to/relay.dump --confirm-disposable
# Windows: powershell -File scripts/restore.ps1 C:/private/relay.dump --confirm-disposable
```

The script requires the explicit disposable project prefix and confirmation flag and rejects existing application data. It replaces the schema only in that destination, restores the dump and checks migration hashes/functions/policy. The destination bootstrap recreates login roles and passwords. Examine restored business records locally and run installation verification when the console/n8n are configured. Rebind restored credentials before any manual activation. Never point this procedure at production.

Application-only backup/restore rehearsal results are in release-report.md. Full n8n recovery requires a separately reviewed state/key backup and restore drill. Live production restoration, credential rotation and data purge require a distinct operator-approved procedure.
