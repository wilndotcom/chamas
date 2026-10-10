# Deploying THE TEAM to an Ubuntu Server

Complete guide for putting THE TEAM on a real Ubuntu server with HTTPS.

---

## 1. Server Requirements

### Minimum

| Spec | Minimum | Recommended |
|------|---------|-------------|
| CPU | 1 core | 2 cores |
| RAM | 1 GB | 2 GB |
| Disk | 20 GB | 40 GB+ |
| OS | Ubuntu 22.04 LTS | Ubuntu 24.04 LTS |

A chama with up to ~500 members runs comfortably on the minimum. The bottleneck is
concurrent users, not member count.

### Software

| Package | Version | Purpose |
|---------|---------|---------|
| Ubuntu Server | 22.04 or 24.04 LTS | Base OS |
| Node.js | 20.x or 22.x LTS | Runs the API |
| MySQL or MariaDB | MySQL 8.0 / MariaDB 10.6 | Database |
| Nginx | 1.18+ | Serves frontend, proxies API, terminates SSL |
| PM2 | latest | Keeps the API running and restarts on crash |
| Certbot | latest | Free Let's Encrypt SSL certificate |

### Ports

| Port | Use |
|------|-----|
| 22 | SSH |
| 80 | HTTP (redirects to HTTPS) |
| 443 | HTTPS |
| 3306 | MySQL — **keep internal only** |
| 5000 | API — **keep internal only** |

---

## 2. Initial Server Setup

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y nginx mysql-server git curl ufw
```

### Create a non-root app user

Never run the app as root.

```bash
sudo adduser --disabled-password --gecos "" theteam
sudo usermod -aG www-data theteam
```

### Open the firewall

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
sudo ufw status
```

MySQL (3306) and the API (5000) must **not** be opened.

---

## 3. Install Node.js

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node --version   # expect v22.x
```

### Install PM2

```bash
sudo npm install -g pm2
```

---

## 4. Get the Code

### Option A — from Git

```bash
sudo -u theteam git clone <your-repo-url> /home/theteam/the-team
```

### Option B — upload a zip

```bash
sudo mkdir -p /home/theteam
sudo chown theteam:theteam /home/theteam
# then scp the project folder into /home/theteam/
sudo chown -R theteam:theteam /home/theteam/the-team
```

```bash
cd /home/theteam/the-team
```

---

## 5. Database

### Create the database and user

```bash
sudo mysql <<'SQL'
CREATE DATABASE IF NOT EXISTS the_team_chama
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Strong random password, not reused anywhere else
CREATE USER IF NOT EXISTS 'theteam'@'localhost'
  IDENTIFIED BY 'CHANGE_THIS_TO_A_LONG_RANDOM_PASSWORD';

GRANT ALL PRIVILEGES ON the_team_chama.* TO 'theteam'@'localhost';
FLUSH PRIVILEGES;
SQL
```

### Load the schema

```bash
sudo mysql -u theteam -p the_team_chama < database/schema.sql
```

If you are upgrading an existing install, run the migrations instead:

```bash
for f in database/migrations/*.sql; do
  echo "Applying $f"
  sudo mysql -u theteam -p the_team_chama < "$f"
done
```

All migrations use `CREATE TABLE IF NOT EXISTS` / `INSERT IGNORE`, so re-running them is safe.

Two migrations guard themselves with `information_schema` checks instead, because they
add a column or a constraint to a table that already exists and would otherwise fail on
replay: `008_admin_username.sql` and `011_member_language.sql`. Both are still safe to
re-run.

`011_member_language.sql` adds `members.language` and `admins.language` with a `CHECK`
constraint limiting the value to `en` or `sw`. It requires MariaDB 10.2+ or MySQL 8.0.16+,
which is what enforces the constraint. On an older server the `ALTER` will be rejected:
drop the two `chk_*_language` statements from the file and apply the rest — the API
validates the value anyway, so the database guard is a backstop rather than the only one.

`schema.sql` seeds the base settings only. Anything added later lives in a migration and
must be applied as well, or the feature that needs it will 404. That includes the
`theme` and `color_mode` rows behind Appearance, the notification templates, and the
payment gateway registry.

### Secure MySQL

```bash
sudo mysql <<'SQL'
-- refuse remote connections
DELETE FROM mysql.user WHERE User NOT IN ('mysql.sys', 'mysql.session', 'mysql.infoschema', 'theteam');
FLUSH PRIVILEGES;
SQL

# bind to localhost only
sudo sed -i 's/^bind-address.*/bind-address = 127.0.0.1/' /etc/mysql/mysql.conf.d/mysqld.cnf
sudo systemctl restart mysql
```

Verify it is not listening publicly:

```bash
sudo ss -tlnp | grep 3306   # should show 127.0.0.1:3306 only
```

---

## 6. Configure the Backend

```bash
cd /home/theteam/the-team/backend
npm ci --omit=dev      # production install, no dev dependencies
cp .env .env.production
```

Edit `.env.production`:

```env
PORT=5000

DB_HOST=127.0.0.1
DB_USER=theteam
DB_PASSWORD=CHANGE_THIS_TO_A_LONG_RANDOM_PASSWORD
DB_NAME=the_team_chama

# Generate a real secret, do not reuse the sample
JWT_SECRET=<paste output of: openssl rand -hex 48>
JWT_EXPIRES_IN=12h

# Only needed if the frontend and API are on different domains
FRONTEND_ORIGIN=https://chama.example.com

# Production-appropriate limits
RATE_LIMIT_WINDOW_MS=900000
RATE_LIMIT_MAX=300
LOGIN_RATE_LIMIT_MAX=10
REGISTER_RATE_LIMIT_MAX=3

# M-Pesa — see section 11
MPESA_ENV=production
MPESA_CONSUMER_KEY=
MPESA_CONSUMER_SECRET=
MPESA_SHORTCODE=
MPESA_PASSKEY=
MPESA_CALLBACK_URL=https://chama.example.com/api/mpesa/callback

# Notifications — see section 12
SMS_USERNAME=
SMS_API_KEY=
EMAIL_HOST=
EMAIL_PORT=587
EMAIL_USER=
EMAIL_PASS=
EMAIL_FROM=
```

> **Do not put `NODE_ENV` in this file.** The app has to know it is in production *before* it
> can choose which file to read, so `NODE_ENV=production` set inside `.env.production` has no
> effect. PM2 sets it instead — see section 10.

Generate a strong secret:

```bash
openssl rand -hex 48
```

Protect the file:

```bash
chmod 600 .env.production
```

### How the app loads configuration

`backend/config/env.js` runs first and picks the file to read:

| `NODE_ENV` | File loaded first | File loaded second (fills gaps only) |
|---|---|---|
| `production` | `.env.production` | `.env` |
| anything else | `.env` | `.env.production` |

Real environment variables set by PM2 or systemd always win over both files.

On startup it also checks the production essentials and tells you plainly what is wrong:

```
[env] Loaded .env.production, .env (NODE_ENV=production)
[env] FATAL in production — missing: DB_PASSWORD. Put them in backend/.env.production.
[env] FATAL in production — JWT_SECRET is still the sample value.
```

**Read those lines in `pm2 logs theteam-api` after the first boot.** A silent empty
`DB_PASSWORD` was the most common deployment mistake; it is now called out immediately.

### Create the super admin and demo data

```bash
NODE_ENV=production node seed.js
```

> The `NODE_ENV=production` prefix matters. Without it the script reads `.env` and would seed
> the wrong database.

`seed.js` is safe to re-run — it uses upserts. It creates the super admin
(`admin@theteam.com` / `admin123`), sample admins and members, and demo figures.

> **Change the super admin password immediately after first login.** The seed password is a
> starting point, not a real credential.

If you want a production install with no demo data, skip the seed and insert the super admin
yourself:

```bash
cd /home/theteam/the-team/backend
node -e "
require('dotenv').config({path:'.env.production'});
const bcrypt=require('bcryptjs');const mysql=require('mysql2/promise');
(async()=>{
  const pw = process.argv[1];
  const hash = await bcrypt.hash(pw, 12);
  const c = await mysql.createConnection({
    host:process.env.DB_HOST,user:process.env.DB_USER,
    password:process.env.DB_PASSWORD,database:process.env.DB_NAME});
  await c.execute(
    'INSERT INTO admins (full_name,email,password_hash,role_id) VALUES (?,?,?,1)',
    ['Super Admin','admin@yourchama.com',hash]);
  await c.end(); console.log('super admin created');
})();
" 'YOUR_STRONG_PASSWORD'
```

---

## 7. Build the Frontend

```bash
cd /home/theteam/the-team/frontend
npm ci
npm run build
```

This produces `frontend/dist/`.

---

## 8. Nginx

Nginx serves the built frontend and forwards `/api` to the Node server.

```bash
sudo nano /etc/nginx/sites-available/theteam
```

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name chama.example.com www.chama.example.com;

    # Certbot rewrites this to redirect to HTTPS
    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }

    location / {
        return 301 https://$host$request_uri;
    }
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name chama.example.com www.chama.example.com;

    ssl_certificate     /etc/letsencrypt/live/chama.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/chama.example.com/privkey.pem;

    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 1d;
    ssl_stapling on;
    ssl_stapling_verify on;

    # Uploads and JSON bodies
    client_max_body_size 10m;

    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    # Compression
    gzip on;
    gzip_types text/plain text/css application/json application/javascript
               application/x-javascript text/xml application/xml image/svg+xml;
    gzip_min_length 1024;

    # Built React frontend
    root /home/theteam/the-team/frontend/dist;
    index index.html;

    # Hashed build assets can be cached hard
    location /assets/ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    # index.html must never be cached, or clients keep the old bundle
    location = /index.html {
        add_header Cache-Control "no-cache, no-store, must-revalidate";
    }

    # The service worker must never be cached, or an update can never reach anyone:
    # the browser reuses a cached sw.js for weeks. This is the single most common
    # reason a PWA "ignores" a deploy.
    location = /sw.js {
        add_header Cache-Control "no-cache, no-store, must-revalidate";
    }

    # The manifest is small and changes rarely, but a stale one means a stale app
    # name and icon on the home screen.
    location = /manifest.webmanifest {
        add_header Cache-Control "no-cache";
        types { } default_type "application/manifest+json";
    }

    # Icons are content-stable and referenced from the manifest, which must not be
    # cached anyway, so revalidating is cheap.
    location ~* ^/(icon-|apple-touch-icon|favicon-) {
        add_header Cache-Control "public, max-age=86400";
    }

    # React Router uses history paths, so unknown paths return the app shell
    location / {
        try_files $uri $uri/ /index.html;
    }

    # Forward the API
    location /api/ {
        proxy_pass http://127.0.0.1:5000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
    }
}
```

> **The `try_files ... /index.html` line is required.** Without it, refreshing
> `/loans` or `/cashbook` returns 404, because those routes only exist in the browser.

Enable it:

```bash
sudo ln -s /etc/nginx/sites-available/theteam /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

The SSL directives will not exist yet. Get the certificate first (section 9), then reload.

---

## 9. HTTPS with Let's Encrypt

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d chama.example.com -d www.chama.example.com
```

Certbot edits the Nginx config, adds the certificate paths and sets up auto-renewal.

Verify renewal:

```bash
sudo certbot renew --dry-run
```

The timer runs twice daily automatically.

---

## 10. Run the API with PM2

PM2 supplies `NODE_ENV`, which is how the app knows to read `.env.production`. Start it with an
ecosystem file so this is never left to chance:

```bash
cd /home/theteam/the-team/backend
sudo -u theteam pm2 init
sudo -u theteam nano ecosystem.config.js
```

```js
module.exports = {
  apps: [
    {
      name: 'theteam-api',
      script: 'server.js',
      cwd: '/home/theteam/the-team/backend',
      env: { NODE_ENV: 'production', PORT: 5000 },
      max_memory_restart: '400M',
      error_file: '/home/theteam/logs/err.log',
      out_file: '/home/theteam/logs/out.log',
      time: true,
      kill_timeout: 5000
    }
  ]
};
```

Create the log directory first, or PM2 cannot write there:

```bash
sudo mkdir -p /home/theteam/the-team/logs
sudo chown -R theteam:theteam /home/theteam/the-team/logs
```

This matches the paths in `ecosystem.config.js`, which resolve `logs/` relative to the
project folder.

Start it:

```bash
cd /home/theteam/the-team/backend
sudo -u theteam pm2 start ecosystem.config.js
```

**No wrapper script and no `require('dotenv')` edit is needed** — `config/env.js` handles the
file selection on its own.

### Check it started correctly

```bash
sudo -u theteam pm2 logs theteam-api --lines 20
```

The first lines must include:

```
[env] Loaded .env.production, .env (NODE_ENV=production)
Database connected successfully
```

If you see `FATAL in production — missing: ...`, fix the named variable and
`pm2 restart theteam-api`. If you see `Database connection failed: Access denied`, the
credentials are wrong — not the firewall.

### Stamp the build

Do this on every deploy. Without it two releases of the same version are indistinguishable, and
a bug report from a client cannot be traced to a build.

```bash
sudo -u theteam env BUILD_ID=$(git -C /home/theteam/the-team rev-parse --short HEAD) \
  pm2 restart theteam-api --update-env

# confirm it took
curl -s https://chama.example.com/api/health
# {"status":"ok","version":"1.0.0","build":"a1b2c3d", ...}
```

Without it, `build` falls back to `local-YYYYMMDD`, which collides when you deploy twice in one
day.

### Make it survive reboots

```bash
sudo -u theteam pm2 save
sudo -u theteam pm2 startup systemd
# run the printed sudo command, then:
sudo -u theteam pm2 save
sudo systemctl status pm2-theteam
```

### Useful PM2 commands

```bash
pm2 status                  # is it running
pm2 logs theteam-api        # tail logs
pm2 restart theteam-api     # apply a code change
pm2 monit                   # CPU/memory
```

---

## 11. M-Pesa Configuration

> **STK Push requires a publicly reachable HTTPS callback.** Safaricom cannot reach
> `localhost`. Without a real callback URL, STK Push will not work in production.

1. Create an app at [developer.safaricom.co.ke](https://developer.safaricom.co.ke/)
2. Get production Consumer Key and Secret
3. Fill in `backend/.env.production`:

   ```env
   MPESA_ENV=production
   MPESA_CONSUMER_KEY=...
   MPESA_CONSUMER_SECRET=...
   MPESA_SHORTCODE=...        # your PayBill or Till number
   MPESA_PASSKEY=...          # from Daraja > App Keys
   MPESA_CALLBACK_URL=https://chama.example.com/api/mpesa/callback
   ```

4. Register the C2B confirmation URLs:

   ```bash
   cd /home/theteam/the-team/backend
   curl -X POST https://chama.example.com/api/mpesa/register-c2b \
     -H "Authorization: Bearer $(curl -s -u "$KEY:$SECRET" \
        'https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials' \
        | grep -o '"access_token":"[^"]*"' | cut -d'"' -f4)"
   ```

5. Restart: `pm2 restart theteam-api`

Confirm the callback URL is reachable from the internet:

```bash
curl -i -X POST https://chama.example.com/api/mpesa/callback \
  -H 'Content-Type: application/json' -d '{}'
# should return 200 (the app acknowledges even a bad payload)
```

---

## 12. Notifications

### SMS — Africa's Talking

```env
SMS_USERNAME=your_username
SMS_API_KEY=your_api_key
SMS_SENDER_ID=THE_TEAM
```

Sender ID must be approved by Safaricom, which takes a few days.

### SMS / WhatsApp — Twilio

```env
TWILIO_ACCOUNT_SID=ACxxxx
TWILIO_AUTH_TOKEN=xxxx
TWILIO_WHATSAPP_NUMBER=whatsapp:+14155238886
```

### Email

```env
EMAIL_HOST=smtp.gmail.com
EMAIL_PORT=587
EMAIL_USER=chama@gmail.com
EMAIL_PASS=<app password, not the account password>
```

For Gmail use an **App Password**, not your normal password.

> Until a provider is configured the app reports reminders as `skipped (channel not
> configured)` rather than pretending they were sent. That is deliberate.

---

## 13. Post-Deployment Checklist

```bash
# API alive
curl -s https://chama.example.com/api/health
# {"status":"ok","message":"THE TEAM API is running",...}

# HTTPS only, no mixed content
curl -I http://chama.example.com   # expect 301 to https

# SPA deep link works (critical)
curl -I https://chama.example.com/cashbook   # expect 200, not 404

# MySQL not exposed
sudo ss -tlnp | grep 3306        # 127.0.0.1 only

# API not exposed
sudo ss -tlnp | grep 5000        # 127.0.0.1 only

# Firewall
sudo ufw status

# Installable: manifest and worker must both be served
curl -sI https://chama.example.com/manifest.webmanifest | grep -i "200"
curl -sI https://chama.example.com/sw.js | grep -i "200"
# The worker must not be cached, or updates can never reach anyone
curl -sI https://chama.example.com/sw.js | grep -i "no-cache"
# Icons referenced by the manifest must resolve
for i in icon-192.png icon-512.png icon-maskable-512.png apple-touch-icon.png; do
  curl -sI "https://chama.example.com/$i" | head -1
done
```

Then in the browser:

- Open DevTools → **Application** → **Manifest**: no errors, icons listed
- **Application** → **Service Workers**: one registered, `activated and is running`
- `https://chama.example.com/?install=1` shows the install sheet on a desktop, which is
  how to confirm the flow without a second phone

Then in the browser:

1. Log in as super admin and **change the password**
2. Confirm the member login page loads
3. Register a test member and approve it
4. Record a contribution
5. Send yourself a test notification from Settings → Notification Templates
6. Check Settings → Appearance and switch a skin
7. Review the Roles & Rights matrix

---

## 14. Backups

### Database — the important one

```bash
sudo mkdir -p /home/theteam/backups
sudo crontab -e
```

```cron
# Nightly database dump at 02:15, keep 14 days
15 2 * * * mysqldump -u theteam -p'PASSWORD' the_team_chama \
  | gzip > /home/theteam/backups/theteam_$(date +\%F).sql.gz

# Offsite copy
30 2 * * * rsync -az /home/theteam/backups/ user@backup-host:/backups/theteam/
```

Restoring:

```bash
gunzip < /home/theteam/backups/theteam_2026-10-04.sql.gz \
  | sudo mysql -u theteam -p the_team_chama
```

> Backups on the same disk as the database are not backups. Test a restore once.

### Optional: nightly file backup

```cron
0 3 * * * tar czf /home/theteam/backups/app_$(date +\%F).tar.gz \
  -C /home/theteam the-team --exclude='*/node_modules' --exclude='*/dist'
```

---

## 15. Updating an Existing Install

```bash
sudo -u theteam pm2 stop theteam-api
cd /home/theteam/the-team

git pull

# New migrations, if any
for f in database/migrations/*.sql; do
  sudo mysql -u theteam -p the_team_chama < "$f"
done

# Rebuild
cd backend && npm ci --omit=dev
cd ../frontend && npm ci && npm run build

sudo -u theteam pm2 restart theteam-api
sudo systemctl reload nginx
curl -s https://chama.example.com/api/health
```

Never `npm install` in production with `--save`; use `npm ci --omit=dev` so the lockfile is
honoured and dev packages are excluded.

If you added a new environment variable, add it to `.env.production` and
`pm2 restart theteam-api`, then confirm with `pm2 logs theteam-api --lines 10`.

---

## 16. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `[env] Loaded .env, .env.production (NODE_ENV=development)` | PM2 isn't setting `NODE_ENV` | Use the ecosystem file (section 10), not `node server.js` |
| `[env] FATAL — missing: DB_PASSWORD` | Variable absent from `.env.production` | Add it, then `pm2 restart theteam-api` |
| `[env] FATAL — JWT_SECRET is still the sample` | Sample secret left in place | `openssl rand -hex 48` |
| `Database connection failed: Access denied` | Wrong credentials, or seeding the wrong DB | Check `DB_USER`/`DB_PASSWORD`; run seed with `NODE_ENV=production` |
| 502 from Nginx | API down | `pm2 logs theteam-api` |
| `/loans` or `/cashbook` returns 404 on refresh | Missing SPA fallback | Add `try_files $uri $uri/ /index.html;` |
| Blank white page | Stale cached `index.html` | Ensure `index.html` is `no-cache` |
| `Login failed` for everyone | Wrong DB password in `.env` | Check `DB_PASSWORD`, `pm2 restart` |
| API works, login fails in browser | CORS | Set `FRONTEND_ORIGIN=https://your-domain` |
| M-Pesa STK push times out | Callback not public | Confirm the URL is reachable from the internet |
| Notifications say "not configured" | Placeholder credentials | Real values in `.env.production`, then restart |
| `Too many requests` | Rate limit | Expected; raise `RATE_LIMIT_MAX` if legitimate |
| Certbot renewal fails | DNS/port 80 | `sudo certbot renew --dry-run` |
| High memory | Single process | `pm2 start server.js -i max -n 4 --name theteam-api` |

Logs:

```bash
pm2 logs theteam-api
sudo tail -f /var/log/nginx/error.log
sudo journalctl -u mysql
```

---

## 17. Security Summary

- [x] App runs as non-root `theteam` user
- [x] MySQL bound to `127.0.0.1`, only 22/80/443 open
- [x] API bound to loopback, fronted by Nginx
- [x] HTTPS with auto-renewing Let's Encrypt certificate
- [x] HSTS, `X-Content-Type-Options`, `X-Frame-Options` headers
- [x] bcrypt password hashing, JWT with a random secret
- [x] Rate limiting, with a tight limit on login and registration
- [x] Role-based permissions enforced server-side on every route
- [x] `.env.production` is `chmod 600`
- [ ] **Change all seeded passwords** (`admin123`, `member123`)
- [ ] Set a real `JWT_SECRET`
- [ ] Configure daily offsite database backups

## 18. Optional: Separate API Subdomain

If you want `api.chama.example.com` instead of proxying `/api`:

```nginx
server {
    listen 443 ssl http2;
    server_name api.chama.example.com;
    # ...ssl directives...

    location / {
        proxy_pass http://127.0.0.1:5000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Set in `backend/.env.production`:

```env
FRONTEND_ORIGIN=https://chama.example.com
```

**M-Pesa callback becomes** `https://api.chama.example.com/api/mpesa/callback`.