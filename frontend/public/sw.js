/**
 * Service worker.
 *
 * Its main job is to make the app installable: Chrome refuses to fire
 * `beforeinstallprompt` unless a service worker with a fetch handler is
 * registered. Offline support is a bonus, not the point.
 *
 * The important rule here is what it does NOT cache: anything under /api.
 *
 * This is a savings group app. A stale contribution total or loan balance is
 * worse than no offline support at all, because it looks authoritative and
 * invites a decision based on numbers that are no longer true. So API traffic is
 * always network-first with no cache fallback, and the shell is only ever used
 * when the network genuinely cannot be reached.
 */

/*
 * Bumped from v1 when the API check was corrected below.
 *
 * Until then a sub-path install did not recognise its own API traffic, so
 * responses carrying contribution totals and loan balances were cached as if
 * they were static assets. The corrected worker never reads those entries -
 * API requests now return early - but a reader cannot see that from the cache,
 * and balances do not belong in browser storage. A new name means the activate
 * handler below deletes the old caches instead of leaving them in place.
 */
const VERSION = 'v2';
const SHELL_CACHE = `chama-shell-${VERSION}`;
const ASSET_CACHE = `chama-assets-${VERSION}`;

/*
 * The folder this worker was registered to serve.
 *
 * A worker can only control paths at or below its own location, and pwa.js
 * registers this one with the deployment prefix as its scope - so the scope is
 * exactly that prefix: '/' at the root of a domain, '/the-team/' when the app
 * lives in a folder.
 *
 * Reading it here rather than hardcoding '/' matters more than it looks. The API
 * check below looks for a path beginning '/api/', which never matches
 * '/the-team/api/...', so a sub-path install was classifying every contribution
 * total and loan balance as a cacheable static asset - the one thing this file
 * exists to prevent.
 */
const BASE = new URL(self.registration.scope).pathname;

// The shell. Hashed build assets are picked up at runtime instead of being
// listed here, because their filenames change on every build.
const PRECACHE = [
  BASE,
  BASE + 'index.html',
  BASE + 'manifest.webmanifest',
  BASE + 'icon-192.png',
  BASE + 'icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      // addAll is all-or-nothing: one 404 would leave the app uninstallable, so
      // each entry is added individually and a miss is tolerated.
      .then((cache) => Promise.allSettled(PRECACHE.map((url) => cache.add(url))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith('chama-') && key !== SHELL_CACHE && key !== ASSET_CACHE)
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  // Lets the page ask a waiting worker to take over immediately, so an update
  // does not need the tab to be closed.
  if (event.data === 'skip-waiting') self.skipWaiting();
});

const isApiRequest = (url) =>
  url.pathname.startsWith(BASE + 'api/') ||
  url.pathname === BASE + 'api' ||
  url.pathname.startsWith(BASE + 'socket.io');

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Never touch a non-GET. A POST to a cached-looking URL must reach the server
  // or a payment would silently fail.
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  /**
   * API traffic: network only.
   *
   * No cache read and no cache write. If the network is down the request fails,
   * which is the correct outcome for a balance.
   */
  if (isApiRequest(url)) return;

  /**
   * Navigations: network first, cached shell as the offline fallback.
   *
   * Network first so a deploy is picked up on the next load rather than being
   * pinned to a stale index.html until the cache is evicted.
   */
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(SHELL_CACHE).then((cache) => cache.put(BASE + 'index.html', copy));
          return response;
        })
        .catch(() =>
          caches.match(BASE + 'index.html').then((cached) => cached || Response.error())
        )
    );
    return;
  }

  /**
   * Static assets: cache first, then fill in the background.
   *
   * Build output is content-hashed, so a cached hit is always the right version
   * and this is effectively free. The revalidation keeps things honest if a file
   * is ever not hashed.
   */
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response && response.status === 200 && response.type === 'basic') {
            const copy = response.clone();
            caches.open(ASSET_CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});