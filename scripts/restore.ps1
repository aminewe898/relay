$ErrorActionPreference = 'Stop'
& node (Join-Path $PSScriptRoot 'ops.mjs') restore @args
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
