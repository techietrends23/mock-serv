import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: rootDir,
  plugins: [react()],
  resolve: {
    alias: {
      // Use browser-safe entry so Vite does not pull Fastify/Playwright/SQLite into the client.
      '@mock-serv/core': path.resolve(rootDir, '../../packages/core/src/browser.ts'),
      fsevents: path.resolve(rootDir, 'fsevents-stub.js')
    }
  },
  optimizeDeps: {
    exclude: ['fsevents'],
    include: ['react', 'react-dom', 'react-dom/client'],
    holdUntilCrawlEnd: false
  },
  server: {
    host: '127.0.0.1',
    watch: {
      usePolling: true,
      interval: 300
    },
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${process.env.MOCK_SERV_PORT || 3001}`,
        changeOrigin: true
      }
    }
  }
});
