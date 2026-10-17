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

  # A tunnel's own address - never Cloudflare's API domain.
  #
  # A failed quick tunnel logs: Post "https://api.trycloudflare.com/tunnel":
  # lookup api.trycloudflare.com - no such host. That matches any loose pattern
  # for a trycloudflare address, and reading it as the tunnel's name pointed the
  # app at Cloudflare's API, which was then reported as reachable, while
  # confirmations went to an address that cannot receive them. The subdomain of
  # the API endpoint is the one thing cloudflared itself will never be.
  $pattern = 'https://(?!api\.)[a-z0-9-]+\.trycloudflare\.com'

  $readAddress = {
    foreach ($file in $logs) {
      if (-not (Test-Path $file)) { continue }
      $match = Select-String -Path $file -Pattern $pattern -ErrorAction SilentlyContinue |
        Select-Object -Last 1
      if ($match) {
        return [regex]::Match($match.Line, $pattern).Value
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

# Tell the app which address to confirm to.
#
# Writes it as a setting rather than hoping the app notices. The app refuses to
# overwrite a callback it believes was chosen deliberately, and a tunnel address
# that has died looks exactly like one - a well-formed https URL. Asking the app
# to notice cannot work here, because the only evidence is that the old address
# no longer answers, and nothing in the app checks that.
#
# So the change is made explicitly, down the same path an operator would use, and
# the app treats it as deliberate. That is right: this script knows the current
# address, rather than guessing at it.
function Set-AppCallback($address) {
  $login = @{
    identifier = 'admin'
    password   = 'admin123'
  } | ConvertTo-Json

  $token = (Invoke-RestMethod -Method Post `
    -Uri 'http://localhost:8080/the-team/api/auth/admin-login' `
    -ContentType 'application/json' -Body $login -TimeoutSec 8).token

  Invoke-RestMethod -Method Put -Uri 'http://localhost:8080/the-team/api/settings' `
    -Headers @{ Authorization = "Bearer $token" } `
    -ContentType 'application/json' `
    -Body (@{ values = @{ mpesa_callback_url = "$address/the-team/api/mpesa/callback" } } |
      ConvertTo-Json -Depth 4) `
    -TimeoutSec 8 | Out-Null

  $status = (Invoke-RestMethod -Method Get `
    -Uri 'http://localhost:8080/the-team/api/mpesa/status' `
    -Headers @{ Authorization = "Bearer $token" } -TimeoutSec 8)

  return $status.callback_url -eq "$address/the-team/api/mpesa/callback"
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

  # Apache and the app may not be up yet at sign-in, and a brand new address
  # takes a few seconds to serve. Retrying here is the difference between the
  # app being repointed within seconds of a reboot and it staying pointed at a
  # dead address until somebody notices.
  $pointed = $false

  for ($attempt = 1; $attempt -le 10; $attempt++) {
    try {
      if (Set-AppCallback $address) { $pointed = $true; break }
    } catch {
      # The app being unreachable is expected this early; keep trying.
    }

    if ($attempt -lt 10) { Start-Sleep -Seconds 5 }
  }

  if ($pointed) {
    Write-Status 'the app is pointed at the current address'
  } else {
    Write-Status 'WARNING: could not point the app at the new address'
  }
}

Write-Status 'done'