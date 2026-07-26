import { describe, expect, it } from 'vitest';
import {
  CLOUDFLARE_PAGES_MAX_FILE_BYTES,
  DEV_PARITY_HEADERS,
  PREVIEW_HEADERS,
  checkBuildOutput,
  pwaOptions,
  type BuiltFile,
} from './vite.config';
import viteConfig from './vite.config';
import { CSP_HEADER_STRING } from './src/trust/csp';

// U1 test scenario 1: the build must not be able to precache the ~1.5 GB
// Whisper model (KTD5). We assert on the *config shape* rather than running
// a real `vite build` — a full build is slow, needs the whole plugin chain
// to resolve, and would only prove the same thing this test proves for free.
describe('pwaOptions (vite.config.ts)', () => {
  it('ignores model-shaped assets from the precache glob', () => {
    const globIgnores = pwaOptions.workbox?.globIgnores ?? [];

    expect(globIgnores).toEqual(
      expect.arrayContaining(['**/*.onnx', '**/*.onnx_data']),
    );
  });

  it('does not raise maximumFileSizeToCacheInBytes above the Workbox default', () => {
    // The whole point of globIgnores is that the model never reaches the
    // precache step in the first place. Raising this limit would silently
    // defeat that: it must stay unset (Workbox's built-in 2 MiB default).
    expect(pwaOptions.workbox?.maximumFileSizeToCacheInBytes).toBeUndefined();
  });

  it('does not let the plugin generate a second manifest', () => {
    // public/manifest.webmanifest is hand-authored; a plugin-generated one
    // would silently shadow it or fight over the <link rel="manifest">.
    expect(pwaOptions.manifest).toBe(false);
  });

  // U13: the onnxruntime-web WASM backend is excluded from the precache
  // (above) but must still be reachable offline, or the first airplane-mode
  // reload can't instantiate ONNX Runtime and transcription breaks (R11/R12).
  // A CacheFirst runtimeCaching rule fills exactly that gap.
  describe('onnxruntime WASM offline caching', () => {
    // U4/S3 (plan 006 F3): urlPattern is now a same-origin-scoped match
    // function, not a bare RegExp — find it by shape rather than by regex test.
    const wasmRule = (pwaOptions.workbox?.runtimeCaching ?? []).find(
      (rule) => typeof rule.urlPattern === 'function',
    );
    const matchWasm = wasmRule?.urlPattern as (options: {
      url: URL;
      sameOrigin: boolean;
    }) => unknown;

    it('keeps the WASM out of the precache glob (it is runtime-cached instead)', () => {
      // The two mechanisms are a pair: excluded from precache (2 MiB limit /
      // lean SW install) AND cached at runtime. Dropping either one silently
      // reintroduces the offline break or the precache-size build failure.
      expect(pwaOptions.workbox?.globIgnores).toEqual(expect.arrayContaining(['**/*.wasm']));
    });

    it('caches the content-hashed WASM with a CacheFirst strategy', () => {
      expect(wasmRule).toBeDefined();
      expect(wasmRule?.handler).toBe('CacheFirst');
    });

    it('does not match the HF model shards (those live in transformers.js own cache, not the SW)', () => {
      expect(
        matchWasm({
          url: new URL(
            'https://huggingface.co/onnx-community/whisper-large-v3-turbo/resolve/main/onnx/decoder_model_merged_q4f16.onnx_data',
          ),
          sameOrigin: false,
        }),
      ).toBeFalsy();
    });

    // F3: origin-scope the SW runtime cache — the SW must never cache a
    // cross-origin wasm, even one that slipped through by URL shape alone.
    it('matches a same-origin .wasm URL', () => {
      expect(
        matchWasm({
          url: new URL('https://x.dev/assets/ort-wasm-simd-threaded.asyncify-DMmc6YqF.wasm'),
          sameOrigin: true,
        }),
      ).toBeTruthy();
    });

    it('does not match a cross-origin .wasm URL', () => {
      expect(
        matchWasm({
          url: new URL('https://cdn.jsdelivr.net/npm/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm'),
          sameOrigin: false,
        }),
      ).toBeFalsy();
    });

    it('does not match a same-origin non-wasm URL', () => {
      expect(
        matchWasm({
          url: new URL('https://x.dev/assets/index-DMmc6YqF.js'),
          sameOrigin: true,
        }),
      ).toBeFalsy();
    });
  });
});

// S3 (plan 006 F4): dev/preview must carry the same non-HSTS, non-CSP
// security headers as prod's public/_headers, so local testing reflects
// production behavior instead of silently diverging from it.
describe('dev/preview header parity (vite.config.ts)', () => {
  it('applies DEV_PARITY_HEADERS to the dev server', () => {
    expect(viteConfig.server?.headers).toBe(DEV_PARITY_HEADERS);
  });

  it('applies PREVIEW_HEADERS to the preview server', () => {
    expect(viteConfig.preview?.headers).toBe(PREVIEW_HEADERS);
  });

  // The regression lock for the blind spot that cost two production-only
  // failures: Workers take their CSP from their own response headers, never
  // from the page's <meta> tag, so a CSP-free preview cannot rehearse what
  // production does to a worker. `preview` must send the real thing.
  it('preview sends the production CSP as a real header, byte for byte', () => {
    expect(PREVIEW_HEADERS['Content-Security-Policy']).toBe(CSP_HEADER_STRING);
  });

  it('preview keeps the three parity headers alongside it', () => {
    expect(PREVIEW_HEADERS).toMatchObject(DEV_PARITY_HEADERS);
  });

  // Vite's HMR client needs inline script, eval and a websocket home; a
  // production CSP would break `npm run dev` outright. The rehearsal stage is
  // `preview`, not `dev`.
  it('the dev server deliberately sends no CSP', () => {
    expect(DEV_PARITY_HEADERS).not.toHaveProperty('Content-Security-Policy');
    expect(viteConfig.server?.headers).toBe(DEV_PARITY_HEADERS);
  });

  it('carries exactly the three parity headers, matching public/_headers', () => {
    expect(DEV_PARITY_HEADERS).toEqual({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Permissions-Policy': 'camera=(), geolocation=(), microphone=(self)',
    });
  });
});

// The publishability guard. Both rules exist because both failure modes have
// actually happened; see `checkBuildOutput`'s doc comment for the stories.
describe('checkBuildOutput (vite.config.ts)', () => {
  const ORT = 'assets/ort-wasm-simd-threaded.asyncify-DMmc6YqF.wasm';
  /** A realistic, publishable output: one ORT binary, comfortably under the limit. */
  const healthy: BuiltFile[] = [
    { path: 'index.html', bytes: 1792 },
    { path: 'sw.js', bytes: 1430 },
    { path: ORT, bytes: 23_567_050 },
    { path: 'assets/index-CMi9vQGL.js', bytes: 318_510 },
  ];

  it('passes a publishable build and names the largest file', () => {
    const { problems, largest } = checkBuildOutput(healthy);
    expect(problems).toEqual([]);
    expect(largest).toEqual({ path: ORT, bytes: 23_567_050 });
  });

  it('rejects a file over the per-file limit, naming it and the overage', () => {
    const { problems } = checkBuildOutput([
      ...healthy,
      { path: 'assets/huge.wasm', bytes: CLOUDFLARE_PAGES_MAX_FILE_BYTES + 1024 },
    ]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('assets/huge.wasm');
    expect(problems[0]).toContain('1,024 B over');
  });

  it('accepts a file exactly at the limit (the limit is inclusive)', () => {
    const atLimit = [
      ...healthy,
      { path: 'assets/exact.bin', bytes: CLOUDFLARE_PAGES_MAX_FILE_BYTES },
    ];
    expect(checkBuildOutput(atLimit).problems).toEqual([]);
  });

  /**
   * The regression lock for the duplicate-runtime bug. Deliberately sized so
   * BOTH binaries pass the size rule: if this ever only worked because one of
   * them was oversized, the count rule would be redundant — and the real bug
   * (a split ORT `env`, half of it still pointing at jsdelivr) would sail
   * through unnoticed.
   */
  it('rejects two ORT binaries even when both are under the size limit', () => {
    const { problems } = checkBuildOutput([
      ...healthy,
      { path: 'assets/ort-wasm-simd-threaded.jsep-CCdEhX4k.wasm', bytes: 24_000_000 },
    ]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('2 ORT WASM binaries');
    expect(problems[0]).toContain('onnxruntime-web/webgpu');
  });

  it('rejects an output with no ORT binary at all', () => {
    const { problems } = checkBuildOutput(healthy.filter((f) => f.path !== ORT));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('no ort-wasm-simd-threaded');
  });

  it('is 25 MiB, matching what Cloudflare Pages enforces', () => {
    expect(CLOUDFLARE_PAGES_MAX_FILE_BYTES).toBe(26_214_400);
  });

  it('is wired into the build as a plugin (not just exported)', () => {
    // Cast past Vite's recursive `PluginOption` type (TS2589 on a deep flat):
    // structurally, one level is all this needs — `react()` and `VitePWA()`
    // each return a flat array of plugin objects.
    type MaybePlugin = { name?: string } | null | undefined | false;
    const plugins = (viteConfig.plugins ?? []) as unknown as (MaybePlugin | MaybePlugin[])[];
    const names = plugins.flat().map((p) => (p ? p.name : undefined));
    expect(names).toContain('localrec:build-output-guard');
  });
});
