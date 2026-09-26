# ECHOES launcher: opens the local ECHOES dev server in Chrome, starting it (hidden) if needed.
# Started by "ECHOES.vbs" so no console window appears. Does not modify the project.

$ErrorActionPreference = 'Stop'
$ProjectDir = Split-Path -Parent $PSScriptRoot
$StateDir = Join-Path $env:LOCALAPPDATA 'ECHOES'
$LogFile = Join-Path $StateDir 'server.log'
$ErrFile = Join-Path $StateDir 'server-error.log'
$PidFile = Join-Path $StateDir 'server.pid'
New-Item -ItemType Directory -Force -Path $StateDir | Out-Null

Add-Type -AssemblyName System.Windows.Forms

function Write-Log([string]$text) {
    Add-Content -LiteralPath (Join-Path $StateDir 'launcher.log') -Value ("{0:yyyy-MM-dd HH:mm:ss}  {1}" -f (Get-Date), $text) -Encoding UTF8
}

function Show-Error([string]$text) {
    Write-Log "ERROR: $($text -replace "`n", ' ')"
    [System.Windows.Forms.MessageBox]::Show($text, 'ECHOES', 'OK', 'Error') | Out-Null
}

function Show-Info([string]$text, [int]$seconds) {
    # Non-modal-ish notice that closes by itself.
    (New-Object -ComObject WScript.Shell).Popup($text, $seconds, 'ECHOES', 64) | Out-Null
}

# Port: whatever the project is configured for (vite.config.ts), Vite's default otherwise.
$Port = 5173
$config = Join-Path $ProjectDir 'vite.config.ts'
if (Test-Path -LiteralPath $config) {
    $m = Select-String -LiteralPath $config -Pattern 'port\s*:\s*(\d+)' | Select-Object -First 1
    if ($m) { $Port = [int]$m.Matches[0].Groups[1].Value }
}
$Url = "http://localhost:$Port/"

function Test-Echoes {
    try {
        $r = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2
        return ($r.StatusCode -eq 200 -and $r.Content -match 'ECHOES')
    } catch { return $false }
}

function Get-PortOwner {
    $c = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $c) { return $null }
    $p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
    if ($p) { return "$($p.ProcessName) (PID $($p.Id))" } else { return "PID $($c.OwningProcess)" }
}

function Open-Browser {
    $candidates = @(
        (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
        (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
    )
    $reg = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe' -ErrorAction SilentlyContinue
    if ($reg) { $candidates = @($reg.'(default)') + $candidates }
    $chrome = $candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
    if ($chrome) { Start-Process -FilePath $chrome -ArgumentList $Url; Write-Log "opened $Url in Chrome" }
    else { Start-Process $Url; Write-Log "opened $Url in default browser (Chrome not found)" }   # default browser (Web MIDI needs Chrome or Edge)
}

# One launcher at a time: a second double-click waits, then simply opens the browser.
$mutex = New-Object System.Threading.Mutex($false, 'Local\EchoesLauncher')
try {
    if (-not $mutex.WaitOne([TimeSpan]::FromSeconds(180))) { Open-Browser; exit 0 }

    if (Test-Echoes) { Write-Log "server already running on port $Port"; Open-Browser; exit 0 }

    $owner = Get-PortOwner
    if ($owner) {
        Show-Error "Порт $Port уже занят другой программой: $owner.`n`nECHOES не может запуститься на этом порту. Закройте эту программу или остановите ECHOES через launcher\Stop ECHOES.vbs и попробуйте снова."
        exit 1
    }

    # Node.js / npm
    $node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
    if (-not $node -and (Test-Path (Join-Path $env:ProgramFiles 'nodejs\node.exe'))) { $node = Join-Path $env:ProgramFiles 'nodejs\node.exe' }
    if (-not $node) {
        Show-Error "Не найден Node.js.`n`nУстановите Node.js (LTS) с https://nodejs.org и запустите ярлык ECHOES снова."
        exit 1
    }
    $npmCli = Join-Path (Split-Path -Parent $node) 'node_modules\npm\bin\npm-cli.js'

    # Dependencies: install only if Vite is actually missing.
    $vite = Join-Path $ProjectDir 'node_modules\vite\bin\vite.js'
    if (-not (Test-Path -LiteralPath $vite)) {
        if (-not (Test-Path -LiteralPath $npmCli)) {
            Show-Error "Не найден npm рядом с Node.js ($node).`n`nПереустановите Node.js с https://nodejs.org."
            exit 1
        }
        Show-Info "Первый запуск: устанавливаю зависимости ECHOES (около минуты)…" 4
        $inst = Start-Process -FilePath $node -ArgumentList "`"$npmCli`"", 'install', '--no-audit', '--no-fund' `
            -WorkingDirectory $ProjectDir -WindowStyle Hidden -Wait -PassThru `
            -RedirectStandardOutput (Join-Path $StateDir 'npm-install.log') -RedirectStandardError (Join-Path $StateDir 'npm-install-error.log')
        if ($inst.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $vite)) {
            $tail = (Get-Content -LiteralPath (Join-Path $StateDir 'npm-install-error.log') -Tail 8 -ErrorAction SilentlyContinue) -join "`n"
            Show-Error "Не удалось установить зависимости (npm install).`n`n$tail`n`nЛог: $StateDir"
            exit 1
        }
    }

    # Start the Vite dev server hidden, on the configured port only (no silent fallback to another port).
    $proc = Start-Process -FilePath $node -ArgumentList "`"$vite`"", '--port', $Port, '--strictPort' `
        -WorkingDirectory $ProjectDir -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput $LogFile -RedirectStandardError $ErrFile
    Set-Content -LiteralPath $PidFile -Value $proc.Id
    Write-Log "starting Vite (PID $($proc.Id)) on port $Port"
    $started = Get-Date

    $deadline = (Get-Date).AddSeconds(60)
    while ((Get-Date) -lt $deadline) {
        if (Test-Echoes) { Write-Log ("server ready after {0:N1} s" -f ((Get-Date) - $started).TotalSeconds); Open-Browser; exit 0 }
        if ($proc.HasExited) { break }
        Start-Sleep -Milliseconds 400
    }

    $tail = ((Get-Content -LiteralPath $ErrFile -Tail 6 -ErrorAction SilentlyContinue) + (Get-Content -LiteralPath $LogFile -Tail 6 -ErrorAction SilentlyContinue)) -join "`n"
    if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
    Show-Error "ECHOES server не запустился за 60 секунд.`n`n$tail`n`nЛоги: $StateDir"
    exit 1
}
catch {
    Show-Error "Ошибка запуска ECHOES:`n`n$($_.Exception.Message)`n`nЛоги: $StateDir"
    exit 1
}
finally {
    try { $mutex.ReleaseMutex() } catch {}
    $mutex.Dispose()
}
