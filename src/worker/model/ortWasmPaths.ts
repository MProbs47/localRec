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
 *
 * This module also owns `resolveOrtNumThreads` (below `pinOrtWasmToLocalAssets`):
 * a second, unrelated-at-first-glance but same-binary decision — how many
 * threads that pinned WASM binary is allowed to use. Kept in the same file
 * because both are "how this one ORT WASM asset gets configured before its
 * first session", not because they share logic.
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

/**
 * KTD4 (revised): `COEP: credentialless` (see `public/_headers`) makes
 * `SharedArrayBuffer` available whenever the page is cross-origin isolated,
 * which is what lets the shipped `ort-wasm-simd-threaded.asyncify` binary run
 * its WASM ops across more than one thread. Without isolation (older
 * Chromium, or a Safari visitor on the download-fallback path — Safari has
 * no `credentialless` as of writing; Firefox ships it since 119), there is no
 * `SharedArrayBuffer` and ORT silently pins itself to one thread regardless
 * of what `numThreads` says — so the `false` branch below is not a guess,
 * it is today's already-shipped, already-measured behaviour (see
 * `public/_headers`' header comment for the 58-minute-diarization measurement
 * this fixes).
 *
 * The isolated branch is deliberately conservative, not "use every core":
 *
 *  - `hardwareConcurrency - 2`: leave headroom for the UI thread (React
 *    rendering, the live VU meter) and the browser/OS's own housekeeping —
 *    pyannote/WeSpeaker inference runs post-hoc (KTD15), after recording has
 *    stopped, but the user is still expected to keep using the tab/machine
 *    while it grinds.
 *  - capped at 8: heterogeneous consumer CPUs (performance + efficiency
 *    cores) do not scale ORT's WASM thread pool linearly past a handful of
 *    threads — efficiency cores add diminishing, sometimes negative, returns
 *    once the pool contends for shared cache/memory bandwidth. 8 is a
 *    reasonable ceiling pending the real hardware measurement this still
 *    owes (HARDWARE-MILESTONE, see below).
 *  - floored at 1: `hardwareConcurrency` can itself be small (or, per spec,
 *    absent) — never return zero or negative threads.
 *
 * HARDWARE-MILESTONE (headless-unverifiable, validate on target hardware):
 * the exact formula (`- 2`, cap `8`) is a reasoned starting point, not a
 * calibrated one — confirm actual wall-clock diarization speedup on the
 * owner's 14-core machine and revisit the constants here if it under- or
 * over-subscribes.
 */
export function resolveOrtNumThreads(
  crossOriginIsolated: boolean,
  hardwareConcurrency: number | undefined,
): number {
  if (!crossOriginIsolated) return 1;
  if (!hardwareConcurrency || hardwareConcurrency < 1) return 1;
  return Math.min(8, Math.max(1, hardwareConcurrency - 2));
}
