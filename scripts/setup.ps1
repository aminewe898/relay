$ErrorActionPreference = 'Stop'
& node (Join-Path $PSScriptRoot 'ops.mjs') setup @args
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
