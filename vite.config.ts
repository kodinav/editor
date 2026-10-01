import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { createReadStream, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

// Content-Security-Policy is injected only into production builds; the dev
// server relies on inline scripts for hot module replacement.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "media-src 'self' blob:",
  "font-src 'self' blob: data:",
  "worker-src 'self' blob:",
  // Speech models for on-device auto-captions come from Hugging Face; user media never does.
  "connect-src 'self' blob: data: https://huggingface.co https://*.hf.co",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ');

function cspPlugin(): Plugin {
  return {
    name: 'cutline-csp',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace(
        '<meta charset="UTF-8" />',
        `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`,
      );
    },
  };
}

/**
 * Emits /sw.js with the exact list of build outputs, so the app shell works
 * offline after the first visit. Runtime media never touches the network.
 */
function serviceWorkerPlugin(): Plugin {
  return {
    name: 'cutline-sw',
    apply: 'build',
    generateBundle(_opts, bundle) {
      const files = Object.keys(bundle).filter((f) => !f.endsWith('.map') && f !== 'sw.js' && !f.startsWith('ort/'));
      const version = createHash('sha256').update(files.sort().join('|')).digest('hex').slice(0, 12);
      const precache = ['./', ...files.map((f) => './' + f), './favicon.svg', './manifest.webmanifest'];
      const source = readFileSync(fileURLToPath(new URL('./src/sw-template.js', import.meta.url)), 'utf8')
        .replace('__VERSION__', version)
        .replace('__PRECACHE__', JSON.stringify(precache));
      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
  };
}

/**
 * Self-host the ONNX Runtime WebAssembly files used by on-device speech
 * recognition (instead of loading code from a CDN). They are large (~27 MB)
 * and only fetched when the user runs auto-captions, so they are excluded
 * from the offline precache.
 */
const ORT_FILES = ['ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm'];
const ORT_DIR = fileURLToPath(new URL('./node_modules/onnxruntime-web/dist/', import.meta.url));
function ortAssetsPlugin(): Plugin {
  return {
    name: 'cutline-ort',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const m = req.url ? /^\/ort\/([\w.-]+)$/.exec(req.url.split('?')[0]) : null;
        if (!m || !ORT_FILES.includes(m[1])) return next();
        res.setHeader('Content-Type', m[1].endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
        createReadStream(ORT_DIR + m[1]).pipe(res);
      });
    },
    generateBundle() {
      for (const f of ORT_FILES) this.emitFile({ type: 'asset', fileName: 'ort/' + f, source: readFileSync(ORT_DIR + f) });
    },
  };
}

export default defineConfig({
  plugins: [react(), cspPlugin(), ortAssetsPlugin(), serviceWorkerPlugin()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  worker: {
    format: 'es',
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 1500,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
  },
} as never);
