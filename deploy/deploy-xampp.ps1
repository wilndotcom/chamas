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
    Assets from the last fortnight of builds are carried across that replace, so
    a tab that is already open keeps the chunks its bundle was built against
    instead of failing the next time it opens a page. See the assemble step.

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

# Read the existing signing secret BEFORE anything is deleted.
#
# The install folder is removed and rebuilt further down, so anything that needs
# to survive a deploy has to be captured here. Reading it later found an empty
# folder and generated a new secret, which logged out every browser - the exact
# failure this was meant to prevent.
#
# The administrator password is read here for the same reason. It is not a
# secret the app keeps - the hash is in the database and this is not it - but
# the checks and keep-tunnel.ps1 sign in with it, so losing it on every deploy
# would break them.
$existingSecret = $null
$existingAdminPassword = $null
$existingEnv = Join-Path $install 'backend\.env'
if (Test-Path $existingEnv) {
    $line = Get-Content $existingEnv | Where-Object { $_ -match '^JWT_SECRET=' } | Select-Object -First 1
    if ($line) {
        $existingSecret = ($line -replace '^JWT_SECRET=', '').Trim()
    }

    $line = Get-Content $existingEnv | Where-Object { $_ -match '^ADMIN_PASSWORD=' } | Select-Object -First 1
    if ($line) {
        $existingAdminPassword = ($line -replace '^ADMIN_PASSWORD=', '').Trim()
    }
}

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

$stash = $null
if (Test-Path $install) {
    # A full replace. A partial copy is how an old index.html survives a deploy
    # and keeps loading asset filenames that no longer exist, which looks like a
    # caching problem and is not one.
    #
    # assets/ is the one exception, and it is set aside rather than deleted.
    #
    # Build output there is content-hashed, so a file's name is a hash of its
    # contents: two builds either produce byte-identical files under the same
    # name, or different files under different names. Nothing can be served
    # wrongly. What it buys is the tab that is already open - it still holds the
    # previous index bundle, whose lazy routes ask for the previous chunks, and
    # every one of those was deleted by this step. Keeping them means a member
    # part-way through a form is not interrupted by a deploy; the new chunks are
    # picked up whenever that tab next loads normally.
    $previousAssets = Join-Path $install 'assets'
    if (Test-Path $previousAssets) {
        $stash = Join-Path ([System.IO.Path]::GetTempPath()) "the-team-assets-$([guid]::NewGuid().ToString('N'))"
        New-Item -ItemType Directory -Path $stash -Force | Out-Null
        Copy-Item (Join-Path $previousAssets '*') $stash -Recurse -Force
    }

    Remove-Item $install -Recurse -Force
}

$backendOut = Join-Path $install 'backend'
New-Item -ItemType Directory -Path $backendOut -Force | Out-Null

# The built frontend.
Copy-Item (Join-Path $dist '*') $install -Recurse -Force

# Put the set-aside chunks back, beside this build's own.
#
# Only files the new build did not produce are restored, so the files that
# actually run are always this build's. Anything older than the cutoff is
# dropped: long enough that any tab still open by then has loaded a fresh build
# at least once, short enough that the folder does not grow with every deploy
# for the rest of the project's life.
if ($stash -and (Test-Path $stash)) {
    $assetsOut = Join-Path $install 'assets'
    New-Item -ItemType Directory -Path $assetsOut -Force | Out-Null

    $cutoff = (Get-Date).AddDays(-14)
    $kept = 0

    foreach ($file in (Get-ChildItem $stash -File)) {
        if ($file.LastWriteTime -lt $cutoff) { continue }

        $target = Join-Path $assetsOut $file.Name
        if (Test-Path $target) { continue }

        Copy-Item $file.FullName $target -Force
        $kept++
    }

    Remove-Item $stash -Recurse -Force

    if ($kept -gt 0) {
        Write-Ok "Kept $kept asset file(s) from the previous build for tabs already open"
    }
}

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
$dev = @{}
if (Test-Path $devEnv) {
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

# The administrator password is written into the installed .env so the checks
# and keep-tunnel.ps1 have one place to read it from. It is not the app's own
# setting - the app stores a hash in the database and never looks here - it is
# here so that a script needing to sign in does not have to carry a password in
# the published source.
#
# The development .env wins over the installed one, because that is the file an
# operator edits. Falling back to the installed copy keeps a redeploy from
# throwing the password away when the development file does not have one.
$adminPassword = $existingAdminPassword
if ($dev.ContainsKey('ADMIN_PASSWORD')) { $adminPassword = $dev['ADMIN_PASSWORD'] }

# The starting password, when nothing is on record anywhere.
#
# A documented, shared value, on purpose: signing in for the first time should
# not depend on finding a generated string and typing it correctly. It is only
# defensible because it expires - the account is flagged and the app refuses
# everything except the change of password itself until it has been replaced, so
# the worst case is that somebody else chooses the password first, and the
# operator can take the account back with
# backend-php/tests/reset-admin-passwords.php.
#
# There used to be no default, because a default in a published file is a working
# login on any install that has one. That is still true. What changed is that the
# login no longer gets an account that can do anything.
$defaultAdminPassword = 'admin1234'
if (-not $adminPassword) { $adminPassword = $defaultAdminPassword }

# The signing secret is KEPT across deployments, not regenerated.
#
# Regenerating it invalidates every session in every browser, so every update logs
# out whoever was using the app - the worst possible time, with no warning. It was
# doing exactly that on each run of this script, which is why a saved token from
# an earlier deploy suddenly stopped working.
#
# Generated once, on the first install, and read back on every subsequent one.
$jwtSecret = $existingSecret

if (-not $jwtSecret) {
    # 64 hex characters from a cryptographic RNG.
    $bytes = New-Object byte[] 32
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $jwtSecret = -join ($bytes | ForEach-Object { $_.ToString('x2') })
    Write-Ok 'Generated a new signing secret'
} else {
    Write-Ok 'Kept the existing signing secret, so sessions survive'
}

$envLines = @(
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
)

# Appended rather than listed above, so an install that has no password recorded
# does not get an empty "ADMIN_PASSWORD=" line, which reads as a password that
# is the empty string.
if ($adminPassword) {
    $envLines += "ADMIN_PASSWORD=$adminPassword"
}

$envLines | Set-Content -Path $envFile -Encoding ASCII

Write-Ok "Written to backend\.env"

# ---------------------------------------------------------------- database

Write-Step 'Applying database migrations ...'

# Schema changes arrive as numbered files under database/migrations. Until this
# step existed they had to be applied by hand, from a documented shell loop, and
# nothing failed when they were not: the app broke later, on whichever column it
# asked for next, usually as a 500 from a single screen with no hint that the
# database was a version behind.
#
# A deploy is the one moment the code and the schema are meant to be in step, so
# it is the place to make them so. Every migration is written to be re-runnable -
# CREATE TABLE IF NOT EXISTS, ADD COLUMN IF NOT EXISTS, INSERT IGNORE - which is
# what makes applying the whole directory on every deploy safe rather than
# something to be clever about. They run in filename order, which is their order
# of authorship.
$mysqlExe = 'C:\xampp\mysql\bin\mysql.exe'
$migrations = Join-Path $project 'database\migrations'

if ((Test-Path $mysqlExe) -and (Test-Path $migrations)) {
    # -p is passed only when a password exists: an empty -p makes the client
    # prompt, and a prompt inside a script hangs the deploy with no output at all.
    $mysqlArgs = "`"$mysqlExe`" -u $dbUser --host=$dbHost"
    if ($dbPass) { $mysqlArgs += " -p$dbPass" }

    $applied = 0
    $alreadyApplied = 0
    $migrationErrors = @()

    # Errors that mean "this migration has already run here".
    #
    # 003 and 005 are not replayable: they add a column with a plain ADD COLUMN,
    # which is an error the second time. Replaying the directory is still right -
    # a fresh install needs every file, and nothing records which have run - so
    # these are expected on an install that is already up to date and must not be
    # reported as failures. Reporting them would bury a real one, which is the
    # whole reason for looking at the output.
    #
    # Everything else is named and shown.
    $expectedCodes = @('1050', '1060', '1061', '1062', '1091', '1826', '1827')

    foreach ($file in (Get-ChildItem $migrations -Filter '*.sql' | Sort-Object Name)) {
        # Run through cmd, for two reasons.
        #
        # A migration holds more than one statement, so it has to arrive over stdin
        # rather than in -e, which runs only the first. PowerShell cannot feed a
        # file to stdin for a native command, but cmd can.
        #
        # And cmd keeps the client's complaints off PowerShell's error stream: this
        # script runs with ErrorActionPreference = Stop, where a native command
        # that writes to stderr aborts the deploy. A migration that fails is worth
        # reporting, not worth stopping a deploy over half way through.
        $command = "$mysqlArgs $dbName < `"$($file.FullName)`" 2>&1"
        $result = (& cmd /c $command | Out-String).Trim()

        if ($LASTEXITCODE -eq 0) {
            $applied++
            continue
        }

        $codes = [regex]::Matches($result, 'ERROR (\d+)') | ForEach-Object { $_.Groups[1].Value }
        $unexpected = @($codes | Where-Object { $expectedCodes -notcontains $_ })

        if ($codes.Count -gt 0 -and $unexpected.Count -eq 0) {
            $alreadyApplied++
        } else {
            $migrationErrors += "$($file.Name): " + ($result -replace '\s+', ' ')
        }
    }

    if ($migrationErrors.Count -eq 0) {
        if ($alreadyApplied -gt 0) {
            Write-Ok "Schema checked: $applied file(s) applied, $alreadyApplied already in place"
        } else {
            Write-Ok "Schema checked ($applied migration file(s))"
        }
    } else {
        # Loud, but not fatal. Stopping here would leave the operator with half a
        # deploy, and the named files are the actionable part.
        Write-Warn "$($migrationErrors.Count) migration file(s) reported an error:"
        foreach ($migrationError in $migrationErrors) { Write-Warn "  $migrationError" }
        Write-Warn 'Anything missing from the schema shows up as an error on one screen.'
    }
} else {
    Write-Warn 'The mysql client was not found, so migrations were not applied.'
    Write-Warn "Apply them by hand before using the app: $migrations"
}

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
    #
    # Skipped, not guessed at, when no password is on record. A failed login
    # here sends the operator looking at the database, and a missing password
    # is not a database problem.
    if (-not $adminPassword) {
        Write-Warn 'No administrator password on record, so the login was not tested'
        Write-Warn 'Set ADMIN_PASSWORD in backend\.env, or run the seed with it set'
    } else {
        try {
            $loginBody = @{ identifier = 'admin'; password = $adminPassword } | ConvertTo-Json

            $login = Invoke-RestMethod "http://localhost:$testPort/api/auth/admin-login" `
                -Method Post -ContentType 'application/json' `
                -Body $loginBody -TimeoutSec 10

            if ($login.success -and $login.token) {
                Write-Ok 'Admin can log in from the installed copy'
            } else {
                Write-Warn 'Admin login did not succeed from the installed copy'
            }
        } catch {
            Write-Warn "Admin login failed from the installed copy: $($_.Exception.Message)"
            Write-Warn 'Check the database in phpmyadmin, and DB_NAME in backend\.env'
        }
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

# The port Apache actually listens on, read from its own configuration.
#
# Printed rather than assumed, because it is the one thing the operator has to
# type correctly and the default is not always the truth: this machine runs
# Apache on 8080 because something else already holds 80, so a hardcoded
# http://localhost/the-team link does not open the app - and that reads as a
# broken install rather than a wrong port.
$apachePort = '80'
$httpdConf = 'C:\xampp\apache\conf\httpd.conf'
if (Test-Path $httpdConf) {
    $listen = Select-String -Path $httpdConf -Pattern '^\s*Listen\s+(\d+)' | Select-Object -First 1
    if ($listen) { $apachePort = $listen.Matches[0].Groups[1].Value }
}
$siteUrl = if ($apachePort -eq '80') { "http://localhost$prefix" } else { "http://localhost:$apachePort$prefix" }

Write-Host ''
Write-Host '  Installed' -ForegroundColor Green
Write-Host "  ================"
Write-Host ''
Write-Host "  Start Apache from the XAMPP control panel, then open:"
Write-Host ''
Write-Host "    $siteUrl" -ForegroundColor White
Write-Host ''
if ($adminPassword) {
    Write-Host "  Sign in as admin, with ADMIN_PASSWORD from backend\.env."
    if ($adminPassword -eq $defaultAdminPassword) {
        # Stated plainly, because it is a shared value in a published file and the
        # operator should know that rather than discover it.
        Write-Host "  Nothing else is on record, so that is the starting password:" -ForegroundColor DarkGray
        Write-Host "    $defaultAdminPassword" -ForegroundColor DarkGray
    }
    Write-Host ''
    Write-Host '  The app asks you to choose your own password before it opens anything' -ForegroundColor White
    Write-Host '  else, and refuses the rest of the API until you have. That applies to all' -ForegroundColor White
    Write-Host '  four administrator accounts.' -ForegroundColor White
} else {
    Write-Host '  Sign in with admin. No password is on record here - run the seed with'
    Write-Host '  ADMIN_PASSWORD set to choose one.'
}
Write-Host ''
Write-Host '  The Node version on port 5000 is no longer involved and can be stopped.'
Write-Host ''

if ($Open) {
    Start-Process $siteUrl
}