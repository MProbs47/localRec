/**
 * Finalized-transcript store, deliberately kept outside React's render path
 * (U8/R14: "Transkript-State ausserhalb des React-Render-Pfads"). A
 * `useSyncExternalStore`-shaped store (`subscribe`/`getSnapshot`) so
 * `LiveTranscript.tsx` can append tens of thousands of segments over a
 * long session without funnelling every one through a React state setter —
 * appending only notifies the (small number of) subscribed components,
 * which then re-render via the store's own snapshot rather than via
 * `setState`-driven prop drilling.
 *
 * Append-only (KTD6) and O(1) amortized per `append()`: the underlying
 * array is mutated in place with `push` rather than copied
 * (`[...segments, x]`), which matters at the 40k-segment scale this store
 * is sized for (R14) — an O(n) copy per append would make a long session
 * O(n^2). Existing segment objects are never reallocated or mutated after
 * being appended, so anything holding a reference to an older segment
 * (e.g. a `React.memo`-wrapped row keyed by `seq`) sees a stable identity
 * across later appends — the property `LiveTranscript.tsx`'s
 * memoization relies on to skip re-rendering rows unaffected by a new
 * segment arriving.
 */

/** One finalized transcript segment. Mirrors `TranscriptMessage`'s `final` variant (U4/`transcriptChannel.ts`), plus a store-assigned `seq`. */
export interface TranscriptSegment {
  /** Monotonically increasing, store-assigned identity — stable for the segment's lifetime (never reused/reassigned). */
  readonly seq: number;
  readonly text: string;
  readonly startMs: number;
  readonly endMs: number;
  /**
   * Reserved for Phase D (post-hoc diarization, U17/U18's alignment
   * output). Deliberately left unpopulated by this unit (YAGNI) — the
   * field exists now purely so the type doesn't need a breaking shape
   * change later.
   */
  readonly speaker?: string;
}

/** What a caller supplies to `append()` — everything but the store-assigned `seq`. */
export type NewTranscriptSegment = Omit<TranscriptSegment, 'seq'>;

/**
 * The `useSyncExternalStore` snapshot. A fresh object is handed out by
 * every `append()` (identity change = "the store changed" per the
 * `useSyncExternalStore` contract) while `segments` itself keeps its
 * identity across an append — only new elements are appended, so most of
 * the existing element identities are also stable across snapshots.
 */
export interface TranscriptStoreSnapshot {
  readonly segments: readonly TranscriptSegment[];
}

type Listener = () => void;

export class TranscriptStore {
  readonly #segments: TranscriptSegment[] = [];
  readonly #listeners = new Set<Listener>();
  #nextSeq = 0;
  #snapshot: TranscriptStoreSnapshot;

  constructor() {
    this.#snapshot = { segments: this.#segments };
  }

  /** Appends one finalized segment, assigning it the next `seq`, and notifies subscribers. Returns the stored segment (with its assigned `seq`). */
  append = (segment: NewTranscriptSegment): TranscriptSegment => {
    const withSeq: TranscriptSegment = { ...segment, seq: this.#nextSeq };
    this.#nextSeq += 1;
    this.#segments.push(withSeq);
    // A new wrapper object, not a copy of `#segments` — see the class
    // doc comment for why this stays O(1) at 40k+ segments.
    this.#snapshot = { segments: this.#segments };
    for (const listener of this.#listeners) listener();
    return withSeq;
  };

  /** `useSyncExternalStore`'s `subscribe` — registers `listener` to be called after every `append()`, returns an unsubscribe function. */
  subscribe = (listener: Listener): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /**
   * Empties the store for a fresh session — used before a new recording or an
   * import/meeting post-hoc transcription so its transcript never inherits a
   * previous session's segments. Clears the segments in place (array identity
   * kept), resets the `seq` counter, hands out a new snapshot object, and
   * notifies subscribers so any `LiveTranscript` re-renders empty.
   */
  reset = (): void => {
    this.#segments.length = 0;
    this.#nextSeq = 0;
    this.#snapshot = { segments: this.#segments };
    for (const listener of this.#listeners) listener();
  };

  /** `useSyncExternalStore`'s `getSnapshot` — same object reference between appends, a new one after. */
  getSnapshot = (): TranscriptStoreSnapshot => this.#snapshot;

  get size(): number {
    return this.#segments.length;
  }
}
