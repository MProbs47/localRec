/**
 * S1 privacy fix. `@huggingface/transformers` 4.2.0's `src/backends/onnx.js`
 * sets `ONNX_ENV.wasm.wasmPaths` to a `cdn.jsdelivr.net` URL at *module import
 * time*, whenever it isn't running in a service worker and `wasmPaths` isn't
 * already set — see the installed copy at
 * `node_modules/@huggingface/transformers/src/backends/onnx.js` (~L338-361).
 * Both `transcription.worker.ts` and `diarization.worker.ts` import
 * transformers.js and never overrode that default, so the ORT WASM binary
 * would load from a third-party origin: in dev, workers get no CSP (worker
 * CSP comes from response headers, not the page's meta tag) so the fetch
 * would actually go out; in production, the CSP `connect-src` (see
 * `src/trust/csp.ts`, HF hosts only) would block it and ORT init would break.
 * Either way it violates "nichts verlässt das Gerät".
 *
 * The fix: point `wasmPaths` at the Vite-bundled local copies instead of
 * adding jsdelivr to the CSP allowlist. Only the **asyncify** variant is
 * pinned — the non-Safari branch of transformers.js' own default (see the
 * onnx.js excerpt above), which is what this Chromium-only app actually
 * loads; the current `dist/assets` output confirms
 * `ort-wasm-simd-threaded.asyncify-*.wasm` is the file that ships.
 */
// Note: `onnxruntime-web`'s `package.json` "exports" map only publishes these
// two files at top-level subpaths (no `dist/` prefix) — confirmed against the
// installed package.json; a `dist/...` specifier 404s under Node's exports
// resolution (which Vite/Vitest enforce).
import ortWasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url';
import ortMjsUrl from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url';

export { ortWasmUrl, ortMjsUrl };

/**
 * The exact shape this file needs to write to — narrower than ort's own
 * `Env['wasm']` type (which this module deliberately does not import; same
 * discipline as the other `*Like` DI shims in this codebase, e.g.
 * `mixStreams.ts`/`opfsAudio.ts`: a structural type keeps this file
 * Node/Vitest-testable against a plain fake object). The `wasmPaths` shape
 * mirrors onnxruntime-common's own optional/`string | URL` fields so the
 * real `env.backends.onnx.wasm` / `ort.env.wasm` singletons are structurally
 * assignable here without importing their types.
 */
export interface OrtWasmEnvLike {
  wasmPaths?: string | { mjs?: string | URL; wasm?: string | URL };
}

/**
 * Pins `wasmEnv.wasmPaths` to the local Vite-bundled asyncify assets,
 * overwriting whatever transformers.js' onnx.js already set (its jsdelivr
 * default, or anything else). Call order relative to transformers.js'
 * module-level assignment doesn't matter: `wasmPaths` is only *read* lazily
 * on first ORT session creation, so whichever value is present at that
 * point wins — as long as this call happens before the engine actually
 * creates a session, the local paths are what gets used.
 */
export function pinOrtWasmToLocalAssets(wasmEnv: OrtWasmEnvLike): void {
  wasmEnv.wasmPaths = { mjs: ortMjsUrl, wasm: ortWasmUrl };
}
