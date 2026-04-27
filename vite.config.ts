import { defineConfig } from 'vite';

// SharedArrayBuffer requires cross-origin isolation — both COOP=same-origin
// and COEP=require-corp must be sent by the dev/preview servers. Without
// them, `crossOriginIsolated` is false and `new SharedArrayBuffer(...)`
// throws.
const crossOriginIsolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  root: '.',
  server: {
    headers: crossOriginIsolationHeaders,
  },
  preview: {
    headers: crossOriginIsolationHeaders,
  },
  worker: {
    format: 'es',
  },
});
