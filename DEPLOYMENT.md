# Putting THE TEAM on a real address

The app runs on one port by itself. The backend serves the API *and* the built
frontend, so there is no second server and nothing to keep in sync:

```
http://localhost:5000/admin     administrators
http://localhost:5000/member    members
http://localhost:5000/login     signing in
```

That is enough for a committee member to use. If you want it to look like a
proper address with no port at all — `https://yourchama.co.ke/admin` — put a
reverse proxy in front. That is the only extra piece, and it is a standard
config file rather than code.

Nothing else changes. The proxy forwards `/api` to the backend and serves
everything else the same way.

---

## Before you start

Build the app. The proxy serves what is on disk, so a stale build is the most
common cause of "my change did not show up".

```bash
npm run build
```

---

## Option 1: Caddy — the shortest, and it gets you HTTPS free

Caddy issues and renews a TLS certificate on its own. This is the least to
maintain if you have a domain pointing at the machine.

```caddy
yourchama.co.ke {
    encode gzip

    handle /api/* {
        reverse_proxy localhost:5000
    }

    handle {
        reverse_proxy localhost:5000
    }
}
```

Replace `yourchama.co.ke` with your domain, make sure DNS points at this
machine, open ports 80 and 443, and start it:

```bash
caddy run --config Caddyfile
```

`npm run install` still runs the app; Caddy just sits in front of it.

---

## Option 2: nginx

```nginx
server {
    listen 80;
    server_name yourchama.co.ke;

    # The built frontend. Long cache on hashed files, none on the shell.
    root /var/www/the-team/frontend/dist;
    index index.html;

    location /assets/ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    # The shell must never be cached, or people keep loading a page that points
    # at assets which no longer exist.
    location = /index.html {
        add_header Cache-Control "no-cache, no-store, must-revalidate";
    }

    location = /sw.js {
        add_header Cache-Control "no-cache, no-store, must-revalidate";
    }

    location /api/ {
        proxy_pass http://127.0.0.1:5000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    /*
     * Deep links like /admin/settings are handled by the app, not by a file on
     * disk. Without this, refreshing one returns 404.
     */
    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

For HTTPS, run `certbot --nginx -d yourchama.co.ke` afterwards and it will add the
rest.

---

## Option 3: Apache — if you already run XAMPP

XAMPP's Apache already listens on port 80, so this avoids a port clash.

1. Copy `deploy/apache-vhost.conf` to `C:\xampp\apache\conf\extra\httpd-vhosts.conf`
2. Point `DocumentRoot` at your `frontend/dist` folder
3. Remove or comment out the line that says `Include conf/extra/httpd-vhosts.conf`
   in `httpd.conf` if it is already commented out — it must be *uncommented*
4. Restart Apache from the XAMPP control panel

---

## Running it as a service

So it comes back after a reboot.

**With PM2** (already installed):

```bash
cd the-team
pm2 start ecosystem.config.js
pm2 save
pm2 startup
```

**As a Windows service**, run this in an Administrator prompt once:

```
nssm install theteam "C:\Program Files\nodejs\node.exe" "C:\path\to\the-team\backend\server.js"
nssm set theteam AppDirectory "C:\path\to\the-team\backend"
nssm start theteam
```

---

## If you would rather have no port at all on your own machine

Set the app to listen on port 80 in `backend/.env`:

```
PORT=80
```

**On Windows this needs one extra step**, because Windows will not let an
ordinary program bind port 80. Open an Administrator prompt once:

```
netsh interface portproxy add v4tov4 listenport=80 listenaddress=0.0.0.0 connectport=5000 connectaddress=127.0.0.1
```

Then `http://localhost/admin` works with no port at all.

To undo it:

```
netsh interface portproxy delete v4tov4 listenport=80 listenaddress=0.0.0.0
```

On Linux and macOS this is not needed — just set `PORT=80` and it works.

Note that XAMPP's Apache also wants port 80. Pick one: Apache proxying to the
app (Option 3), or the app on 80 with Apache stopped.

---

## Checking it worked

```bash
curl -I http://localhost:5000/admin          # 200, text/html
curl -I http://localhost:5000/assets/...js   # 200, long cache
curl    http://localhost:5000/api/health     # {"status":"ok"}
curl -I http://localhost:5000/admin/settings # 200 — this one matters
```

The last one is the one to check. If it returns 404 the SPA fallback is not
working, and every deep link and shared link in the app will break on refresh.

---

## Things worth knowing

**Do not cache `index.html`.** It names the hashed asset files. Cache it and
people keep loading a page pointing at files you deleted — which looks exactly
like the app being broken.

**`sw.js` must not be cached either.** A cached service worker keeps serving an
old shell indefinitely.

**Keep `/api` in front of the app.** If the proxy sends `/api` to the static
files, every request gets the HTML page instead of JSON, and the frontend
fails to parse it.

**HTTPS matters for this app.** M-Pesa callbacks and any future camera or
location use require it, and a member entering a password over plain HTTP on a
shared phone is exposed. Get a certificate.