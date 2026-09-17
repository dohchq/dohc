$ErrorActionPreference = 'Stop'
$startedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$cpu = Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter "Name='_Total'"
$os = Get-CimInstance Win32_OperatingSystem
$rows = @(Get-Process | ForEach-Object {
  $createdAt = $null
  try { $createdAt = $_.StartTime.ToUniversalTime().ToString('o') } catch {}
  [ordered]@{ pid = $_.Id; name = $_.ProcessName; createdAt = $createdAt; cpuSeconds = $_.CPU; workingSetBytes = $_.WorkingSet64 }
})
[ordered]@{
  startedAtMs = $startedAt
  completedAtMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  cpuPercentTotal = $cpu.PercentProcessorTime
  freePhysicalBytes = [double]$os.FreePhysicalMemory * 1024
  totalPhysicalBytes = [double]$os.TotalVisibleMemorySize * 1024
  processes = $rows
  limits = 'CPU percentage is the Windows formatted counter snapshot. Process CPU is lifetime CPU; compare PID plus creation time across snapshots for deltas. No process commands or user data are captured.'
} | ConvertTo-Json -Depth 5 -Compress
