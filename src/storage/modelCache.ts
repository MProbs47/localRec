/**
 * U11 (R17/R19/R20, KTD5/KTD8): the substantial, testable core behind the
 * guided first run — OPFS presence/completeness, the pre-download
 * space/persist gate, resumable (HTTP-Range) download into OPFS, delete,
 * and the pure inactivity-unload decision. No React/DOM-UI here (per plan)
 * — `FirstRun.tsx`/`StorageManager.tsx` consume this module.
 *
 * **Model-set-agnostic core (not hardcoded to one model).** Every function
 * here takes a `ModelSetSpec` (an `id` naming the model's own OPFS
 * subdirectory + a list of `{url, fileName}` shards) rather than baking in
 * one model's ID or file names. This is what lets a later, second model
 * set (U18's diarization models, KTD15) reuse this exact downloader/store
 * machinery in its own sibling OPFS directory without any change here — the
 * plan's "zweites Modell-Set später ohne Umbau" — without building any
 * second-set support now (YAGNI: `MODEL_CACHE_ROOT_DIR` below is the only
 * place that would need a peer, and it already takes `modelSetId` as a
 * parameter). The concrete Whisper file list/URL (`WHISPER_MODEL_SET`,
 * refactor plan 002 U2, near `buildHfResolveUrl` below) is wired for
 * Variante-A status/size display only — it is deliberately NOT hooked up to
 * a live OPFS download here (see that constant's own doc comment); the
 * earlier engine's file list was never wired into this module either.
 *
 * **OPFS store shape (mirrors `opfsAudio.ts`, KTD8: never mixed with the
 * session store).** `ModelOpfsStore` is the same "injectable handle, no
 * OPFS in Node" discipline as `opfsAudio.ts`'s `SyncAccessHandleLike`
 * (reused directly below, not re-derived — DRY) — but for a *directory* of
 * several named files instead of one single audio file, since a model set
 * is several `.onnx_data` shards. `openModelOpfsStore()` at the bottom is
 * the real-OPFS Andockpunkt (worker-only per the OPFS spec, not wired into
 * any worker yet — see this unit's report), exactly like
 * `opfsAudio.ts`'s `openOpfsAudioAppender()`.
 *
 * **Completeness via sentinel files, not a byte-size manifest.** A model
 * file is considered fully downloaded once a zero-byte `<fileName>.done`
 * sentinel exists next to it — written only after its download stream ends
 * normally (see `downloadOneFile`). This deliberately avoids needing to
 * know/hardcode each shard's true byte size anywhere in this module (no
 * `SyncAccessHandleLike.read()` is needed either — same append-only,
 * write-and-forget discipline as `opfsAudio.ts`, no read-back required to
 * decide completeness). A simulated eviction (AE3) — the data file, the
 * sentinel, or both vanishing — is then indistinguishable from "never
 * downloaded": `isModelSetComplete()` honestly reports incomplete and the
 * normal download path resumes/restarts, no special-cased error branch.
 *
 * **Resume offset comes from OPFS, not from any caller-supplied state.**
 * `downloadOneFile` reads the *existing* file's `getSize()` as the resume
 * offset and sends `Range: bytes=<offset>-` whenever that offset is `> 0`
 * — the same "seed position from `handle.getSize()`" discipline as
 * `opfsAudio.ts`'s `OpfsAudioAppender` constructor. A file that already has
 * its `.done` sentinel is skipped entirely (still contributing full credit
 * to the progress aggregation, see below) rather than re-requested — this
 * is what makes resume work *across* files in a multi-file set, not just
 * within one partially-written file.
 *
 * **Progress via `progress.ts` (DRY, the anticipated second caller).**
 * `downloadModelSet()` feeds one `createProgressAggregator` instance (fed
 * `{status:'progress', file, loaded, total}` per received chunk) across all
 * of a set's files — exactly the module `progress.ts`'s header comment
 * predicted U11 would need. Inherited constraint from that module: only
 * events whose `file` ends in `.onnx_data` move the aggregate fraction — in
 * production this holds automatically (q4f16 shards really are named
 * `*.onnx_data`), so `ModelFileSpec.fileName`
 * for real model sets should keep that suffix.
 *
 * ---
 *
 * **Research finding — transformers.js × OPFS (this unit's required
 * check).** `@huggingface/transformers` 4.2.0's `env` (see
 * `node_modules/@huggingface/transformers/types/env.d.ts`) exposes exactly
 * the hook this integration needs: `env.useCustomCache: boolean` +
 * `env.customCache: CacheInterface | null`, where `CacheInterface` (see
 * `types/utils/cache.d.ts`) is a narrow, Web-Cache-API-shaped contract —
 * `match(request: string): Promise<Response | FileResponse | undefined |
 * string>` and `put(request: string, response: Response,
 * progress_callback?) : Promise<void>` (plus an optional `delete`). Setting
 * `env.useCustomCache = true` and `env.customCache` to an object
 * implementing that contract makes the model's `from_pretrained()` ask
 * that cache for every
 * shard *before* falling back to its own network fetch — this is
 * transformers.js' documented general-purpose caching hook, not something
 * specific to Node's `FileCache` (`utils/cache/FileCache.d.ts`), which is
 * just the one built-in implementation of the same `CacheInterface` for a
 * Node filesystem path, included here as a second confirming reference for
 * the contract shape.
 *
 * **Why this module does not implement that adapter.** Wiring an
 * OPFS-backed `CacheInterface` (`match()` reading the bytes this module
 * writes and constructing a `Response` from them; `put()`/`delete()`
 * mirroring `downloadModelSet()`/`deleteModelSet()`) is real, buildable
 * work — but verifying it actually short-circuits `from_pretrained()`'s
 * network fetch requires a real browser's OPFS + Cache-API-shaped `Response`
 * plumbing, which does not exist in Node/Vitest (this repo's stated
 * "Realitäts-Grenze"). Building it untested here would be exactly the kind
 * of code the plan warns against: real-looking but never actually exercised.
 * Per this unit's explicit instructions, that connection is left as a
 * **documented manual milestone**: wire `env.useCustomCache`/`env.customCache`
 * (pointed at this module's `ModelOpfsStore`) into the engine's `load`
 * — or, more likely, into the worker bootstrap that constructs the engine —
 * once `ensureModelSetReady()` below confirms OPFS completeness, and verify
 * by hand (DevTools network tab shows no request on a warm reload) on
 * target hardware. `ensureModelSetReady()` therefore deliberately calls only
 * `engine.warmup()`, never `engine.load()` — see its own doc comment.
 */
import type { SyncAccessHandleLike } from './opfsAudio';
import { createProgressAggregator, type ModelFileProgressEvent } from '../worker/model/progress';

// --- Model set description --------------------------------------------

export interface ModelFileSpec {
  /** Fully-resolved remote URL for this shard (see `buildHfResolveUrl`). */
  url: string;
  /**
   * File name inside this model set's own OPFS subdirectory. Should end in
   * `.onnx_data` for real model sets so `progress.ts`'s aggregation picks
   * it up (see file header).
   */
  fileName: string;
}

export interface ModelSetSpec {
  /** Names this model set's own OPFS subdirectory (KTD8/KTD15: never shared with another model set or the session store). */
  id: string;
  files: ModelFileSpec[];
}

/** `https://huggingface.co/<repoId>/resolve/main/<fileName>` — the stable HF Hub direct-download URL shape. Pure string building, no network; `WHISPER_MODEL_SET` below is the concrete repo ID/file list wiring (refactor plan 002 U2). */
export function buildHfResolveUrl(repoId: string, fileName: string): string {
  return `https://huggingface.co/${repoId}/resolve/main/${fileName}`;
}

// --- Concrete model set: Whisper (refactor plan 002 U1/U2) ----------------
//
// `WhisperEngine` (`../worker/model/whisperEngine.ts`) is the engine that
// actually loads this model via transformers.js' own browser cache +
// `progress_callback` — Variante A (KTD-W6), same acquisition strategy as
// the streaming engine before it. This descriptor is NOT wired to a live
// OPFS download here: `ensureModelSetReady`/`downloadModelSet` above stay
// generic and unused for Whisper acquisition; the OPFS path remains
// deferred dead-code (see this module's header). `WHISPER_MODEL_SET` and
// `WHISPER_REQUIRED_BYTES` exist purely for Variante-A status/size display
// (`FirstRun.tsx`/`App.tsx` "~1.5 GB" copy, `getModelSetSizeBytes`-shaped
// readouts) so that surface has one real descriptor to point at instead of
// a hardcoded number.
//
// The two weight files transformers.js actually downloads for the shipped
// set (fp16 encoder + q4f16 decoder — U8's CH-de decision, see
// `DTYPE_CONFIG` in whisperEngine.ts), verified against the
// onnx-community/whisper-large-v3-turbo repo file listing. Both are plain
// `.onnx` files (the fp16 encoder graph is a single file, well under the
// 2 GiB protobuf limit — no `.onnx_data` companion), which is why
// `whisperEngine.ts`'s `load()` passes a `.onnx` matcher to
// `createProgressAggregator` and `WHISPER_MODEL_FILE_COUNT` is 2.
export const WHISPER_MODEL_SET: ModelSetSpec = {
  id: 'whisper-large-v3-turbo',
  files: [
    {
      url: buildHfResolveUrl('onnx-community/whisper-large-v3-turbo', 'onnx/encoder_model_fp16.onnx'),
      fileName: 'encoder_model_fp16.onnx',
    },
    {
      url: buildHfResolveUrl('onnx-community/whisper-large-v3-turbo', 'onnx/decoder_model_merged_q4f16.onnx'),
      fileName: 'decoder_model_merged_q4f16.onnx',
    },
  ],
};

/**
 * ~1.5 GB — the shipped fp16-encoder + q4f16-decoder Whisper set's total
 * download size, for the storage gate (`requiredBytes`) and status copy.
 * Measured on-device (DevTools `caches.open('transformers-cache')`, U8):
 * `encoder_model_fp16.onnx` 1274 MB + `decoder_model_merged_q4f16.onnx` 194 MB
 * + tokenizer/configs ≈ 1.47 GB. The fp16 encoder is ~900 MB larger than the
 * q4f16 one U8 rejected. Rounded up to 1.5 GiB here to leave the free-space
 * gate a little headroom over the exact figure.
 */
export const WHISPER_REQUIRED_BYTES = 1536 * 1024 * 1024;

// --- Concrete model set: Diarization (plan 003 U18/U21, KTD15) -----------
//
// The plan's "zweites Modell-Set später ohne Umbau" arriving: same posture as
// `WHISPER_MODEL_SET` just above — a real descriptor for Variante-A
// status/size display only, deliberately NOT wired to a live OPFS download
// here (the diarization worker, `diarization.worker.ts`, loads these two
// models itself via transformers.js'/onnxruntime-web's own fetch+cache, same
// acquisition strategy as Whisper). Lives in its own OPFS subdirectory
// (`id` below) — never shared with `WHISPER_MODEL_SET`'s, per
// `MODEL_CACHE_ROOT_DIR`'s "sibling directories per set" contract.
//
// The two repo IDs are the exact same strings `diarization/segmentation.ts`'s
// `PYANNOTE_SEGMENTATION_MODEL_ID` and `diarization/embedding.ts`'s
// `WESPEAKER_MODEL_ID` already reference — inlined here rather than imported
// (this module stays dependency-clean of `src/diarization`, the same
// layering `WHISPER_MODEL_SET` keeps from `src/worker/model/whisperEngine.ts`).
export const DIARIZATION_MODEL_SET: ModelSetSpec = {
  id: 'diarization-pyannote-wespeaker',
  files: [
    {
      url: buildHfResolveUrl('onnx-community/pyannote-segmentation-3.0', 'onnx/model.onnx'),
      fileName: 'pyannote-segmentation.onnx',
    },
    {
      url: buildHfResolveUrl('onnx-community/wespeaker-voxceleb-resnet34-LM', 'onnx/model.onnx'),
      fileName: 'wespeaker-resnet34.onnx',
    },
  ],
};

/**
 * ~40 MB — an approximate total for the two diarization models' onnx graphs,
 * for the storage gate (`requiredBytes`) and status copy only (same role as
 * `WHISPER_REQUIRED_BYTES`, not a measured on-device figure here).
 * pyannote-segmentation-3.0's `onnx/model.onnx` is ≈ 6 MB;
 * wespeaker-voxceleb-resnet34-LM's `onnx/model.onnx` is ≈ 26 MB — ≈ 32 MB
 * combined, rounded up to leave the free-space gate some headroom.
 */
export const DIARIZATION_REQUIRED_BYTES = 40 * 1024 * 1024;

function sentinelName(fileName: string): string {
  return `${fileName}.done`;
}

// --- Injectable OPFS store (mirrors opfsAudio.ts's handle pattern) -----

export interface ModelOpfsStore {
  /** Cheap existence check — does not open a sync access handle. */
  exists(fileName: string): Promise<boolean>;
  /** Opens (creating if missing) `fileName`'s sync access handle — same contract as `opfsAudio.ts`'s `SyncAccessHandleLike` (imported, not redeclared). */
  openFile(fileName: string): Promise<SyncAccessHandleLike>;
  /** Deletes `fileName` if present; no-op if absent. */
  deleteFile(fileName: string): Promise<void>;
}

// --- Injectable fetch (a real `fetch` satisfies this structurally) -----

export interface ReadableStreamReaderLike {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
}

export interface ReadableStreamLike {
  getReader(): ReadableStreamReaderLike;
}

export interface FetchResponseLike {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  body: ReadableStreamLike | null;
}

export type FetchLike = (url: string, init?: { headers?: Record<string, string> }) => Promise<FetchResponseLike>;

// --- Presence / completeness (AE3) --------------------------------------

/** True only if every file in `spec` has its completion sentinel present (see file header — "Completeness via sentinel files"). A missing/evicted OPFS area reports `false` here, never throws. */
export async function isModelSetComplete(store: ModelOpfsStore, spec: ModelSetSpec): Promise<boolean> {
  for (const file of spec.files) {
    if (!(await store.exists(sentinelName(file.fileName)))) return false;
  }
  return true;
}

// --- Resumable download (R17) -------------------------------------------

export interface DownloadModelSetOptions {
  onProgress?: (fraction: number) => void;
}

/**
 * Downloads every not-yet-complete file in `spec` into `store`, resuming
 * each from its current OPFS byte size via `Range: bytes=<offset>-`
 * whenever that offset is nonzero. Already-`.done` files are skipped (but
 * still contribute full credit to the aggregated progress, see below) —
 * this is what makes resume work across files, not just within one.
 */
export async function downloadModelSet(
  store: ModelOpfsStore,
  spec: ModelSetSpec,
  fetchImpl: FetchLike,
  options: DownloadModelSetOptions = {},
): Promise<void> {
  const reportProgress = createProgressAggregator(spec.files.length, (fraction) => options.onProgress?.(fraction));
  for (const file of spec.files) {
    await downloadOneFile(store, file, fetchImpl, reportProgress);
  }
}

async function downloadOneFile(
  store: ModelOpfsStore,
  file: ModelFileSpec,
  fetchImpl: FetchLike,
  reportProgress: (event: ModelFileProgressEvent) => void,
): Promise<void> {
  if (await store.exists(sentinelName(file.fileName))) {
    // Already fully downloaded (a previous run, or another file in this
    // same call already finished it) — give it full credit in the
    // aggregate so a set that's "2 of 3 files already done" doesn't read
    // as permanently stuck below 100% once the last file finishes (see
    // `progress.ts`: a file that never reports an event contributes 0, not
    // 1, to the sum).
    reportProgress({ status: 'progress', file: file.fileName, loaded: 1, total: 1 });
    return;
  }

  const handle = await store.openFile(file.fileName);
  const offset = handle.getSize();
  const headers: Record<string, string> = offset > 0 ? { Range: `bytes=${offset}-` } : {};

  const response = await fetchImpl(file.url, { headers });
  if (!response.ok) {
    handle.close();
    throw new Error(`modelCache: download failed for ${file.fileName} (HTTP ${response.status})`);
  }
  if (!response.body) {
    handle.close();
    throw new Error(`modelCache: response for ${file.fileName} has no body`);
  }

  const remainingBytes = Number(response.headers.get('content-length') ?? 0);
  const total = offset + remainingBytes;
  const reader = response.body.getReader();
  let loaded = offset;

  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0) {
        const written = handle.write(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer, {
          at: loaded,
        });
        loaded += written;
        if (total > 0) reportProgress({ status: 'progress', file: file.fileName, loaded, total });
      }
    }
  } finally {
    // Flush/close whatever made it to disk even on a mid-stream failure —
    // the thrown error below (if any) still propagates, leaving the
    // partially-written, sentinel-less file for the next call to resume
    // from via the `Range` offset above (R17's abort-at-60%-then-resume
    // scenario).
    handle.flush();
    handle.close();
  }

  const sentinel = await store.openFile(sentinelName(file.fileName));
  sentinel.close();
}

// --- Status readout (StorageManager: "Modell-Status/-Grösse") -------------

/** Sums the current OPFS byte size of every file in `spec` (files that don't exist yet contribute 0) — a status display's "X of ~1.5 GB downloaded" reading (`WHISPER_MODEL_SET`/`WHISPER_REQUIRED_BYTES` above). Not used by any of the download/delete/readiness logic above; purely informational. */
export async function getModelSetSizeBytes(store: ModelOpfsStore, spec: ModelSetSpec): Promise<number> {
  let total = 0;
  for (const file of spec.files) {
    if (await store.exists(file.fileName)) {
      const handle = await store.openFile(file.fileName);
      total += handle.getSize();
      handle.close();
    }
  }
  return total;
}

// --- Delete (R19) ---------------------------------------------------------

/** Removes every file (and its sentinel) in `spec` from `store`, freeing the space. The next `isModelSetComplete()`/`ensureModelSetReady()` honestly reports "not ready" and offers the download again. */
export async function deleteModelSet(store: ModelOpfsStore, spec: ModelSetSpec): Promise<void> {
  for (const file of spec.files) {
    await store.deleteFile(file.fileName);
    await store.deleteFile(sentinelName(file.fileName));
  }
}

// --- Pre-download gate: space + persist (R19/R20) -------------------------

export interface StorageEstimateLike {
  usage?: number;
  quota?: number;
}

export interface StorageGate {
  estimate(): Promise<StorageEstimateLike>;
  persist(): Promise<boolean>;
}

export interface StorageGateResult {
  hasEnoughSpace: boolean;
  persisted: boolean;
  usageBytes: number | null;
  quotaBytes: number | null;
}

/**
 * Checks free space against `requiredBytes` and requests persistent storage
 * (eviction protection, KTD5) — both before any bytes are downloaded. When
 * `estimate()` can't report usage/quota (older/partial browser support),
 * space is treated as unknown and NOT blocking (`hasEnoughSpace: true`) —
 * this gate exists to catch the common case, not to require universal API
 * support before ever attempting a download.
 */
export async function checkStorageGate(gate: StorageGate, requiredBytes: number): Promise<StorageGateResult> {
  const estimate = await gate.estimate();
  const usageBytes = estimate.usage ?? null;
  const quotaBytes = estimate.quota ?? null;
  const availableBytes = usageBytes !== null && quotaBytes !== null ? quotaBytes - usageBytes : null;
  const hasEnoughSpace = availableBytes === null ? true : availableBytes >= requiredBytes;
  const persisted = await gate.persist();
  return { hasEnoughSpace, persisted, usageBytes, quotaBytes };
}

export class InsufficientStorageError extends Error {
  readonly gate: StorageGateResult;
  readonly requiredBytes: number;

  constructor(gate: StorageGateResult, requiredBytes: number) {
    super(`modelCache: not enough free storage for ~${requiredBytes} bytes (gate: ${JSON.stringify(gate)})`);
    this.name = 'InsufficientStorageError';
    this.gate = gate;
    this.requiredBytes = requiredBytes;
  }
}

// --- Orchestration: ensure ready, delegating warm-up (R20) ----------------

export interface ModelReadinessDeps {
  store: ModelOpfsStore;
  fetchImpl: FetchLike;
  storageGate: StorageGate;
  /** Minimum free bytes required before starting a fresh download. The real figure is U13's wiring concern, not this generic module's — callers supply it explicitly rather than this module guessing/hardcoding one model's size. */
  requiredBytes: number;
  /**
   * Only the one `ModelEngine` (U2) method this module actually calls
   * (KTD1 discipline: no more of that interface than a real caller needs).
   * `load()` is deliberately NOT part of this — and NOT called by
   * `ensureModelSetReady` — because a real `load()` call today would
   * trigger transformers.js' own (non-resumable) network fetch, exactly
   * duplicating the download this module already did into OPFS. Wiring
   * `load()` to actually read from OPFS (via `env.customCache`, see file
   * header) is the documented manual milestone; until that wiring exists,
   * the caller is responsible for getting `engine` into a loaded state by
   * whatever means before calling this function — `warmup()` is the only
   * step that is safe/meaningful to delegate to unconditionally here.
   */
  engine: { warmup(): Promise<void> };
  onProgress?: (fraction: number) => void;
}

export type ModelReadinessResult =
  | { status: 'ready' }
  | { status: 'downloaded'; storageGate: StorageGateResult };

/**
 * The guided-first-run orchestration (F1/R20): OPFS presence check → (if
 * incomplete) space/persist gate → resumable download → in both cases,
 * `engine.warmup()` so the model is actually usable this session (a fresh
 * page load/worker always starts with an empty in-memory engine regardless
 * of what's already sitting in OPFS — this is also why RAM-reload after
 * `maybeUnloadForInactivity()` below calls this same function again).
 * Throws `InsufficientStorageError` rather than attempting a download
 * likely doomed to fail partway through a quota error.
 */
export async function ensureModelSetReady(
  spec: ModelSetSpec,
  deps: ModelReadinessDeps,
): Promise<ModelReadinessResult> {
  const alreadyComplete = await isModelSetComplete(deps.store, spec);

  let result: ModelReadinessResult;
  if (alreadyComplete) {
    result = { status: 'ready' };
  } else {
    const gate = await checkStorageGate(deps.storageGate, deps.requiredBytes);
    if (!gate.hasEnoughSpace) {
      throw new InsufficientStorageError(gate, deps.requiredBytes);
    }
    await downloadModelSet(deps.store, spec, deps.fetchImpl, { onProgress: deps.onProgress });
    result = { status: 'downloaded', storageGate: gate };
  }

  await deps.engine.warmup();
  return result;
}

// --- RAM-unload after inactivity (R19) -------------------------------------

/** Generous, uncalibrated default (plan's "Offene Punkte" flags idle-timing knobs as execution-time calibration) — 15 minutes of no recorded activity before the model is considered eligible for RAM unload. */
export const DEFAULT_INACTIVITY_UNLOAD_MS = 15 * 60 * 1000;

/**
 * Pure inactivity clock — no real timer anywhere in this class. A caller
 * (a real `setInterval` in a worker, or a test driving `now` directly)
 * decides *when* to ask `shouldUnload()`; this class only tracks *whether*
 * enough idle time has passed at that moment.
 */
export class ModelActivityTracker {
  #lastActiveAt: number;
  readonly #inactivityMs: number;

  constructor(now: number, inactivityMs: number = DEFAULT_INACTIVITY_UNLOAD_MS) {
    this.#lastActiveAt = now;
    this.#inactivityMs = inactivityMs;
  }

  /** Call whenever the model is actually used (e.g. a transcription session starts/feeds) — resets the idle clock. */
  recordActivity(now: number): void {
    this.#lastActiveAt = now;
  }

  /** Pure decision, no side effect: has `inactivityMs` elapsed since the last recorded activity, as of `now`? */
  shouldUnload(now: number): boolean {
    return now - this.#lastActiveAt >= this.#inactivityMs;
  }
}

/**
 * Unloads `engine` from RAM if `tracker` says `now` is past the inactivity
 * threshold; a no-op (returns `false`) otherwise. OPFS bytes are never
 * touched here — `engine.dispose()` only releases in-memory/GPU state
 * (`ModelEngine.dispose()`'s documented contract, U2). Reloading afterwards
 * is exactly `ensureModelSetReady()` again: `isModelSetComplete()` still
 * reports `true` (nothing here deleted anything), so it calls no
 * `fetchImpl` at all and goes straight to `engine.warmup()` — "Neuladen =
 * Kopieren aus OPFS, kein erneuter Netz-Download".
 */
export function maybeUnloadForInactivity(
  tracker: ModelActivityTracker,
  now: number,
  engine: { dispose(): void },
): boolean {
  if (!tracker.shouldUnload(now)) return false;
  engine.dispose();
  return true;
}

// --- Real-OPFS / real-storage Andockpunkte (manual milestone) -------------
//
// Mirrors opfsAudio.ts's bottom section: narrow structural interfaces
// reached through `globalThis`, not the ambient DOM identifiers this
// repo's tests don't universally have available. Real OPFS directories and
// `navigator.storage.estimate/persist` don't exist in Node/Vitest —
// exercising these for real is this unit's declared manual milestone, same
// as opfsAudio.ts's `openOpfsAudioAppender()`. Worker-only at runtime (OPFS
// spec) — not wired into any worker yet (U11 deliberately stops at the
// Andockpunkt; see this unit's report for what's left).

interface OpfsFileHandleLike {
  createSyncAccessHandle(): Promise<SyncAccessHandleLike>;
}

interface OpfsDirectoryLike {
  getFileHandle(name: string, options?: { create?: boolean }): Promise<OpfsFileHandleLike>;
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<OpfsDirectoryLike>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
}

interface StorageManagerLike {
  getDirectory(): Promise<OpfsDirectoryLike>;
  estimate?(): Promise<StorageEstimateLike>;
  persist?(): Promise<boolean>;
}

function getNavigatorStorage(): StorageManagerLike {
  return (globalThis as unknown as { navigator: { storage: StorageManagerLike } }).navigator.storage;
}

/** Every model set's OPFS files live under `models/<setId>/` — sibling directories per set (KTD15's "second set later"), never at the OPFS root `opfsAudio.ts` uses for session audio, and never inside `sessionStore.ts`'s IndexedDB (KTD8). */
const MODEL_CACHE_ROOT_DIR = 'models';

async function tryGetFileHandle(dir: OpfsDirectoryLike, name: string): Promise<OpfsFileHandleLike | null> {
  try {
    return await dir.getFileHandle(name, { create: false });
  } catch {
    return null; // real OPFS throws NotFoundError when create:false and missing
  }
}

/** Opens (creating the directory chain if needed) the real `ModelOpfsStore` for `modelSetId`, backed by an actual OPFS subdirectory. */
export async function openModelOpfsStore(modelSetId: string): Promise<ModelOpfsStore> {
  const root = await getNavigatorStorage().getDirectory();
  const modelsDir = await root.getDirectoryHandle(MODEL_CACHE_ROOT_DIR, { create: true });
  const dir = await modelsDir.getDirectoryHandle(modelSetId, { create: true });

  return {
    async exists(fileName) {
      return (await tryGetFileHandle(dir, fileName)) !== null;
    },
    async openFile(fileName) {
      const fileHandle = await dir.getFileHandle(fileName, { create: true });
      return fileHandle.createSyncAccessHandle();
    },
    async deleteFile(fileName) {
      try {
        await dir.removeEntry(fileName);
      } catch {
        // already absent — deleteFile is documented as a no-op in that case
      }
    },
  };
}

/** Real `navigator.storage` satisfies `StorageGate` structurally once wrapped for browsers that lack `estimate`/`persist` entirely (treated as "unknown"/"denied", not a throw). */
export function getNavigatorStorageGate(): StorageGate {
  const storage = getNavigatorStorage();
  return {
    estimate: () => storage.estimate?.() ?? Promise.resolve({}),
    persist: () => storage.persist?.() ?? Promise.resolve(false),
  };
}
