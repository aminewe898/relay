$ErrorActionPreference = 'Stop'
& node (Join-Path $PSScriptRoot 'ops.mjs') verify-installation @args
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
