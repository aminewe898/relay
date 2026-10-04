$ErrorActionPreference = 'Stop'
& node (Join-Path $PSScriptRoot 'ops.mjs') backup @args
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
