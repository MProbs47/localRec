import { describe, expect, it } from 'vitest';
import { ortMjsUrl, ortWasmUrl, pinOrtWasmToLocalAssets, type OrtWasmEnvLike } from './ortWasmPaths';

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
