import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA, type VitePWAOptions } from 'vite-plugin-pwa';

/**
 * `vite-plugin-pwa` options, exported by name so tests can assert on the
 * config's shape (globIgnores, precache limit) without running a real build
 * (U1 test scenario 1). Importing this constant alone must not construct
 * the plugin or touch the filesystem — see `VitePWA(pwaOptions)` below for
 * the only place the plugin is actually instantiated.
 *
 * `generateSW` (the default strategy) precaches the App Shell. The Whisper
 * model (~0.6 GB, KTD5) is NEVER part of that: it lives in OPFS, fetched at
 * runtime by the app itself, not through the build's asset pipeline. These
 * `globIgnores` are a defensive backstop in case a model-shaped file ever
 * ends up under `public/` or the build output by mistake — Workbox's
 * `maximumFileSizeToCacheInBytes` default (2 MiB) is deliberately left
 * untouched so such a file would fail the precache build loudly instead of
 * silently ballooning the service worker cache.
 *
 * `**\/*.wasm` (added in U4, once `App.tsx` first pulled `transcription.worker.ts`
 * — and with it `@huggingface/transformers`'s `onnxruntime-web` dependency —
 * into a real build graph reachable from `index.html`): ONNX Runtime Web
 * ships a multi-MB WASM backend binary as a static asset. Vite resolves the
 * `new URL('ort-wasm-…​.wasm', import.meta.url)` reference inside
 * transformers.js at build time and emits it same-origin under
 * `assets/` (~23 MB, content-hashed) — so the CSP (`script-src 'self'`,
 * `connect-src 'self' …`) is satisfied without any CDN. It is even needed on
 * the WebGPU path (KTD10): onnxruntime's WebGPU execution provider is the
 * JSEP/asyncify WASM build, not a pure-JS backend. It stays out of the
 * precache (same "large runtime binary, not app-shell code" category as the
 * model, and it would blow Workbox's 2 MiB precache limit) — but, unlike the
 * model, it is NOT stored in transformers.js' own browser-Cache-API bucket,
 * so without the `runtimeCaching` rule below the service worker would have no
 * copy of it and the very first offline reload would fail to instantiate ONNX
 * Runtime — i.e. transcription would break in exactly the airplane-mode
 * scenario this app is built to prove (R11/R12). `runtimeCaching` (CacheFirst)
 * is the lean fix: the content-hashed, immutable WASM is cached the first
 * time it is fetched (during the one online first-run model load), then served
 * from cache forever after — including offline. See U13.
 */
export const pwaOptions: Partial<VitePWAOptions> = {
  registerType: 'autoUpdate',
  // public/manifest.webmanifest is hand-authored (installability, KTD8);
  // the plugin must not generate or inject a second one.
  manifest: false,
  workbox: {
    globIgnores: [
      '**/*.onnx',
      '**/*.onnx_data',
      '**/*.onnx.data',
      '**/models/**',
      '**/*.wasm',
    ],
    runtimeCaching: [
      {
        // The onnxruntime-web WASM backend (see above). CacheFirst because the
        // emitted file is content-hashed and therefore immutable: once cached
        // it never needs revalidation, and a transformers.js upgrade changes
        // the hash → a new URL → a natural cache miss + refetch. This is the
        // one rule that makes the app genuinely offline-capable after the
        // first online model load. `sameOrigin` is required in addition to
        // the `.wasm` suffix: the SW must never cache a cross-origin wasm —
        // defense-in-depth against any future third-party fetch slipping
        // through (see plan 006 F1/F3).
        urlPattern: ({ url, sameOrigin }) => sameOrigin && url.pathname.endsWith('.wasm'),
        handler: 'CacheFirst',
        options: {
          cacheName: 'onnx-runtime-wasm',
          expiration: { maxEntries: 4 },
          cacheableResponse: { statuses: [0, 200] },
        },
      },
    ],
  },
};

// Mirrors public/_headers (F4) so `npm run dev`/`vite preview` behave like
// prod. Deliberately a subset: HSTS is meaningless over plain http, and CSP
// is skipped here because index.html's meta CSP already covers dev pages
// and dev workers staying CSP-free is fine locally. Keep in sync with
// public/_headers by hand — see the comment there for the source of truth.
export const DEV_PARITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), geolocation=(), microphone=(self)',
};

export default defineConfig({
  // Cloudflare Pages serves the app from the domain root (KTD12).
  base: '/',
  plugins: [react(), VitePWA(pwaOptions)],
  server: { headers: DEV_PARITY_HEADERS },
  preview: { headers: DEV_PARITY_HEADERS },
});
