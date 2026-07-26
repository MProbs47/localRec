/**
 * Append-only IndexedDB persistence for the two record kinds U6 needs to
 * survive a crash (R8, R16, KTD6): a `SessionRecord` marker per recording
 * session, and one `SegmentRecord` per finalized transcript segment
 * (`TranscriptChannel`'s `final` messages, U4/U5 — see `transcriptChannel.ts`
 * and `transcription.worker.ts`'s U5 header comment for where these come
 * from). OPFS audio persistence is a separate concern (`opfsAudio.ts`,
 * KTD8's "session store separate from model cache" — and separate from each
 * other for the same reason: losing one must not corrupt the other).
 *
 * **Dedup is a storage-layer invariant, not caller discipline (R16).** The
 * `segments` object store's primary key is the *compound* key
 * `[sessionId, seq]` (IndexedDB natively supports array `keyPath`s). Every
 * write is a `put()` (upsert) on that key, so re-appending the same
 * `(sessionId, seq)` — e.g. a resumed worker re-sending a segment it isn't
 * sure was persisted before a crash — silently overwrites in place instead
 * of creating a duplicate row. This is what makes `recovery.ts`'s "resume is
 * idempotent" invariant hold without recovery.ts having to de-duplicate
 * anything itself. `seq` assignment itself (a per-session monotone counter)
 * is the caller's responsibility — not built here (YAGNI): this unit leaves
 * that counter as `transcription.worker.ts`'s future wiring job (see that
 * file's header for the currently-commented Andockpunkt), since nothing in
 * this repo yet finalizes real segments outside tests.
 *
 * **Batch policy (one transaction per batch, not per segment).** Finalized
 * segments accumulate in memory and flush to a single IndexedDB
 * read-write transaction (touching both stores) once ANY of three
 * thresholds is hit: `maxBatchSegments` (20) finalized utterances,
 * `maxBatchBytes` (8 KiB of accumulated text — `text.length` as a cheap
 * UTF-16-code-unit proxy for size, not exact UTF-8 bytes; precision beyond
 * "roughly a few KB" buys nothing here) queued, or `maxBatchIntervalMs`
 * (5 s) since the oldest still-pending segment — the last one bounds how
 * long a slow-talking session's single trickle of segments can sit
 * unflushed (crash-safety), while the first two bound transaction count
 * during a fast run of short utterances (plan test scenario 5: 100 segments
 * -> a handful of transactions, not 100). All three are lean, generous
 * defaults, not load-bearing precision — nothing about them is tuned yet.
 * `flush()` is also where `heartbeatAt` gets updated (to the batch's `now`)
 * and `lastSegmentSeq` advances (to the batch's max `seq` per session) — see
 * `heartbeat()` for the explicit call the plan's periodic-during-silence
 * case needs (a flush-worthy event doubles as "the session is alive",
 * avoiding a second independent timer/abstraction for the same signal —
 * KTD6's "heartbeatAt ... periodisch aktualisiert").
 *
 * **Realitätsgrenze:** IndexedDB doesn't exist in Node/Vitest.
 * `sessionStore.test.ts` uses `fake-indexeddb/auto` (the standard shim,
 * spec-compliant including compound keys) so this file's actual batch
 * rhythm, dedup, and query logic run for real against a real IndexedDB
 * implementation in tests — nothing here is mocked away. Ambient DOM
 * `IDBDatabase`/`IDBRequest`/... types are unavailable under
 * `tsconfig.node.json` (no `"DOM"` lib, see `recorder.ts`'s header for why
 * this file — imported by its own `.test.ts` — hits the same constraint);
 * the narrow `IDB*Like` interfaces below cover exactly the surface used,
 * satisfied structurally by both the real browser IndexedDB and
 * fake-indexeddb without either being spelled out as a type here.
 */

export interface SessionRecord {
  id: string;
  status: 'active' | 'closed';
  /** Last time this session's storage was known-durably-written to (see `flush()`/`heartbeat()`) — the crash-freshness signal, not a liveness ping. */
  heartbeatAt: number;
  /** Highest `seq` durably flushed for this session so far; `-1` means none yet. */
  lastSegmentSeq: number;
  createdAt: number;
}

export interface SegmentRecord {
  sessionId: string;
  /** Monotone per-session sequence number, assigned by the caller (deterministic, not random — the dedup key together with `sessionId`). */
  seq: number;
  text: string;
  startMs: number;
  endMs: number;
}

/** Accumulate up to this many finalized segments before a batch flush. */
export const DEFAULT_MAX_BATCH_SEGMENTS = 20;
/** Accumulate up to this many `text.length` code units (a cheap size proxy, see file header) before a batch flush. */
export const DEFAULT_MAX_BATCH_BYTES = 8 * 1024;
/** Force a batch flush once the oldest pending segment has waited this long, even if the other thresholds aren't hit. */
export const DEFAULT_MAX_BATCH_INTERVAL_MS = 5000;

const DB_VERSION = 1;
const SESSIONS_STORE = 'sessions';
const SEGMENTS_STORE = 'segments';

// --- Narrow structural IndexedDB surface (see file header) ---------------

interface IDBRequestLike<T> {
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
  readonly result: T;
  readonly error: unknown;
}

interface IDBIndexNamesLike {
  contains(name: string): boolean;
}

interface IDBObjectStoreLike {
  put(value: unknown): IDBRequestLike<unknown>;
  get(key: unknown): IDBRequestLike<unknown>;
  getAll(query?: unknown): IDBRequestLike<unknown[]>;
  /** Empties the whole store — the S2 (privacy hardening, F2) wipe's only use of this surface. */
  clear(): IDBRequestLike<undefined>;
}

interface IDBTransactionLike {
  objectStore(name: string): IDBObjectStoreLike;
  oncomplete: (() => void) | null;
  onerror: (() => void) | null;
  readonly error: unknown;
}

interface IDBDatabaseLike {
  transaction(storeNames: string[], mode: 'readonly' | 'readwrite'): IDBTransactionLike;
  createObjectStore(name: string, options: { keyPath: string | string[] }): IDBObjectStoreLike;
  readonly objectStoreNames: IDBIndexNamesLike;
}

interface IDBOpenRequestLike extends IDBRequestLike<IDBDatabaseLike> {
  onupgradeneeded: (() => void) | null;
}

interface IDBFactoryLike {
  open(name: string, version: number): IDBOpenRequestLike;
}

interface IDBKeyRangeStaticLike {
  bound(lower: unknown, upper: unknown): unknown;
}

function getIndexedDB(): IDBFactoryLike {
  return (globalThis as unknown as { indexedDB: IDBFactoryLike }).indexedDB;
}

function getIDBKeyRange(): IDBKeyRangeStaticLike {
  return (globalThis as unknown as { IDBKeyRange: IDBKeyRangeStaticLike }).IDBKeyRange;
}

function promisifyRequest<T>(request: IDBRequestLike<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('sessionStore request failed'));
  });
}

export interface SessionStoreOptions {
  /** Database name — override per test for isolation; production callers should just use the default. */
  dbName?: string;
  maxBatchSegments?: number;
  maxBatchBytes?: number;
  maxBatchIntervalMs?: number;
  /** Called once per actual `IDBDatabase.transaction()` call — the injectable spy the plan's batch-rhythm test scenario (5) asserts against. */
  onTransaction?: () => void;
}

/** Default production database name. Tests should override via `SessionStoreOptions.dbName` to avoid cross-test state (fake-indexeddb's registry is shared per process). */
export const DEFAULT_DB_NAME = 'meeting-recorder-sessions';

export class SessionStore {
  readonly #dbName: string;
  readonly #maxBatchSegments: number;
  readonly #maxBatchBytes: number;
  readonly #maxBatchIntervalMs: number;
  readonly #onTransaction: (() => void) | undefined;

  #dbPromise: Promise<IDBDatabaseLike> | null = null;
  #pendingSegments: SegmentRecord[] = [];
  #pendingBytes = 0;
  #oldestPendingAt: number | null = null;

  constructor(options: SessionStoreOptions = {}) {
    this.#dbName = options.dbName ?? DEFAULT_DB_NAME;
    this.#maxBatchSegments = options.maxBatchSegments ?? DEFAULT_MAX_BATCH_SEGMENTS;
    this.#maxBatchBytes = options.maxBatchBytes ?? DEFAULT_MAX_BATCH_BYTES;
    this.#maxBatchIntervalMs = options.maxBatchIntervalMs ?? DEFAULT_MAX_BATCH_INTERVAL_MS;
    this.#onTransaction = options.onTransaction;
  }

  #open(): Promise<IDBDatabaseLike> {
    if (!this.#dbPromise) {
      this.#dbPromise = new Promise((resolve, reject) => {
        const request = getIndexedDB().open(this.#dbName, DB_VERSION);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(SESSIONS_STORE)) {
            db.createObjectStore(SESSIONS_STORE, { keyPath: 'id' });
          }
          if (!db.objectStoreNames.contains(SEGMENTS_STORE)) {
            // Compound primary key — the dedup mechanism, see file header.
            db.createObjectStore(SEGMENTS_STORE, { keyPath: ['sessionId', 'seq'] });
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('sessionStore open failed'));
      });
    }
    return this.#dbPromise;
  }

  /** Creates a new session record with `status: 'active'` — the crash-candidate state until a matching `closeSession()`. */
  async createSession(id: string, now: number): Promise<void> {
    await this.#putSession({ id, status: 'active', heartbeatAt: now, lastSegmentSeq: -1, createdAt: now });
  }

  /** Clean stop: marks the session `status: 'closed'` so the next start's crash-candidate scan (`recovery.ts`) skips it. No-op if the session doesn't exist. */
  async closeSession(id: string, now: number): Promise<void> {
    const existing = await this.getSession(id);
    if (!existing) return;
    await this.#putSession({ ...existing, status: 'closed', heartbeatAt: now });
  }

  /**
   * Explicit liveness ping for stretches with no finalized segments to flush
   * (e.g. a long silence) — the plan's "heartbeatAt wird periodisch
   * aktualisiert" independent of the batch rhythm. No-op if the session
   * doesn't exist.
   */
  async heartbeat(id: string, now: number): Promise<void> {
    const existing = await this.getSession(id);
    if (!existing) return;
    await this.#putSession({ ...existing, heartbeatAt: now });
  }

  async getSession(id: string): Promise<SessionRecord | undefined> {
    const db = await this.#open();
    this.#onTransaction?.();
    const tx = db.transaction([SESSIONS_STORE], 'readonly');
    const request = tx.objectStore(SESSIONS_STORE).get(id) as IDBRequestLike<SessionRecord | undefined>;
    return promisifyRequest(request);
  }

  /** All sessions with `status: 'active'` — the crash-candidate set `recovery.ts` scans on startup (AE2). */
  async listActiveSessions(): Promise<SessionRecord[]> {
    const all = await this.#getAllSessions();
    return all.filter((session) => session.status === 'active');
  }

  /** All segments for one session, ascending by `seq` (the compound-key ordering already sorts this way). */
  async listSegments(sessionId: string): Promise<SegmentRecord[]> {
    const db = await this.#open();
    this.#onTransaction?.();
    const tx = db.transaction([SEGMENTS_STORE], 'readonly');
    const range = getIDBKeyRange().bound([sessionId, -Infinity], [sessionId, Infinity]);
    const request = tx.objectStore(SEGMENTS_STORE).getAll(range) as IDBRequestLike<SegmentRecord[]>;
    return promisifyRequest(request);
  }

  /**
   * Enqueues one finalized segment and flushes the pending batch once any
   * threshold is hit (see file header). `now` is the caller's clock reading
   * (no internal `Date.now()`, same discipline as `TranscriptChannel`) —
   * both for the "how long has the oldest pending item waited" threshold and
   * as the `heartbeatAt` value a resulting flush would write.
   */
  appendSegment(segment: SegmentRecord, now: number): Promise<void> {
    this.#pendingSegments.push(segment);
    this.#pendingBytes += segment.text.length;
    if (this.#oldestPendingAt === null) this.#oldestPendingAt = now;

    const dueByCount = this.#pendingSegments.length >= this.#maxBatchSegments;
    const dueByBytes = this.#pendingBytes >= this.#maxBatchBytes;
    const dueByAge = now - this.#oldestPendingAt >= this.#maxBatchIntervalMs;

    if (dueByCount || dueByBytes || dueByAge) {
      return this.flush(now);
    }
    return Promise.resolve();
  }

  /**
   * Force-flushes any pending segments in exactly one read-write transaction
   * spanning both stores: every pending segment is `put()` (upsert on the
   * compound key — never duplicates), and each touched session's
   * `lastSegmentSeq`/`heartbeatAt` advances accordingly. No-op if nothing is
   * pending. Safe to call speculatively (e.g. a periodic safety-net timer or
   * a clean-stop path that wants to guarantee no trailing segment is left
   * unflushed).
   */
  async flush(now: number): Promise<void> {
    if (this.#pendingSegments.length === 0) return;
    const batch = this.#pendingSegments;
    this.#pendingSegments = [];
    this.#pendingBytes = 0;
    this.#oldestPendingAt = null;

    try {
      const maxSeqBySession = new Map<string, number>();
      for (const segment of batch) {
        const current = maxSeqBySession.get(segment.sessionId);
        if (current === undefined || segment.seq > current) maxSeqBySession.set(segment.sessionId, segment.seq);
      }

      const db = await this.#open();
      this.#onTransaction?.(); // exactly once per batch, regardless of batch size — the test scenario 5 invariant

      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction([SEGMENTS_STORE, SESSIONS_STORE], 'readwrite');
        const segmentsStore = tx.objectStore(SEGMENTS_STORE);
        const sessionsStore = tx.objectStore(SESSIONS_STORE);

        for (const segment of batch) {
          segmentsStore.put(segment);
        }
        for (const [sessionId, maxSeq] of maxSeqBySession) {
          const getReq = sessionsStore.get(sessionId) as IDBRequestLike<SessionRecord | undefined>;
          getReq.onsuccess = () => {
            const existing = getReq.result;
            if (existing) {
              sessionsStore.put({
                ...existing,
                lastSegmentSeq: Math.max(existing.lastSegmentSeq, maxSeq),
                heartbeatAt: now,
              });
            }
          };
        }

        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error('sessionStore flush transaction failed'));
      });
    } catch (error) {
      // Durability (#5): the write failed (quota, eviction, closed db). The
      // batch was already spliced out of `#pendingSegments`; losing it here is
      // exactly the silent crash-recovery data loss the store exists to
      // prevent. Re-queue it AHEAD of anything appended during the await and
      // restore the batch counters, then surface the error so the caller keeps
      // the session `active` (a crash candidate) instead of marking it closed
      // with an unpersisted tail.
      this.#pendingSegments = batch.concat(this.#pendingSegments);
      this.#pendingBytes += batch.reduce((sum, s) => sum + s.text.length, 0);
      if (this.#oldestPendingAt === null) this.#oldestPendingAt = now;
      throw error;
    }
  }

  /**
   * S2 (privacy hardening, F2) — the in-app "Alle Aufnahmen löschen" wipe:
   * empties BOTH object stores in one transaction, and drops any not-yet-
   * flushed in-memory batch first. That ordering matters — without it, a
   * `flush()` racing (or arriving right after) this call would resurrect the
   * very segments the wipe just cleared, since `#pendingSegments` is
   * independent of what's durably stored. Mirrors `modelCache.ts`'s
   * `deleteModelSet` posture (unconditional delete, nothing to roll back).
   */
  async deleteAllSessions(): Promise<void> {
    this.#pendingSegments = [];
    this.#pendingBytes = 0;
    this.#oldestPendingAt = null;

    const db = await this.#open();
    this.#onTransaction?.();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([SESSIONS_STORE, SEGMENTS_STORE], 'readwrite');
      tx.objectStore(SESSIONS_STORE).clear();
      tx.objectStore(SEGMENTS_STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('sessionStore deleteAllSessions failed'));
    });
  }

  async #getAllSessions(): Promise<SessionRecord[]> {
    const db = await this.#open();
    this.#onTransaction?.();
    const tx = db.transaction([SESSIONS_STORE], 'readonly');
    const request = tx.objectStore(SESSIONS_STORE).getAll() as IDBRequestLike<SessionRecord[]>;
    return promisifyRequest(request);
  }

  async #putSession(record: SessionRecord): Promise<void> {
    const db = await this.#open();
    this.#onTransaction?.();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([SESSIONS_STORE], 'readwrite');
      tx.objectStore(SESSIONS_STORE).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('sessionStore write transaction failed'));
    });
  }
}
