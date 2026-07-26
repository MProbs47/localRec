import { readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA, type VitePWAOptions } from 'vite-plugin-pwa';
import { CSP_HEADER_STRING } from './src/trust/csp';

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
// prod. HSTS is deliberately absent: it is meaningless over plain http.
export const DEV_PARITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), geolocation=(), microphone=(self)',
};

/**
 * `vite preview` additionally serves the REAL CSP header — the same string
 * `public/_headers` ships.
 *
 * This used to be skipped, with the reasoning that `index.html`'s `<meta>` CSP
 * covers local pages and "dev workers staying CSP-free is fine locally". That
 * reasoning was wrong, and it cost two production-only failures: a Worker
 * takes its CSP from the HTTP headers of its OWN script response and never
 * from the page's meta tag, so every local run exercised a CSP-free worker
 * while production ran a locked-down one. Both bugs — transformers.js falling
 * back to a jsdelivr fetch, and ORT dynamic-importing its glue from a `blob:`
 * URL — lived exactly in that blind spot and were invisible until deploy.
 *
 * `preview` serves the production bundle, so the production CSP belongs on it.
 *
 * **The dev server keeps no CSP, on purpose.** Vite's HMR client needs inline
 * script, `eval` and a websocket back to the dev server; a production-grade
 * CSP would break `npm run dev` outright. `preview` is the honest rehearsal
 * stage — run it before shipping.
 */
export const PREVIEW_HEADERS = {
  ...DEV_PARITY_HEADERS,
  'Content-Security-Policy': CSP_HEADER_STRING,
};

/**
 * Cloudflare Pages rejects **any single file** larger than this — the whole
 * deploy fails, not just that asset (KTD12). Documented as 25 MiB.
 */
export const CLOUDFLARE_PAGES_MAX_FILE_BYTES = 25 * 1024 * 1024;

/** Matches the ONNX Runtime WASM binaries Vite emits under `assets/`. */
const ORT_WASM_PATTERN = /(^|\/)ort-wasm-simd-threaded[.\-\w]*\.wasm$/;

export interface BuiltFile {
  /** Path relative to the output directory, POSIX separators. */
  path: string;
  bytes: number;
}

export interface BuildOutputReport {
  /** Human-readable failures; empty means the output is publishable. */
  problems: string[];
  largest: BuiltFile | null;
}

/**
 * The publishability check, kept pure so it is testable without running a
 * build (same discipline as `pwaOptions` above).
 *
 * Two things it refuses to let out the door, both learned the expensive way:
 *
 *  1. **A file over Cloudflare's per-file limit.** Without this the first
 *     symptom is a rejected deploy with Cloudflare's own wording, after a
 *     push — the guard moves that failure into the local build, where the
 *     offending file and its size are named.
 *
 *  2. **More or fewer than exactly one ORT WASM binary.** Not a size check:
 *     the app once shipped TWO complete onnxruntime-web runtimes because the
 *     diarization worker imported the bare `onnxruntime-web` entry while
 *     transformers.js imports `onnxruntime-web/webgpu`. That emitted a second,
 *     26.1 MB binary nothing ever fetched, and split ORT's `env` singleton in
 *     two so the WASM-path pin only reached half of it. Each binary on its own
 *     is UNDER the size limit, so rule 1 cannot see this — hence a separate
 *     count. Zero is a regression too: no binary means no ORT, i.e. no
 *     transcription and a broken first offline reload.
 */
export function checkBuildOutput(files: readonly BuiltFile[]): BuildOutputReport {
  const problems: string[] = [];

  for (const file of files) {
    if (file.bytes > CLOUDFLARE_PAGES_MAX_FILE_BYTES) {
      const over = file.bytes - CLOUDFLARE_PAGES_MAX_FILE_BYTES;
      problems.push(
        `${file.path} is ${file.bytes.toLocaleString('en-US')} B — ` +
          `${over.toLocaleString('en-US')} B over Cloudflare Pages' ` +
          `${CLOUDFLARE_PAGES_MAX_FILE_BYTES.toLocaleString('en-US')} B per-file limit. ` +
          `Pages would reject the whole deploy.`,
      );
    }
  }

  const ortWasm = files.filter((f) => ORT_WASM_PATTERN.test(f.path));
  if (ortWasm.length !== 1) {
    problems.push(
      ortWasm.length === 0
        ? 'no ort-wasm-simd-threaded*.wasm in the output — ONNX Runtime cannot start, ' +
          'so transcription and the first offline reload are both broken.'
        : `${ortWasm.length} ORT WASM binaries in the output (${ortWasm
            .map((f) => f.path)
            .join(', ')}) — expected exactly 1. Two runtimes means two \`env\` ` +
          'singletons: the wasmPaths pin reaches only one of them, and the other ' +
          'falls back to its jsdelivr default, which the CSP blocks in production. ' +
          'Import `onnxruntime-web/webgpu` everywhere, never the bare entry.',
    );
  }

  const largest = files.reduce<BuiltFile | null>(
    (max, f) => (max === null || f.bytes > max.bytes ? f : max),
    null,
  );

  return { problems, largest };
}

/** Every file under `dir`, recursively, with sizes and POSIX-relative paths. */
function collectFiles(dir: string, root = dir): BuiltFile[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return collectFiles(full, root);
    if (!entry.isFile()) return [];
    return [{ path: relative(root, full).split('\\').join('/'), bytes: statSync(full).size }];
  });
}

/**
 * Runs `checkBuildOutput` over the real output once the bundle is written, so
 * an unpublishable build fails here instead of at Cloudflare. Registered last
 * (and `enforce: 'post'`) so the PWA plugin's generated service worker is
 * already on disk and gets measured too.
 */
function buildOutputGuard(outDir = 'dist'): Plugin {
  return {
    name: 'localrec:build-output-guard',
    apply: 'build',
    enforce: 'post',
    closeBundle() {
      const { problems, largest } = checkBuildOutput(collectFiles(resolve(outDir)));

      if (problems.length > 0) {
        throw new Error(
          `Build output is not publishable:\n${problems.map((p) => `  - ${p}`).join('\n')}`,
        );
      }

      if (largest) {
        const pct = ((largest.bytes / CLOUDFLARE_PAGES_MAX_FILE_BYTES) * 100).toFixed(1);
        console.log(
          `\nlargest file: ${largest.path} — ${largest.bytes.toLocaleString('en-US')} B ` +
            `(${pct} % of Cloudflare's per-file limit)`,
        );
      }
    },
  };
}

export default defineConfig({
  // Cloudflare Pages serves the app from the domain root (KTD12).
  base: '/',
  plugins: [react(), VitePWA(pwaOptions), buildOutputGuard()],
  server: { headers: DEV_PARITY_HEADERS },
  preview: { headers: PREVIEW_HEADERS },
});
