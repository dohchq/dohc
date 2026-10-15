param([Parameter(Mandatory)][string]$Root)
# Submits the nightly verification of main through the installed queue service.
# The nightly scheduled task runs this script; it logs to nightly.log beside it.
$ErrorActionPreference = 'Stop'
$log = Join-Path $Root 'nightly.log'
try {
    $current = (Get-Content (Join-Path $Root 'current') -Raw).Trim()
    $queue = Join-Path $Root "service\$current\scripts\verification\queue.mjs"
    $env:DOHC_VERIFICATION_QUEUE_ROOT = $Root
    $output = & (Get-Command node.exe).Source $queue nightly 2>&1 | Out-String
    Add-Content $log "$(Get-Date -Format o) exit $LASTEXITCODE $($output.Trim())"
    exit $LASTEXITCODE
} catch {
    Add-Content $log "$(Get-Date -Format o) failed: $($_.Exception.Message)"
    exit 1
}
