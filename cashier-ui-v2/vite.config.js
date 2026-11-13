import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Subpath deployments (staging at /cashier-v2/, prod at /cashier/) need the
  // build to prefix every asset URL. Set VITE_DEPLOY_PATH at build time; dev
  // server and root deployments use '/'.
  base: process.env.VITE_DEPLOY_PATH || '/',
  server: {
    port: 5174,
    proxy: {
      '/cashier-api': {
        target: 'http://127.0.0.1:5175',
        rewrite: (path) => path.replace(/^\/cashier-api/, '/api'),
      },
    },
  },
  build: {
    target: 'es2020',
    chunkSizeWarningLimit: 1200,
  },
});
