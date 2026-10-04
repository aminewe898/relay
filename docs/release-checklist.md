# Final pre-public release checklist

Checked 2026-10-04. See [final report](final-pre-public-report.md) and [manual acceptance](manual-acceptance.md). Every result below is explicit; historical evidence is distinguished from a fresh packaged-release test.

| Check | Status | Evidence / justification |
| --- | --- | --- |
| Apache-2.0 | PASS | Canonical LICENSE, README and both package/lock metadata; pushed privately. |
| Sanitized history provenance | PASS | Parentless verified candidate 7a044cf; no private development history imported. |
| Current files and all release history secret scan | PASS | Gitleaks 8.30.1 zero findings; privacy comparison zero unresolved findings. |
| TruffleHog | DEFERRED WITH JUSTIFICATION | Not installed; reputable Gitleaks plus privacy checks used. |
| Excluded files / environment example | PASS | No tracked environment secrets, backups, audio, runtime state or original private directories; .env.example present. |
| Six workflows and migration integrity | PASS | Exports remain inactive and credential-free; workflow blobs unchanged; migrations 001–006 match checksums and initial commit. |
| Root tests, workflow contracts, frontend and backend | PASS | 78 + 35 + 11 + 35 = 159, unchanged baseline. |
| Typechecks / builds / frontend smoke | PASS | Root and frontend check commands completed successfully from fresh GitHub contents. |
| Docker config / fresh installation | PASS | Synthetic disposable projects only; fresh PostgreSQL, frontend/n8n healthy, six inactive imports. |
| Retention / maintenance | PASS | 72h audio hard TTL, 1h success grace, 48h interaction expiry, batch 50 bounded; preserved transcripts/extractions documented and backend tests pass. |
| Application backup / restore | PASS | Packaged tooling; fresh restore matches six ledger entries, fixture count, zero tickets, three required functions and role restrictions. |
| Rehearsal container / volume cleanup | PASS | Only newly created disposable projects removed; labels checked, no remaining associated containers/volumes. |
| Local rehearsal files cleanup | PASS | Operator removed the exact old rehearsal audit directory; Test-Path confirms it absent. New acceptance deployment retained. |
| Historical controlled provider acceptance | PASS | Private report and persisted proof: one voice/reply/intake/ticket, sent confirmation, stages successful, no duplicates/leases/uncertain sends. |
| Fresh packaged Telegram/Groq acceptance | DEFERRED WITH JUSTIFICATION | Operator explicitly accepted historical controlled end-to-end evidence instead of repeating setup. Unchanged workflows, clean imports and 159 passing tests supplement that evidence. Fresh-install credential rebinding and provider execution remain untested end to end; this is a documented accepted release risk, not a new test PASS. |
| npm vulnerability audit | PASS | Root/frontend zero known vulnerabilities, including high/critical. |
| Network / image configuration | PASS | Postgres no host port; editor/console loopback; configured images resolve locally; HTTPS/reverse proxy access controls documented. |
| Image-level CVE audit | DEFERRED WITH JUSTIFICATION | npm audit does not assess OS/image CVEs; deployment review remains required, no unsupported clean-image claim. |
| Formatter / linter | DEFERRED WITH JUSTIFICATION | None configured or promised; documented; tests/typechecks/builds pass. |
| Tooling major upgrades | DEFERRED WITH JUSTIFICATION | Unrelated major upgrades excluded from release scope. |
| Documentation review | PASS | Architecture, setup, credentials, import/rebinding, publication order, webhook warning, voice test, recovery, retention and security reviewed. |
| Private vulnerability reporting | REQUIRES OPERATOR ACTION | Private reporting GET returns 404. GitHub documents this feature for public repositories. Enable/verify at the separately authorized publication step; repository remains private. |
| GitHub metadata / main / README / license | PASS | Integration confirms private main, Apache-2.0, expected description/topics, Pages disabled; README renders and relative links resolve. |
| GitHub tags / releases / branches / pushed tree | PASS | Main only; no tags/releases; expected files and latest commit pushed. |
| GitHub Packages enumeration | PASS | Authenticated repository GraphQL packages.totalCount = 0; count-only query succeeds without broader permissions. |
| Public visibility / v1.0.0 tag / GitHub Release | REQUIRES OPERATOR ACTION | Intentionally not performed; explicit operator GO required after blocking gates. |

PUBLIC RELEASE READY: YES, with the operator-approved acceptance deferral above. Cleanup and package absence are verified. Private vulnerability reporting must be enabled and verified at the separately authorized public-visibility step, before announcing the release. Repository visibility, tag and GitHub Release still require explicit operator GO.
