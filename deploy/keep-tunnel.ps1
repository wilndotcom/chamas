# Keeps the public address alive, and the app pointed at it.
#
# Two problems, one cause. Safaricom cannot reach localhost, so confirmations
# need a public address; and a trycloudflare address changes every time the
# tunnel restarts, so whatever the app was told last time is soon wrong.
#
# This runs at Windows sign-in and stays in the background:
#
#   - starts cloudflared if it is not running, and waits for its address
#   - tells the app the address, by asking it a question through it
#
# That second step is the whole point. The app works out a confirmation
# address from the request it is given, so a single request arriving through
# the tunnel is enough for it to record that address by itself. Nobody has to
# open the app at the tunnel address, and nobody has to be told there is one.
#
# Run it now:  powershell -ExecutionPolicy Bypass -File keep-tunnel.ps1

$ErrorActionPreference = 'Stop'

$cloudflared = 'C:\Program Files (x86)\cloudflared\cloudflared.exe'
$logDir      = Join-Path $env:TEMP 'the-team-tunnel'
$urlFile     = Join-Path $logDir 'url.txt'
$stateFile   = Join-Path $logDir 'state.json'

New-Item -ItemType Directory -Force -Path $logDir | Out-Null

function Write-Status($message) {
  # A single line, so a log is readable months later.
  "{0}  {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $message |
    Add-Content -Path (Join-Path $logDir 'keep-tunnel.log')
}

function Get-TunnelAddress {
  param(
    [int]$WaitSeconds = 30,
    # True when this run started cloudflared itself.
    #
    # Then only its own log may be read. Falling back to an older log in that
    # case returns the address of the tunnel that was just killed - which is
    # exactly the address the app must stop using - and the app is left
    # pointed at a dead name while a working one goes unnoticed.
    [switch]$OwnLogOnly
  )

  $own = Join-Path $logDir 'cloudflared.err'

  $logs = if ($OwnLogOnly) {
    @($own)
  } else {
    @(
      $own
      (Join-Path $env:TEMP 'opencode\cf.log.err')
      (Join-Path $env:TEMP 'opencode\cf.log')
    )
  }

  $readAddress = {
    foreach ($file in $logs) {
      if (-not (Test-Path $file)) { continue }
      $match = Select-String -Path $file `
        -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -ErrorAction SilentlyContinue |
        Select-Object -Last 1
      if ($match) {
        return [regex]::Match($match.Line, 'https://[a-z0-9-]+\.trycloudflare\.com').Value
      }
    }
    return $null
  }

  $found = & $readAddress
  if ($found) { return $found }

  $deadline = (Get-Date).AddSeconds($WaitSeconds)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 2
    $found = & $readAddress
    if ($found) { return $found }
  }

  return $null
}

function Start-Tunnel {
  $err = Join-Path $logDir 'cloudflared.err'
  $out = Join-Path $logDir 'cloudflared.out'

  Start-Process -FilePath $cloudflared `
    -ArgumentList 'tunnel', '--url', 'http://localhost:8080', '--no-autoupdate' `
    -RedirectStandardOutput $out -RedirectStandardError $err -WindowStyle Hidden

  Write-Status 'cloudflared started'
}

# Log in, because the app records the address from the request it is given.
function Confirm-AppKnows($address) {
  $login = @{
    identifier = 'admin'
    password   = 'admin123'
  } | ConvertTo-Json

  try {
    $token = (Invoke-RestMethod -Method Post -Uri "$address/the-team/api/auth/admin-login" `
      -ContentType 'application/json' -Body $login -TimeoutSec 20).token

    if (-not $token) { return $false }

    # A status request is enough: that is where the app records the address.
    Invoke-RestMethod -Method Get -Uri "$address/the-team/api/mpesa/status" `
      -Headers @{ Authorization = "Bearer $token" } -TimeoutSec 20 | Out-Null

    $status = (Invoke-RestMethod -Method Get `
      -Uri 'http://localhost:8080/the-team/api/mpesa/status' `
      -Headers @{ Authorization = "Bearer $token" } -TimeoutSec 20)

    return $status.callback_url -eq "$address/the-team/api/mpesa/callback"
  } catch {
    return $false
  }
}

# Once, now, so the machine is in the right state without waiting for a reboot.
$current = $null
if (Test-Path $urlFile) { $current = (Get-Content $urlFile -Raw).Trim() }

$started = $false

if (-not (Get-Process cloudflared -ErrorAction SilentlyContinue)) {
  Write-Status 'no tunnel running, starting one'
  Start-Tunnel
  $started = $true
  $current = $null
}

$address = $current
if (-not $address) {
  $address = Get-TunnelAddress -OwnLogOnly:$started
}

if (-not $address) {
  Write-Status 'cloudflared started but has not published an address yet'
} else {
  if ($address -ne $current) {
    $address | Set-Content -Path $urlFile -NoNewline
    Write-Status "public address is now $address"
  }

  if (Confirm-AppKnows $address) {
    Write-Status 'the app is pointed at the current address'
  } else {
    # A brand new address takes a few seconds to serve traffic. Retrying here
    # is the difference between the app being repointed within seconds of a
    # reboot and it staying pointed at a dead address until somebody notices.
    Write-Status 'address is live but the app has not picked it up yet, retrying'
    for ($attempt = 1; $attempt -le 6; $attempt++) {
      Start-Sleep -Seconds 5
      if (Confirm-AppKnows $address) {
        Write-Status "the app is pointed at the current address (attempt $attempt)"
        break
      }
    }

    if ((Get-Content (Join-Path $logDir 'keep-tunnel.log') -Tail 1) -notmatch 'pointed at the current') {
      Write-Status 'WARNING: could not point the app at the new address'
    }
  }
}

Write-Status 'done'