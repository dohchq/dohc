param([Parameter(Mandatory=$true)][int]$AppProcessId)
$ErrorActionPreference = 'Stop'
$captureStart = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$processes = @(Get-CimInstance Win32_Process)
$owned = [System.Collections.Generic.HashSet[int]]::new()
[void]$owned.Add($AppProcessId)
do {
  $changed = $false
  foreach ($entry in $processes) {
    if ($owned.Contains([int]$entry.ParentProcessId) -and !$owned.Contains([int]$entry.ProcessId)) {
      [void]$owned.Add([int]$entry.ProcessId)
      $changed = $true
    }
  }
} while ($changed)
$rows = @($processes | Where-Object { $owned.Contains([int]$_.ProcessId) } | ForEach-Object {
  [ordered]@{
    pid = [int]$_.ProcessId
    parentPid = [int]$_.ParentProcessId
    name = $_.Name
    path = $_.ExecutablePath
    createdAt = $_.CreationDate.ToUniversalTime().ToString('o')
    cpuMs = ([double]$_.KernelModeTime + [double]$_.UserModeTime) / 10000
    privateBytes = [double]$_.PrivatePageCount
    workingSetBytes = [double]$_.WorkingSetSize
    readBytes = [double]$_.ReadTransferCount
    writeBytes = [double]$_.WriteTransferCount
    otherBytes = [double]$_.OtherTransferCount
    readOperations = [double]$_.ReadOperationCount
    writeOperations = [double]$_.WriteOperationCount
    otherOperations = [double]$_.OtherOperationCount
  }
})
[ordered]@{ startedAtMs = $captureStart; completedAtMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); processes = $rows } | ConvertTo-Json -Depth 5 -Compress
