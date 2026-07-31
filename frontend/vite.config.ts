import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    // Cloudflare Pages direct uploads have repeatedly omitted the nested
    // assets directory. Emit executable and stylesheet assets at the root so
    // a deployment cannot publish index.html without its matching bundle.
    assetsDir: '',
  },
  resolve: {
    alias: {
      '@pact/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)),
    },
  },
  server: {
    port: 5173,
  },
});
