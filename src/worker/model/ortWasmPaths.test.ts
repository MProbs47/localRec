import { describe, expect, it } from 'vitest';
import {
  ortMjsUrl,
  ortWasmUrl,
  pinOrtWasmToLocalAssets,
  resolveOrtNumThreads,
  type OrtWasmEnvLike,
} from './ortWasmPaths';

describe('ortWasmPaths', () => {
  it('resolves the wasm asset URL to a local, non-http path ending in .wasm', () => {
    expect(ortWasmUrl).toBeTypeOf('string');
    expect(ortWasmUrl.length).toBeGreaterThan(0);
    expect(ortWasmUrl.startsWith('http')).toBe(false);
    expect(ortWasmUrl.endsWith('.wasm')).toBe(true);
  });

  it('resolves the mjs asset URL to a local, non-http path ending in .mjs', () => {
    expect(ortMjsUrl).toBeTypeOf('string');
    expect(ortMjsUrl.length).toBeGreaterThan(0);
    expect(ortMjsUrl.startsWith('http')).toBe(false);
    expect(ortMjsUrl.endsWith('.mjs')).toBe(true);
  });

  it('pins wasmPaths to exactly the local asset URLs', () => {
    const wasmEnv: OrtWasmEnvLike = {};
    pinOrtWasmToLocalAssets(wasmEnv);
    expect(wasmEnv.wasmPaths).toEqual({ mjs: ortMjsUrl, wasm: ortWasmUrl });
  });

  it('overwrites a pre-existing (e.g. jsdelivr) wasmPaths value', () => {
    const wasmEnv: OrtWasmEnvLike = {
      wasmPaths: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.0.0/dist/',
    };
    pinOrtWasmToLocalAssets(wasmEnv);
    expect(wasmEnv.wasmPaths).toEqual({ mjs: ortMjsUrl, wasm: ortWasmUrl });
  });
});

// Reality check for this unit: there is no real browser here, so
// `crossOriginIsolated`/`hardwareConcurrency` are always caller-supplied
// plain values, never read off a live `self`/`navigator` — this only proves
// the formula (KTD4 revised, see `ortWasmPaths.ts`'s doc comment), not that a
// given browser actually reports isolation or a given core count truthfully.
// The real thread-count payoff (does diarization actually speed up) is a
// hardware milestone, not something this suite can measure.
describe('resolveOrtNumThreads', () => {
  it('pins to 1 thread when the page is not cross-origin isolated, regardless of core count', () => {
    expect(resolveOrtNumThreads(false, 14)).toBe(1);
    expect(resolveOrtNumThreads(false, 1)).toBe(1);
    expect(resolveOrtNumThreads(false, undefined)).toBe(1);
  });

  it('falls back to 1 thread when hardwareConcurrency is unavailable, even if isolated', () => {
    // Per spec `navigator.hardwareConcurrency` can be absent; without a core
    // count to reason from, 1 is the only safe default.
    expect(resolveOrtNumThreads(true, undefined)).toBe(1);
  });

  it('floors at 1 thread on a single-core machine (the -2 headroom would go negative)', () => {
    expect(resolveOrtNumThreads(true, 1)).toBe(1);
  });

  it('leaves 2-core headroom for the UI/OS on a mid-size machine', () => {
    expect(resolveOrtNumThreads(true, 6)).toBe(4);
  });

  it('caps at 8 threads on a high core-count machine (the owner\'s 14-core measurement)', () => {
    expect(resolveOrtNumThreads(true, 14)).toBe(8);
  });

  it('treats a reported 0 core count the same as unavailable', () => {
    expect(resolveOrtNumThreads(true, 0)).toBe(1);
  });
});
