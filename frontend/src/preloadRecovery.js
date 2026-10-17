/**
 * Recovers a tab whose chunks a deploy has removed from underneath it.
 *
 * Every build writes content-hashed filenames - index-B4eicTY3.js,
 * AdminDashboard-CQIRNiJa.js - and the next build replaces them. A tab that was
 * already open is still running the previous main bundle, whose lazy routes ask
 * the server for chunks that no longer exist. The import fails, the route never
 * renders, and the person is left on an error screen reading "Failed to fetch
 * dynamically imported module" - which tells them nothing they can act on.
 *
 * This was hit for real, in production, on a deploy: an open tab navigated to
 * AdminDashboard and the page died with that message.
 *
 * Reloading is the entire fix. The page comes back from index.html, which names
 * the current bundle, and that bundle's chunk names all exist. Vite tells us when
 * a dynamic import has failed by dispatching `vite:preloadError` on window, so
 * this listens for it and reloads onto the build that is actually deployed.
 *
 * Two details are load-bearing:
 *
 *   - The event is cancelable. Left alone, Vite rethrows the underlying error
 *     after dispatching, which lands in the console as an unhandled rejection.
 *     Calling preventDefault() takes ownership of that failure. If this ever
 *     bails out without reloading it must NOT prevent, so the error still
 *     surfaces instead of leaving a route that silently never loads.
 *
 *   - The reload is rate limited. A chunk that is missing for a reason a reload
 *     cannot fix - served as HTML by a rewrite rule, or genuinely absent - would
 *     otherwise reload forever and hide the fault behind a refresh loop. One
 *     attempt, then the error is allowed through to the error boundary.
 */

/** When this tab last reloaded itself to pick up a new build. */
const MARKER = 'chama.preloadRecoveryAt';

/*
 * How long after a recovery reload the next one is suppressed.
 *
 * A reload always lands on a consistent build, so one attempt normally settles
 * it - this only has to outlast the moment of the failure, not the session.
 * Small enough that a second deploy, hours later in a tab left open overnight,
 * is still treated as new and recovers again.
 */
const RELOAD_WINDOW_MS = 10000;

export const recoverFromRemovedChunks = () => {
  if (typeof window === 'undefined') return;

  window.addEventListener('vite:preloadError', (event) => {
    let lastAttempt = 0;
    try {
      lastAttempt = Number(window.sessionStorage.getItem(MARKER)) || 0;
    } catch {
      // sessionStorage is blocked in some private modes and embedded webviews.
      // Reloading once is still better than a dead screen, so carry on with 0.
    }

    if (lastAttempt && Date.now() - lastAttempt < RELOAD_WINDOW_MS) {
      // Already tried, and the import still failed. Return without preventing,
      // so the error reaches React and the error boundary shows something the
      // person can report rather than a spinner that never resolves.
      return;
    }

    event.preventDefault();

    try {
      window.sessionStorage.setItem(MARKER, String(Date.now()));
    } catch {
      /* covered above */
    }

    window.location.reload();
  });
};
