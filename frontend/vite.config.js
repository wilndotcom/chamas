import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The API proxy is declared once and reused, so `vite preview` and any other
// server mode talk to the backend the same way `vite dev` does. Without this,
// previewing a production build silently failed every request instead of
// proxying them, which reads as the app being broken rather than a config gap.
const proxy = {
  '/api': {
    target: 'http://localhost:5000',
    changeOrigin: true
  }
};

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    proxy
  },
  preview: {
    port: 4173,
    proxy
  }
});
