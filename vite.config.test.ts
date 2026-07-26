import { describe, expect, it } from 'vitest';
import { DEV_PARITY_HEADERS, pwaOptions } from './vite.config';
import viteConfig from './vite.config';

// U1 test scenario 1: the build must not be able to precache the ~0.6 GB
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

  it('applies DEV_PARITY_HEADERS to the preview server', () => {
    expect(viteConfig.preview?.headers).toBe(DEV_PARITY_HEADERS);
  });

  it('carries exactly the three parity headers, matching public/_headers', () => {
    expect(DEV_PARITY_HEADERS).toEqual({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Permissions-Policy': 'camera=(), geolocation=(), microphone=(self)',
    });
  });
});
