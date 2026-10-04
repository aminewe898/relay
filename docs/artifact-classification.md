# Distribution boundary and artifact classification

The public candidate uses an explicit allowlist. Generic implementation, tests and migration bytes ship; historical planning, raw deployment evidence, original screenshots, local configuration, credential files, provisioning/cleanup scripts, build output and audit archives do not.

Public documentation: rewritten README, setup/configuration/security/architecture/troubleshooting/backup/release docs. Developer documentation: development and contribution guides, builder code and synthetic tests. Test evidence: concise release-report summary; raw results remain ignored/private. Internal/remove: local environments, secret files, production screenshots, operational cleanup/provisioning scripts and payload-bearing verification artifacts are excluded from distribution. Original local files are retained; nothing was purged from production.

Every original non-generated file is classified in the operator's private artifact-inventory.tsv beside the release package. The exact private-file list is do-not-commit.txt in that same operator release directory. Publish only this clean package as a new root, not its parent development workspace. Any historical repository must be independently audited first.
