/**
 * Cosine-distance agglomerative clustering (average linkage) — the pure,
 * model-free core of U16 (SD-1, KTD13/KTD14). Groups per-segment speaker
 * embeddings into global speakers with no model, no worker, no GPU, so the
 * whole grouping behaviour is unit-testable with synthetic vectors
 * (`clustering.test.ts`).
 *
 * Two stopping modes (KTD14 "Auto-Zahl per Schwellwert ODER bekannte Zahl"):
 *  - `auto`: keep merging the two closest clusters until the closest pair's
 *    average-linkage cosine distance exceeds `distanceThreshold` (tighter
 *    threshold → more speakers). This is the default a caller uses when the
 *    speaker count is unknown.
 *  - `fixed`: keep merging until exactly `k` clusters remain.
 *
 * Labels returned are 0-based and assigned by first appearance (the cluster
 * containing the smallest original index gets 0, the next new one 1, …), so
 * the output is deterministic and stable regardless of internal merge order.
 */

export type ClusterOptions =
  | {
      mode: 'auto';
      distanceThreshold: number;
      /**
       * pyannote's `min_cluster_size` (speaker-diarization-3.1): after the
       * threshold cut, any cluster with fewer than this many segments is
       * absorbed into its nearest LARGE cluster (by centroid cosine distance)
       * rather than surviving as its own speaker. This is what stops short,
       * noisily-embedded interjection segments ("Ja", "oder?") from each
       * becoming a spurious singleton speaker. Omit/≤1 to disable.
       */
      minClusterSize?: number;
    }
  | { mode: 'fixed'; k: number };

/**
 * Cosine distance in [0, 2]: `1 - cosineSimilarity`. Identical direction → 0,
 * orthogonal → 1, opposite → 2. A zero-norm vector (no signal) has no defined
 * direction, so it is treated as maximally dissimilar (distance 1) rather than
 * producing a NaN that would poison the whole linkage.
 */
export function cosineDistance(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 1;
  const similarity = dot / (Math.sqrt(normA) * Math.sqrt(normB));
  // Clamp: floating-point error can push a self-similarity slightly past 1.
  return 1 - Math.max(-1, Math.min(1, similarity));
}

/** Mean vector of the given members' embeddings (cosine distance normalizes internally, so no L2 step needed here). */
function centroidOf(members: readonly number[], embeddings: readonly Float32Array[]): Float32Array {
  const dim = embeddings[0]?.length ?? 0;
  const c = new Float32Array(dim);
  for (const idx of members) {
    const e = embeddings[idx];
    for (let d = 0; d < dim; d++) c[d] += e[d];
  }
  if (members.length > 0) for (let d = 0; d < dim; d++) c[d] /= members.length;
  return c;
}

/**
 * pyannote's `min_cluster_size` cleanup: reassign every cluster smaller than
 * `minSize` into the nearest LARGE cluster (≥ `minSize`) by centroid cosine
 * distance, in one pass against the original large centroids (matching
 * pyannote's `argmin(cdist(small, large))`). No large cluster to absorb into
 * (all clusters are small) → returned unchanged.
 */
function absorbSmallClusters(clusters: number[][], embeddings: readonly Float32Array[], minSize: number): number[][] {
  const large = clusters.filter((c) => c.length >= minSize);
  const small = clusters.filter((c) => c.length < minSize);
  if (large.length === 0 || small.length === 0) return clusters;

  const largeCentroids = large.map((c) => centroidOf(c, embeddings));
  for (const sc of small) {
    const scCentroid = centroidOf(sc, embeddings);
    let best = 0;
    let bestDist = Infinity;
    for (let k = 0; k < large.length; k++) {
      const d = cosineDistance(scCentroid, largeCentroids[k]);
      if (d < bestDist) {
        bestDist = d;
        best = k;
      }
    }
    large[best] = large[best].concat(sc);
  }
  return large;
}

/**
 * Assigns each embedding a 0-based cluster label. Empty input → `[]`; a single
 * embedding → `[0]`. See the file header for the two stopping modes and the
 * first-appearance labelling guarantee.
 */
export function clusterEmbeddings(embeddings: readonly Float32Array[], options: ClusterOptions): number[] {
  const n = embeddings.length;
  if (n === 0) return [];
  if (n === 1) return [0];

  // Precompute the symmetric pairwise distance matrix once (O(n^2)); every
  // average-linkage lookup below reads from it (meeting-scale n, so the naive
  // O(n^3) merge loop that reuses this is comfortably fast enough — YAGNI on a
  // Lance-Williams update).
  const dist: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = cosineDistance(embeddings[i], embeddings[j]);
      dist[i][j] = d;
      dist[j][i] = d;
    }
  }

  // Each cluster is the list of original indices it contains. Start with one
  // singleton per embedding.
  let clusters: number[][] = Array.from({ length: n }, (_, i) => [i]);

  const averageLinkage = (a: number[], b: number[]): number => {
    let sum = 0;
    for (const i of a) for (const j of b) sum += dist[i][j];
    return sum / (a.length * b.length);
  };

  const targetK = options.mode === 'fixed' ? Math.max(1, Math.min(options.k, n)) : 1;

  while (clusters.length > targetK) {
    // Find the closest pair of clusters.
    let bestI = 0;
    let bestJ = 1;
    let bestDist = Infinity;
    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        const d = averageLinkage(clusters[i], clusters[j]);
        if (d < bestDist) {
          bestDist = d;
          bestI = i;
          bestJ = j;
        }
      }
    }

    // Auto mode stops as soon as even the closest pair is too far apart to be
    // the same speaker.
    if (options.mode === 'auto' && bestDist > options.distanceThreshold) break;

    // Merge j into i, drop j.
    clusters[bestI] = clusters[bestI].concat(clusters[bestJ]);
    clusters = clusters.filter((_, idx) => idx !== bestJ);
  }

  // pyannote min_cluster_size cleanup (auto mode only): fold small clusters
  // into their nearest large one so short/noisy segments don't inflate the
  // speaker count. Runs after the threshold cut, before labelling.
  if (options.mode === 'auto' && options.minClusterSize && options.minClusterSize > 1) {
    clusters = absorbSmallClusters(clusters, embeddings, options.minClusterSize);
  }

  // Label by first appearance: order clusters by their smallest member index,
  // then stamp each member with that order position.
  const ordered = clusters
    .map((members) => ({ members, first: Math.min(...members) }))
    .sort((x, y) => x.first - y.first);

  const labels = new Array<number>(n).fill(0);
  ordered.forEach((cluster, label) => {
    for (const idx of cluster.members) labels[idx] = label;
  });
  return labels;
}

/**
 * Folds phase-1 clusters holding less than `minShare` of the total reliable
 * speech TIME into their nearest surviving cluster (by centroid cosine
 * distance, one pass against the surviving centroids — pyannote's
 * `argmin(cdist(small, large))` shape, but with a relative, duration-weighted
 * criterion; see `DurationGuardedClusterOptions.minSpeakerShare` for why).
 * Returns the input unchanged when `minShare` is absent/≤0, when nothing falls
 * below it, or when NOTHING clears it (all clusters equally quiet → keep them
 * all rather than arbitrarily collapsing to one).
 */
function absorbQuietSpeakers(
  clusters: number[][],
  embeddings: readonly Float32Array[],
  durationsMs: readonly number[],
  minShare?: number,
): number[][] {
  if (!minShare || minShare <= 0 || clusters.length < 2) return clusters;

  const speechMs = (members: readonly number[]) => members.reduce((sum, i) => sum + (durationsMs[i] ?? 0), 0);
  const totalMs = clusters.reduce((sum, c) => sum + speechMs(c), 0);
  if (totalMs <= 0) return clusters;

  const keep = clusters.filter((c) => speechMs(c) / totalMs >= minShare);
  const quiet = clusters.filter((c) => speechMs(c) / totalMs < minShare);
  if (keep.length === 0 || quiet.length === 0) return clusters;

  const keepCentroids = keep.map((c) => centroidOf(c, embeddings));
  for (const q of quiet) {
    const qCentroid = centroidOf(q, embeddings);
    let best = 0;
    let bestDist = Infinity;
    for (let k = 0; k < keep.length; k++) {
      const d = cosineDistance(qCentroid, keepCentroids[k]);
      if (d < bestDist) {
        bestDist = d;
        best = k;
      }
    }
    keep[best] = keep[best].concat(q);
  }
  return keep;
}

/** How far each re-cut step lowers the threshold when hunting for `knownSpeakerCount` clusters, and where the hunt gives up. */
const RECUT_STEP = 0.05;
const RECUT_FLOOR = 0.15;

/**
 * Folds the smallest cluster (by reliable speech TIME) into its nearest
 * neighbour (centroid cosine distance) until exactly `k` remain. Time-, not
 * count-based, for the same reason as `minSpeakerShare`: an artifact cluster
 * holds little speech, a real voice holds a lot — so artifacts fold first.
 */
function foldToCount(
  clusters: number[][],
  embeddings: readonly Float32Array[],
  durationsMs: readonly number[],
  k: number,
): number[][] {
  const speechMs = (c: readonly number[]) => c.reduce((sum, i) => sum + (durationsMs[i] ?? 0), 0);
  let out = clusters.map((c) => c.slice());
  while (out.length > k) {
    let smallest = 0;
    for (let i = 1; i < out.length; i++) if (speechMs(out[i]) < speechMs(out[smallest])) smallest = i;
    const folded = out[smallest];
    out = out.filter((_, i) => i !== smallest);
    const cen = centroidOf(folded, embeddings);
    let best = 0;
    let bestDist = Infinity;
    out.forEach((c, i) => {
      const d = cosineDistance(cen, centroidOf(c, embeddings));
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    });
    out[best] = out[best].concat(folded);
  }
  return out;
}

/**
 * Reconciles the phase-1 clusters with the user-stated speaker count (see
 * `knownSpeakerCount` doc): fold down when too many; re-cut lower (then fold
 * back down) when too few. `reliable` maps phase-1 positions to original
 * segment indices.
 */
function reconcileToKnownCount(
  clusters: number[][],
  reliable: readonly number[],
  embeddings: readonly Float32Array[],
  durationsMs: readonly number[],
  clustering: ClusterOptions,
  k: number,
): number[][] {
  let out = clusters;
  if (out.length < k && clustering.mode === 'auto') {
    for (let t = clustering.distanceThreshold - RECUT_STEP; t >= RECUT_FLOOR - 1e-9 && out.length < k; t -= RECUT_STEP) {
      const labels = clusterEmbeddings(reliable.map((i) => embeddings[i]), { mode: 'auto', distanceThreshold: t });
      const regrouped = new Map<number, number[]>();
      labels.forEach((label, j) => {
        const arr = regrouped.get(label);
        if (arr) arr.push(reliable[j]);
        else regrouped.set(label, [reliable[j]]);
      });
      if (regrouped.size > out.length) out = [...regrouped.values()];
    }
  }
  return out.length > k ? foldToCount(out, embeddings, durationsMs, k) : out;
}

/** Renumbers arbitrary group ids to 0-based labels by first appearance (group of the first element → 0, next new group → 1, …). */
function relabelByFirstAppearance(raw: readonly number[]): number[] {
  const remap = new Map<number, number>();
  let next = 0;
  return raw.map((g) => {
    let label = remap.get(g);
    if (label === undefined) {
      label = next++;
      remap.set(g, label);
    }
    return label;
  });
}

/**
 * What the two decisions inside `clusterWithDurationGuard` actually saw. Purely
 * observational — three hardware rounds were spent guessing whether a collapsed
 * speaker count came from phase 1 (clusters never separated) or from the share
 * floor (a real speaker folded away), which these numbers answer outright.
 */
export interface ClusterDiagnostics {
  /** Total segments, and how many cleared `minReliableDurationMs` to take part in phase 1. */
  segments: number;
  reliable: number;
  /** Reliable speech time (ms) per phase-1 cluster, descending — BEFORE the share floor. */
  phase1DurationsMs: number[];
  /** Reliable speech time (ms) per surviving cluster, descending — AFTER the share floor. */
  keptDurationsMs: number[];
}

export interface DurationGuardedClusterOptions {
  /** Clustering applied to the RELIABLE subset only, to establish the speakers + their centroids. */
  clustering: ClusterOptions;
  /** Optional observer for the numbers behind the outcome (see `ClusterDiagnostics`). Never affects the result. */
  onDiagnostics?: (info: ClusterDiagnostics) => void;
  /**
   * Minimum share (0..1) of all reliable SPEECH TIME a phase-1 cluster must
   * hold to count as its own speaker; below it, the cluster is folded into its
   * nearest surviving one. Omit to keep every cluster.
   *
   * This replaces pyannote's absolute `min_cluster_size` (12), which cannot
   * transfer to this pipeline: it was tuned for pyannote's dense segmentation
   * (hundreds of regions), while phase 1 here sees only the reliable subset —
   * a few dozen segments — so an absolute floor deleted real minority speakers
   * on short recordings (hardware test 01).
   * A SHARE scales with the recording instead: a genuine second voice in a
   * 2-speaker conversation holds tens of percent, while a cluster split off a
   * handful of oddly-embedded segments holds a few. Duration-weighted, not
   * count-weighted, because one 10 s turn is stronger evidence for a speaker
   * than three 1.6 s ones.
   */
  minSpeakerShare?: number;
  /**
   * The speaker count the USER stated (they usually know it — hardware test
   * 01 round 5). When set, it overrides both automatic count decisions: the
   * share floor (`minSpeakerShare` is skipped — a quiet real speaker must
   * survive when the user said they exist) and, when the threshold cut finds a
   * different count, the reconciliation below.
   *
   * Deliberately NOT implemented as plain agglomerative-to-k
   * (`ClusterOptions`'s `fixed` mode): merging until k remain merges by
   * closest pair, and two real voices (average distance ~0.6 on hardware) are
   * closer to each other than a far-off artifact cluster (~0.85+) — so
   * fixed-k=2 would happily produce [both-voices-merged, artifact] and label
   * it "Sprecher 1/2". Instead the natural threshold cut runs first and the
   * count only CORRECTS it:
   *  - too many clusters → fold the smallest (by reliable speech time) into
   *    its nearest neighbour until k remain — artifacts hold little time, so
   *    they fold first;
   *  - too few → re-cut the reliable subset at progressively lower thresholds
   *    until at least k clusters appear, then fold back down to k. If even the
   *    lowest re-cut can't separate k voices, the result keeps the smaller
   *    count — never fabricate a speaker out of nothing.
   */
  knownSpeakerCount?: number;
  /**
   * Minimum segment duration (ms) to count as "reliable". Only reliable
   * segments define the speaker set (their embeddings are trustworthy); short
   * segments embed noisily and, clustered directly, each becomes a spurious
   * speaker. Short segments are still LABELLED — assigned to the nearest speaker
   * centroid — they just never form their own cluster.
   */
  minReliableDurationMs: number;
}

/**
 * Two-phase, duration-guarded clustering (SD-1): cluster only the reliable
 * (long-enough) segments to fix the speaker COUNT + centroids, then assign
 * EVERY segment (short and long) to its nearest speaker centroid by cosine
 * distance. This is the fix for a real recording clustering into far too many
 * speakers — the speaker count is driven by trustworthy embeddings, not by
 * hundreds of noisy sub-second interjection segments. `durationsMs[i]` is the
 * duration of `embeddings[i]`'s segment. Falls back to clustering everything
 * when there are fewer than 2 reliable segments (nothing to define speakers).
 */
export function clusterWithDurationGuard(
  embeddings: readonly Float32Array[],
  durationsMs: readonly number[],
  options: DurationGuardedClusterOptions,
): number[] {
  const n = embeddings.length;
  if (n === 0) return [];

  const reliable: number[] = [];
  for (let i = 0; i < n; i++) if (durationsMs[i] >= options.minReliableDurationMs) reliable.push(i);
  // Fallback when nothing is reliable enough to define speakers: cluster
  // everything — honoring a user-stated count directly (degenerate input, so
  // plain agglomerative-to-k is fine here; there is no artifact/voice split to
  // protect, see `knownSpeakerCount`).
  if (reliable.length < 2)
    return clusterEmbeddings(
      embeddings,
      options.knownSpeakerCount && options.knownSpeakerCount >= 1
        ? { mode: 'fixed', k: options.knownSpeakerCount }
        : options.clustering,
    );

  // Phase 1: cluster the reliable segments → one centroid per speaker.
  const reliableLabels = clusterEmbeddings(
    reliable.map((i) => embeddings[i]),
    options.clustering,
  );
  const members = new Map<number, number[]>();
  reliableLabels.forEach((label, j) => {
    const arr = members.get(label);
    if (arr) arr.push(reliable[j]);
    else members.set(label, [reliable[j]]);
  });
  const phase1 = [...members.values()];
  // User-stated count wins over both automatic count decisions; otherwise the
  // share floor guards against artifact clusters (see the option docs).
  const clusters =
    options.knownSpeakerCount && options.knownSpeakerCount >= 1
      ? reconcileToKnownCount(phase1, reliable, embeddings, durationsMs, options.clustering, options.knownSpeakerCount)
      : absorbQuietSpeakers(phase1, embeddings, durationsMs, options.minSpeakerShare);
  const centroids = clusters.map((m) => centroidOf(m, embeddings));

  if (options.onDiagnostics) {
    const totalMs = (group: readonly number[][]) =>
      group.map((c) => c.reduce((sum, i) => sum + (durationsMs[i] ?? 0), 0)).sort((a, b) => b - a);
    options.onDiagnostics({
      segments: n,
      reliable: reliable.length,
      phase1DurationsMs: totalMs(phase1),
      keptDurationsMs: totalMs(clusters),
    });
  }

  // Phase 2: assign every segment to its nearest speaker centroid.
  const raw = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    let best = 0;
    let bestDist = Infinity;
    for (let k = 0; k < centroids.length; k++) {
      const d = cosineDistance(embeddings[i], centroids[k]);
      if (d < bestDist) {
        bestDist = d;
        best = k;
      }
    }
    raw[i] = best;
  }
  return relabelByFirstAppearance(raw);
}
