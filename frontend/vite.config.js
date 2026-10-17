import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/*
 * Where the app is served from.
 *
 * '/' is the ordinary case: a domain of its own, or a Node server on its own
 * port. Anything else is a sub-path deployment, where the app lives in a folder
 * rather than owning the whole domain - `localhost/the-team/`, for instance,
 * sitting alongside other apps on one XAMPP or one nginx.
 *
 * Read from the environment rather than hardcoded, so the same build can be
 * pointed anywhere without editing source. Must start and end with a slash:
 * Vite joins paths against this, and a missing trailing slash quietly drops the
 * last segment of every asset URL.
 */
const rawBase = process.env.APP_BASE_PATH || '/';
const base = rawBase.endsWith('/') ? rawBase : rawBase + '/';

export default defineConfig({
  // `base` becomes import.meta.env.BASE_URL in the app, which is what the router
  // basename, the API base and the service worker scope are all derived from. One
  // setting, so they cannot disagree.
  base,

  plugins: [react()],

  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true
      }
    }
  },

  preview: {
    port: 4173,
    proxy: {
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true
      }
    }
  }
});