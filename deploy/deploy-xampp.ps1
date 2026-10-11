#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Installs THE TEAM into XAMPP's htdocs.

.DESCRIPTION
    Builds the frontend for the /the-team prefix, copies the PHP backend and the
    built files into one folder, and places the Apache rules. After this you can
    open http://localhost/the-team and it works, with no Node running and no
    Apache configuration to edit.

    Safe to re-run. It replaces the installed copy rather than adding to it, so
    a previous install never leaves stale files behind to be served by mistake.

.EXAMPLE
    pwsh deploy-xampp.ps1
    pwsh deploy-xampp.ps1 -Open          # and open a browser when done
    pwsh deploy-xampp.ps1 -Remove        # uninstall
#>

param(
    [switch]$Open,
    [switch]$Remove
)

$ErrorActionPreference = 'Stop'

$project    = Split-Path -Parent $PSScriptRoot
$frontend   = Join-Path $project 'frontend'
$phpBackend = Join-Path $project 'backend-php'
$htdocs     = 'C:\xampp\htdocs'
$install    = Join-Path $htdocs 'the-team'
$prefix     = '/the-team'

function Write-Step($message) {
    Write-Host "  $message" -ForegroundColor Cyan
}

function Write-Ok($message) {
    Write-Host "  $message" -ForegroundColor Green
}

function Write-Warn($message) {
    Write-Host "  $message" -ForegroundColor Yellow
}

# ---------------------------------------------------------------- uninstall

if ($Remove) {
    if (Test-Path $install) {
        Remove-Item $install -Recurse -Force
        Write-Ok "Removed $install"
    } else {
        Write-Step "Nothing installed at $install"
    }
    Write-Host ''
    Write-Host '  Apache configuration, if you added any, was left alone.' -ForegroundColor DarkGray
    exit 0
}

Write-Host ''
Write-Host '  THE TEAM - XAMPP install' -ForegroundColor White
Write-Host '  ========================' -ForegroundColor White
Write-Host ''

# ---------------------------------------------------------------- preflight

if (-not (Test-Path $htdocs)) {
    throw "XAMPP htdocs not found at $htdocs. Run this on the machine with XAMPP installed."
}

if (-not (Get-Command php -ErrorAction SilentlyContinue)) {
    Write-Warn 'php was not found on PATH. Using the XAMPP copy instead.'
}

$phpExe = 'C:\xampp\php\php.exe'
if (-not (Get-Command php -ErrorAction SilentlyContinue) -and (Test-Path $phpExe)) {
    $php = $phpExe
} else {
    $php = 'php'
}

if (-not (Test-Path (Join-Path $phpBackend 'vendor\autoload.php'))) {
    throw "Composer dependencies are missing. Run 'composer install' in $phpBackend first."
}

# ---------------------------------------------------------------- build

Write-Step 'Building the frontend for /the-team ...'

# APP_BASE_PATH is the whole reason the app works in a folder rather than only at
# the root of a domain. Without it every asset URL points at /assets/... , which
# on this machine belongs to some other app, and the page loads blank.
$env:APP_BASE_PATH = $prefix

# Built into its own folder, NOT frontend/dist.
#
# frontend/dist is shared with the Node backend on port 5000, which serves the app
# from the root and therefore needs its assets at /assets/... Overwriting it with
# a /the-team build makes that version request /the-team/assets/..., which its own
# SPA fallback answers with index.html - so the browser gets HTML where it asked
# for JavaScript and the page goes blank with no error to explain why.
$deployDist = Join-Path $frontend 'dist-xampp'

Push-Location $frontend
try {
    # Vite is invoked directly rather than through "npm run build --". On Windows
    # the extra arguments are not reliably forwarded to the build script, and the
    # build then silently writes to the default folder - which is the one shared
    # with the Node backend, and the exact breakage this separation exists to
    # prevent.
    & npx vite build --outDir dist-xampp --emptyOutDir
    if ($LASTEXITCODE -ne 0) {
        throw 'The frontend build failed. See the output above.'
    }
} finally {
    Pop-Location
    Remove-Item Env:\APP_BASE_PATH -ErrorAction SilentlyContinue
}

if (-not (Test-Path (Join-Path $deployDist 'index.html'))) {
    throw "The build reported success but produced no index.html in $deployDist."
}

$dist = $deployDist
if (-not (Test-Path (Join-Path $dist 'index.html'))) {
    throw "The build reported success but produced no index.html in $dist."
}

Write-Ok 'Built'

# ---------------------------------------------------------------- assemble

Write-Step 'Assembling the folder ...'

if (Test-Path $install) {
    # A full replace. A partial copy is how an old index.html survives a deploy
    # and keeps loading asset filenames that no longer exist, which looks like a
    # caching problem and is not one.
    Remove-Item $install -Recurse -Force
}

$backendOut = Join-Path $install 'backend'
New-Item -ItemType Directory -Path $backendOut -Force | Out-Null

# The built frontend.
Copy-Item (Join-Path $dist '*') $install -Recurse -Force

# The PHP backend. vendor/ is included because XAMPP has no Composer and the
# app has to work with nothing else installed.
# The PHP backend. vendor/ is included because XAMPP has no Composer and the
# app has to work with nothing else installed.
#
# public/ contents are lifted one level up so the backend folder is flat:
# public/index.php, app/, routes/, vendor/. A nested public/ would mean the
# front controller sits two directories below where Apache expects it, and the
# failure shows up as the API returning index.html instead of JSON - which looks
# like a broken frontend rather than a wrong folder layout.
foreach ($item in @('app', 'routes', 'vendor', 'composer.json', 'composer.lock')) {
    $source = Join-Path $phpBackend $item
    if (Test-Path $source) {
        Copy-Item $source (Join-Path $backendOut $item) -Recurse -Force
    }
}

$publicDir = Join-Path $phpBackend 'public'
if (Test-Path $publicDir) {
    Get-ChildItem $publicDir -File | ForEach-Object {
        Copy-Item $_.FullName (Join-Path $backendOut $_.Name) -Force
    }
    # Any subdirectory of public/ is a static asset the backend serves directly.
    Get-ChildItem $publicDir -Directory | ForEach-Object {
        Copy-Item $_.FullName (Join-Path $backendOut $_.Name) -Recurse -Force
    }
}

# Apache rules, from their readable source in deploy/ so there is one copy of
# the truth rather than two that drift apart.
Copy-Item (Join-Path $PSScriptRoot 'htaccess-root')   (Join-Path $install '.htaccess') -Force
Copy-Item (Join-Path $PSScriptRoot 'htaccess-backend') (Join-Path $backendOut '.htaccess') -Force

Write-Ok 'Copied'

# ---------------------------------------------------------------- config

Write-Step 'Writing the local .env ...'

# A small file inside the installed folder, not a copy of the whole development
# .env. It holds only what a web install needs, so a secret that has no business
# on a served filesystem is not copied along with it.
$envFile = Join-Path $backendOut '.env'

$dbHost = 'localhost'
$dbName = 'the_team_chama'
$dbUser = 'root'
$dbPass = ''

# Reuse the development values if they are there, so the install points at the
# same database rather than an empty one - which would present as "all my members
# have vanished" on first login.
$devEnv = Join-Path $project 'backend\.env'
if (Test-Path $devEnv) {
    $dev = @{}
    foreach ($line in Get-Content $devEnv) {
        if ($line -match '^\s*([A-Z_]+)\s*=\s*(.*)$') {
            $value = $Matches[2].Trim().Trim('"').Trim("'")
            $dev[$Matches[1]] = $value
        }
    }
    if ($dev.ContainsKey('DB_HOST')) { $dbHost = $dev['DB_HOST'] }
    if ($dev.ContainsKey('DB_NAME')) { $dbName = $dev['DB_NAME'] }
    if ($dev.ContainsKey('DB_USER')) { $dbUser = $dev['DB_USER'] }
    if ($dev.ContainsKey('DB_PASSWORD')) { $dbPass = $dev['DB_PASSWORD'] }
}

$jwtSecret = -join ((1..48) | ForEach-Object { '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGH'[(Get-Random -Maximum 62)] })

@(
    "# THE TEAM - generated by deploy-xampp.ps1"
    "# Secrets are generated fresh here. Do not copy this file into a repository."
    "NODE_ENV=production"
    "APP_BASE_PATH=$prefix"

    # The built frontend sits one level above the backend. Without this the
    # backend looks for it in the wrong place and every app route returns
    # "Frontend not built" - even though it plainly is.
    "WEB_ROOT=$($install -replace '\\','/')"

    "DB_HOST=$dbHost"
    "DB_NAME=$dbName"
    "DB_USER=$dbUser"
    "DB_PASSWORD=$dbPass"
    "JWT_SECRET=$jwtSecret"
    "JWT_EXPIRES_IN=7d"
) | Set-Content -Path $envFile -Encoding ASCII

Write-Ok "Written to backend\.env"

# ---------------------------------------------------------------- protect

Write-Step 'Protecting the .env ...'

# Deny access to the .env from the browser. The rewrite rules above also cover
# it, but this is the rule that matters and it is worth having twice - a served
# .env exposes the database password and the signing secret, and anyone who can
# forge a token can sign in as any administrator.
$htaccess = Join-Path $backendOut '.htaccess'
$protection = @"

# Added by deploy-xampp.ps1: the signing secret and the database password live
# in .env, and a served .env file means anyone can read them.
<Files ".env">
    Require all denied
</Files>
"@
Add-Content -Path $htaccess -Value $protection -Encoding ASCII
Write-Ok 'Protected'

# ---------------------------------------------------------------- verify

Write-Step 'Checking the install ...'

$checks = @(
    @{ Name = 'index.html';      Path = (Join-Path $install 'index.html') },
    @{ Name = 'root .htaccess';  Path = (Join-Path $install '.htaccess') },
    @{ Name = 'backend index';   Path = (Join-Path $backendOut 'index.php') },
    @{ Name = 'autoloader';      Path = (Join-Path $backendOut 'vendor\autoload.php') },
    @{ Name = '.env';            Path = $envFile }
)

$missing = 0
foreach ($check in $checks) {
    if (Test-Path $check.Path) {
        Write-Ok $check.Name
    } else {
        Write-Warn "missing: $($check.Name)"
        $missing++
    }
}

# The asset paths are the thing that silently breaks a folder install, so check
# the built file rather than trusting the build to have honoured the prefix.
$html = Get-Content (Join-Path $install 'index.html') -Raw
if ($html -match '(src|href)="/assets/') {
    Write-Warn 'Assets are still absolute (/assets/...). The build ignored APP_BASE_PATH.'
    Write-Warn 'The page will load blank. Rebuild with APP_BASE_PATH set.'
} elseif ($html -match "$prefix/assets/") {
    Write-Ok "Assets resolve under $prefix"
} else {
    Write-Step 'Assets are relative, which also works under a prefix.'
}

if ($missing -gt 0) {
    Write-Host ''
    Write-Warn "$missing expected files are missing. The install is incomplete."
    exit 1
}

# ---------------------------------------------------------------- smoke test

Write-Step 'Starting the installed copy to test it ...'

# Checks the copy that was just installed, in the folder it will actually run
# from. Testing the source tree instead would miss a broken deploy layout - the
# autoloader path and the .env location both differ between the two, and both
# fail as a blank page rather than an error.
$testPort = 5511
$probe = $null
try {
    $probe = Start-Process -FilePath $php `
        -ArgumentList '-S', "localhost:$testPort", '-t', '.', 'index.php' `
        -WorkingDirectory $backendOut `
        -RedirectStandardOutput "$env:TEMP\the-team-deploy-out.log" `
        -RedirectStandardError "$env:TEMP\the-team-deploy-err.log" `
        -WindowStyle Hidden -PassThru

    Start-Sleep -Seconds 3

    $health = Invoke-RestMethod "http://localhost:$testPort/api/health" -TimeoutSec 10

    if ($health.status -eq 'ok') {
        Write-Ok 'The installed copy starts and answers /api/health'
    } else {
        Write-Warn "Health returned $($health.status)"
    }

    # Logging in is the one test that proves the database connection, the .env
    # and the password hashing all work from the installed location. Each has
    # its own path that only exists after a deploy.
    try {
        $login = Invoke-RestMethod "http://localhost:$testPort/api/auth/admin-login" `
            -Method Post -ContentType 'application/json' `
            -Body '{"identifier":"admin","password":"admin123"}' -TimeoutSec 10

        if ($login.success -and $login.token) {
            Write-Ok 'Admin can log in from the installed copy'
        } else {
            Write-Warn 'Admin login did not succeed from the installed copy'
        }
    } catch {
        Write-Warn "Admin login failed from the installed copy: $($_.Exception.Message)"
        Write-Warn 'Check the database in phpmyadmin, and DB_NAME in backend\.env'
    }
} catch {
    Write-Warn "The installed copy did not start: $($_.Exception.Message)"
    Write-Warn (Get-Content "$env:TEMP\the-team-deploy-err.log" -Tail 5 -ErrorAction SilentlyContinue)
} finally {
    if ($probe -and -not $probe.HasExited) {
        Stop-Process -Id $probe.Id -Force -ErrorAction SilentlyContinue
    }
}

# ---------------------------------------------------------------- done

Write-Host ''
Write-Host '  Installed' -ForegroundColor Green
Write-Host "  ================"
Write-Host ''
Write-Host "  Start Apache from the XAMPP control panel, then open:"
Write-Host ''
Write-Host "    http://localhost$prefix" -ForegroundColor White
Write-Host ''
Write-Host '  Sign in with admin / admin123'
Write-Host ''
Write-Host '  The Node version on port 5000 is no longer involved and can be stopped.'
Write-Host ''

if ($Open) {
    Start-Process "http://localhost$prefix"
}