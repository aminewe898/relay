$ErrorActionPreference = 'Stop'
& node (Join-Path $PSScriptRoot 'ops.mjs') migrate @args
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
