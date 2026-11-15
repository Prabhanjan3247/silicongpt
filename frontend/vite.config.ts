import { defineConfig, loadEnv, type ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * SiliconGPT frontend build configuration (CONTRACTS.md section 6).
 *
 * Dev server: http://localhost:5173 with `/api` proxied to the FastAPI backend.
 * Backend URL: SGPT_BACKEND_URL from the process environment or from frontend/.env.local
 * (e.g. `SGPT_BACKEND_URL=http://127.0.0.1:8010` when port 8000 is taken), default :8000.
 * AI workflows (generate RTL / testbench, debug, optimize) can run for many minutes, so the
 * proxy timeouts are generous; browser-side request timeouts live in src/services/api.ts.
 */
const PROXY_TIMEOUT_MS = 30 * 60 * 1000;

export default defineConfig(({ mode }) => {
  const fileEnv = loadEnv(mode, process.cwd(), 'SGPT_');
  const BACKEND_URL = process.env.SGPT_BACKEND_URL ?? fileEnv.SGPT_BACKEND_URL ?? 'http://127.0.0.1:8000';
  const apiProxy: Record<string, ProxyOptions> = {
    '/api': {
      target: BACKEND_URL,
      changeOrigin: true,
      timeout: PROXY_TIMEOUT_MS,
      proxyTimeout: PROXY_TIMEOUT_MS,
    },
  };
  return {
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: apiProxy,
  },
  preview: {
    port: 4173,
    strictPort: true,
    proxy: apiProxy,
  },
  // Monaco's editor worker is bundled locally through `?worker` imports (no CDN).
  // Module workers allow code-splitting inside the worker bundle.
  worker: {
    format: 'es',
  },
  build: {
    target: 'es2022',
    // The Monaco editor core is ~3 MB minified. It is only pulled in by route chunks that
    // render an editor (pages are lazy-loaded), so the large-chunk warning is expected.
    chunkSizeWarningLimit: 4096,
  },
  };
});
