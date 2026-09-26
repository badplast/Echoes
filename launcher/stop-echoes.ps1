# Stops every ECHOES dev server started from this project (by the launcher or by hand).

$ProjectDir = Split-Path -Parent $PSScriptRoot
$PidFile = Join-Path $env:LOCALAPPDATA 'ECHOES\server.pid'
$needle = [Regex]::Escape((Join-Path $ProjectDir 'node_modules'))

$procs = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
    Where-Object { $_.CommandLine -match $needle -and $_.CommandLine -match 'vite' }
foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
Remove-Item -LiteralPath $PidFile -ErrorAction SilentlyContinue

$msg = if ($procs) { "ECHOES server остановлен." } else { "ECHOES server не был запущен." }
if ($args -notcontains '-Quiet') { (New-Object -ComObject WScript.Shell).Popup($msg, 3, 'ECHOES', 64) | Out-Null }
else { Write-Output $msg }
