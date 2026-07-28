# localRec — working direction

Local-first transcription PWA: speech is transcribed fully on-device (Whisper Large v3 Turbo, WebGPU), speakers are identified on-device (pyannote + WeSpeaker, WASM). Nothing leaves the device.

## Stance

- **YAGNI, DRY, lean.** One-man show, no monetisation pressure. No speculative features, no abstraction without a second caller. Goal: **simple, safe, stable** — make everyday work easier.
- Simple face, robust engine: the surface stays minimal (one button), complexity lives out of sight behind it.
- When in doubt: the smaller solution.

## Non-negotiable

- **Nothing leaves the device.** No cloud calls, no tracking, no analytics, no accounts. CSP `connect-src 'self'` (ideally `'none'` once the model is downloaded). Network only for the one-time model download.
- **The exported file at the chosen location is the truth**; browser storage is only a cache.

## Expensive pitfalls (don't reinvent these)

- **COOP `same-origin` + COEP `credentialless` are shipped on purpose** (KTD4, revised 2026-07-28). Without cross-origin isolation there is no `SharedArrayBuffer`, so the diarization worker's WASM runs single-threaded — measured cost: 58+ minutes of speaker detection for a 56-minute recording, against 9 minutes with threads. `require-corp` stays rejected: it would make the one-time Hugging Face download depend on third-party CORP header discipline, and it buys nothing over `credentialless` here.
- **The model never goes into the PWA precache** (~1.5 GB) — it is fetched at runtime into **Cache Storage** (not OPFS: `modelCache.ts`'s OPFS downloader exists but is wired to no live download). Whisper and pyannote live in transformers.js' `transformers-cache`, the WeSpeaker embedder in the app's own `ort-model-cache`. Anything that clears Cache Storage must spare those two by name (`appShellCache.ts`), or a click on «clear & reload» costs 1.5 GB and the airplane-mode guarantee.
- **Models handed to ONNX Runtime as a URL are never cached** — ORT fetches them itself, past transformers.js' caching layer. Pass bytes (`ortModelCache.ts`), not URLs.
- **Cache Storage is evictable.** `navigator.storage.persist()` is refused on this origin, so any model can disappear under storage pressure. Currently unhandled — offline this surfaces as a raw `Failed to fetch`.
- **Inference in a Web Worker**, never on the main thread; persistence **append-only** (crash safety).

## Measuring, not guessing

The performance and offline questions of this project can only be answered on the owner's machine (the container has no WebGPU and no network). Two rules learned the expensive way:

- Never order an implementation before the cause is proven.
- A measuring instrument with a blind spot proves nothing: "nothing was logged" only counts if the instrument demonstrably could have looked.

Real offline tests belong on `vite preview` with the network genuinely off — DevTools' «Offline» also cuts `localhost` and fakes failures that aren't there.

## Roles in `ce-work`

Sonnet 5 implements; Opus tests, reviews and decides architecture; **Opus gives the final sign-off** on every unit.

## Context

Plans, requirements, research and debug protocols live outside the repo (see `.gitignore`) — inside the repo, decisions document themselves through `CONTEXT.md`, `README.md` and the comments on the code itself.
