/**
 * Single source of truth for the app's Content-Security-Policy (KTD9, R10).
 *
 * "Nichts verlässt das Gerät": after the one-time model download, every
 * outgoing connection must be technically blocked, not just promised.
 *
 * `index.html`'s <meta http-equiv="Content-Security-Policy"> and
 * `public/_headers`' `Content-Security-Policy` header are both static files
 * and can't import this module at request time. Generating them at build
 * time would be possible but is YAGNI for a two-file, rarely-changing CSP —
 * instead, this file is the conceptual source of truth, both static files
 * are hand-written to match it, and `csp.test.ts` fails the build the moment
 * they drift apart.
 */

/**
 * The Hugging Face Hub hosts used for the one-time model downloads
 * (`onnx-community/whisper-large-v3-turbo` for transcription, and the Phase D
 * diarization set — `onnx-community/pyannote-segmentation-3.0` +
 * `onnx-community/wespeaker-voxceleb-resnet34-LM`). transformers.js / ort
 * request `https://huggingface.co`, which 302-redirects the actual weight
 * files to a regional CDN.
 *
 * **Xet CDN (`*.hf.co`) — why the wildcard.** HF migrated large-file storage
 * to Xet, whose weight downloads now redirect to regional hosts under
 * `hf.co` (e.g. `us.aws.cdn.hf.co`, `eu.aws.cdn.hf.co`), NOT the older
 * `cdn-lfs*.huggingface.co` hosts. A `connect-src` that listed only
 * `huggingface.co` + the `cdn-lfs*` hosts therefore silently blocked those
 * redirects — which is exactly what made the diarization model download fail
 * on first use (the meeting-mode "Sprecher-Erkennung übersprungen"): Whisper
 * had been cached in an earlier session so it never re-fetched, hiding the
 * gap. The regional Xet hostname varies (and HF adds more), so a single
 * `https://*.hf.co` wildcard is the robust, region-agnostic allowance —
 * still scoped to HF-owned origins, still only for the model downloads.
 *
 * These are the ONLY allowed third-party origins anywhere in the CSP — see
 * KTD12 for the later upgrade to a same-origin model host (Cloudflare R2), at
 * which point this list goes away entirely.
 */
export const HF_MODEL_HOSTS = [
  'https://huggingface.co',
  'https://*.hf.co',
  'https://cdn-lfs.huggingface.co',
  'https://cdn-lfs-us-1.huggingface.co',
  'https://cdn-lfs-eu-1.huggingface.co',
] as const;

/**
 * Directives that are valid both as a real HTTP header and inside a
 * `<meta http-equiv="Content-Security-Policy">` tag. `script-src` carries
 * `'wasm-unsafe-eval'` because the ONNX Runtime WASM fallback used by
 * transformers.js needs it even though the primary path is WebGPU.
 */
export const CSP_CORE_DIRECTIVES = {
  'default-src': ["'self'"],
  'connect-src': ["'self'", ...HF_MODEL_HOSTS],
  'script-src': ["'self'", "'wasm-unsafe-eval'"],
  'style-src': ["'self'", "'unsafe-inline'"],
  'img-src': ["'self'", 'data:', 'blob:'],
  'worker-src': ["'self'", 'blob:'],
  'object-src': ["'none'"],
  'base-uri': ["'self'"],
} as const satisfies Record<string, readonly string[]>;

/**
 * Directives that only take effect as a real HTTP header. Browsers ignore
 * `frame-ancestors` (and a few others, none of which we need) inside
 * `<meta http-equiv>` — per spec it must come from a header. These go into
 * `public/_headers` only, never into `index.html`.
 */
export const CSP_HEADER_ONLY_DIRECTIVES = {
  'frame-ancestors': ["'none'"],
} as const satisfies Record<string, readonly string[]>;

function buildCsp(directives: Record<string, readonly string[]>): string {
  return Object.entries(directives)
    .map(([directive, values]) => `${directive} ${values.join(' ')}`)
    .join('; ');
}

/** CSP string for `index.html`'s `<meta http-equiv="Content-Security-Policy">`. */
export const CSP_META_STRING = buildCsp(CSP_CORE_DIRECTIVES);

/** CSP string for the real `Content-Security-Policy` HTTP header (`public/_headers`). */
export const CSP_HEADER_STRING = buildCsp({
  ...CSP_CORE_DIRECTIVES,
  ...CSP_HEADER_ONLY_DIRECTIVES,
});

/**
 * Parses a `directive value1 value2; directive2 value1` CSP string back into
 * a `{ directive: values[] }` map. Used by drift tests to compare the CSP
 * embedded in `index.html` / `public/_headers` against the constants above
 * without caring about directive order or incidental whitespace.
 */
export function parseCsp(csp: string): Record<string, string[]> {
  return Object.fromEntries(
    csp
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const [directive, ...values] = part.split(/\s+/);
        return [directive, values];
      }),
  );
}
