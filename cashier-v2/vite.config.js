import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

export default defineConfig({
  base: './',
  plugins: [react(), {
    name: 'local-sqb',
    configureServer(server) {
      const { createService } = require('./payments/service.cjs');
      const { paymentMiddleware } = require('./payments/http.cjs');
      server.middlewares.use(paymentMiddleware(createService({ directory: path.join(os.homedir(), '.stall-cashier-sqb-web'), exclusive: true })));
    },
  }],
});
