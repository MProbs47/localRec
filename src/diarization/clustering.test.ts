import { describe, expect, it } from 'vitest';
import {
  cosineDistance,
  clusterEmbeddings,
  clusterWithDurationGuard,
  type ClusterDiagnostics,
  type ClusterOptions,
} from './clustering';
import { DEFAULT_MIN_RELIABLE_DURATION_MS, DEFAULT_MIN_SPEAKER_SHARE } from './diarize';
import { DEFAULT_CLUSTER_THRESHOLD } from '../session/diarizationRun';

const v = (...xs: number[]) => new Float32Array(xs);

describe('cosineDistance', () => {
  it('is 0 for identical direction, 1 for orthogonal, 2 for opposite', () => {
    expect(cosineDistance(v(1, 0), v(1, 0))).toBeCloseTo(0);
    expect(cosineDistance(v(1, 0), v(0, 1))).toBeCloseTo(1);
    expect(cosineDistance(v(1, 0), v(-1, 0))).toBeCloseTo(2);
  });

  it('ignores magnitude (direction only)', () => {
    expect(cosineDistance(v(2, 0), v(9, 0))).toBeCloseTo(0);
  });

  it('treats a zero-norm vector as maximally ambiguous (distance 1, never NaN)', () => {
    const d = cosineDistance(v(0, 0), v(1, 1));
    expect(Number.isNaN(d)).toBe(false);
    expect(d).toBe(1);
  });
});

describe('clusterEmbeddings', () => {
  it('returns [] for empty input and [0] for a single embedding', () => {
    expect(clusterEmbeddings([], { mode: 'auto', distanceThreshold: 0.5 })).toEqual([]);
    expect(clusterEmbeddings([v(1, 0)], { mode: 'auto', distanceThreshold: 0.5 })).toEqual([0]);
  });

  it('groups two clearly separated speaker clusters (auto)', () => {
    // Two tight groups around orthogonal directions.
    const embeddings = [v(1, 0.01), v(0.99, 0), v(0, 1), v(0.01, 0.99)];
    const labels = clusterEmbeddings(embeddings, { mode: 'auto', distanceThreshold: 0.5 });
    // First two share a label, last two share a different label.
    expect(labels[0]).toBe(labels[1]);
    expect(labels[2]).toBe(labels[3]);
    expect(labels[0]).not.toBe(labels[2]);
    // Exactly two speakers.
    expect(new Set(labels).size).toBe(2);
  });

  it('labels by first appearance: first cluster is always 0', () => {
    const embeddings = [v(0, 1), v(0.01, 0.99), v(1, 0), v(0.99, 0.01)];
    const labels = clusterEmbeddings(embeddings, { mode: 'auto', distanceThreshold: 0.5 });
    expect(labels[0]).toBe(0);
    // The first embedding that doesn't match cluster 0 becomes 1.
    expect(labels[2]).toBe(1);
  });

  it('threshold controls the speaker count: tighter → more clusters', () => {
    const embeddings = [v(1, 0), v(0.7, 0.7), v(0, 1)];
    const loose = clusterEmbeddings(embeddings, { mode: 'auto', distanceThreshold: 0.9 });
    const tight = clusterEmbeddings(embeddings, { mode: 'auto', distanceThreshold: 0.1 });
    expect(new Set(loose).size).toBeLessThanOrEqual(new Set(tight).size);
    expect(new Set(tight).size).toBe(3);
  });

  it('fixed-k mode yields exactly k clusters', () => {
    const embeddings = [v(1, 0), v(0.9, 0.1), v(0, 1), v(0.1, 0.9), v(-1, 0)];
    const labels = clusterEmbeddings(embeddings, { mode: 'fixed', k: 2 });
    expect(new Set(labels).size).toBe(2);
  });

  it('fixed-k clamps k to [1, n]', () => {
    const embeddings = [v(1, 0), v(0, 1)];
    expect(new Set(clusterEmbeddings(embeddings, { mode: 'fixed', k: 99 })).size).toBe(2);
    expect(new Set(clusterEmbeddings(embeddings, { mode: 'fixed', k: 0 })).size).toBe(1);
  });

  it('a single speaker collapses to one cluster (auto)', () => {
    const embeddings = [v(1, 0), v(0.99, 0.02), v(0.98, 0.01)];
    const options: ClusterOptions = { mode: 'auto', distanceThreshold: 0.3 };
    expect(new Set(clusterEmbeddings(embeddings, options)).size).toBe(1);
  });

  it('minClusterSize absorbs small clusters into the nearest large one (pyannote-style singleton cleanup)', () => {
    // Two large speakers (12 each) plus two outlier segments a tight threshold
    // leaves as their own clusters — the short-interjection failure mode.
    const A = Array.from({ length: 12 }, () => v(1, 0));
    const B = Array.from({ length: 12 }, () => v(0, 1));
    const C = v(1, 0.5); // outlier, nearer A
    const D = v(0.5, 1); // outlier, nearer B
    const embeddings = [...A, C, ...B, D]; // A:0-11, C:12, B:13-24, D:25

    // Without min_cluster_size: C and D survive as spurious singleton speakers.
    const withoutMin = clusterEmbeddings(embeddings, { mode: 'auto', distanceThreshold: 0.05 });
    expect(new Set(withoutMin).size).toBeGreaterThan(2);

    // With min_cluster_size=12: the singletons fold into the nearest large
    // cluster by centroid distance → exactly two speakers.
    const withMin = clusterEmbeddings(embeddings, { mode: 'auto', distanceThreshold: 0.05, minClusterSize: 12 });
    expect(new Set(withMin).size).toBe(2);
    expect(withMin[12]).toBe(withMin[0]); // C absorbed into A
    expect(withMin[25]).toBe(withMin[13]); // D absorbed into B
  });

  it('minClusterSize is a no-op when no cluster reaches the size (nothing to absorb into)', () => {
    const embeddings = [v(1, 0), v(0, 1), v(-1, 0)];
    const labels = clusterEmbeddings(embeddings, { mode: 'auto', distanceThreshold: 0.05, minClusterSize: 12 });
    expect(new Set(labels).size).toBe(3); // all small, no large cluster → unchanged
  });
});

describe('clusterWithDurationGuard', () => {
  it('only the long segments define speakers; short noisy segments attach to the nearest instead of forming their own', () => {
    // 6 reliable (2 s) segments cleanly split A/B, plus 2 short (100 ms) outliers.
    const A = v(1, 0);
    const B = v(0, 1);
    const embeddings = [A, A, A, B, B, B, v(0.9, 0.1), v(0.1, 0.9)];
    const durationsMs = [2000, 2000, 2000, 2000, 2000, 2000, 100, 100];
    const labels = clusterWithDurationGuard(embeddings, durationsMs, {
      clustering: { mode: 'auto', distanceThreshold: 0.5 },
      minReliableDurationMs: 1000,
    });
    // The two short outliers did NOT create a third speaker.
    expect(new Set(labels).size).toBe(2);
    expect(labels[6]).toBe(labels[0]); // short [0.9,0.1] → A's speaker
    expect(labels[7]).toBe(labels[3]); // short [0.1,0.9] → B's speaker
  });

  it('the speaker count comes from the reliable segments only — many short outliers cannot inflate it', () => {
    const long = Array.from({ length: 8 }, (_, i) => (i < 4 ? v(1, 0) : v(0, 1))); // 4×A, 4×B
    // 20 short outliers scattered around — with plain clustering these would explode the count.
    const short = Array.from({ length: 20 }, (_, i) => v(1, 0.3 + i * 0.03));
    const embeddings = [...long, ...short];
    const durationsMs = [...long.map(() => 2000), ...short.map(() => 120)];
    const labels = clusterWithDurationGuard(embeddings, durationsMs, {
      clustering: { mode: 'auto', distanceThreshold: 0.5 },
      minReliableDurationMs: 1000,
    });
    expect(new Set(labels).size).toBe(2);
  });

  it('falls back to clustering everything when there are fewer than 2 reliable segments', () => {
    const embeddings = [v(1, 0), v(0, 1)];
    const durationsMs = [100, 100]; // both too short → no reliable set → fallback
    const labels = clusterWithDurationGuard(embeddings, durationsMs, {
      clustering: { mode: 'auto', distanceThreshold: 0.5 },
      minReliableDurationMs: 1000,
    });
    expect(new Set(labels).size).toBe(2); // fallback clusters both (orthogonal → 2 speakers)
  });

  it('returns [] for empty input', () => {
    expect(clusterWithDurationGuard([], [], { clustering: { mode: 'auto', distanceThreshold: 0.5 }, minReliableDurationMs: 1000 })).toEqual([]);
  });

  /**
   * Regression lock for hardware test 01: a real 2-speaker interview came
   * out as ONE speaker. Cause was the pyannote
   * `min_cluster_size: 12` the production config used to pass here — the guard
   * clusters only the RELIABLE subset (a few dozen segments), so a speaker who
   * holds the floor less (interviewer, 8 reliable turns) fell under the absolute
   * floor and was absorbed into the dominant one. This exercises the PRODUCTION
   * defaults (`runDiarization`'s threshold + `diarize`'s reliability gate) on
   * exactly that lopsided population.
   */
  it('keeps a minority speaker with few reliable segments (production defaults, no min_cluster_size)', () => {
    // Two clearly separated directions: 15 turns for the dominant speaker, 8 for the other.
    const dominant = Array.from({ length: 15 }, (_, i) => v(1, 0.02 * (i % 3)));
    const minority = Array.from({ length: 8 }, (_, i) => v(0.02 * (i % 3), 1));
    const embeddings = [...dominant, ...minority];
    const durationsMs = embeddings.map(() => 3000); // all reliable
    const labels = clusterWithDurationGuard(embeddings, durationsMs, {
      clustering: { mode: 'auto', distanceThreshold: DEFAULT_CLUSTER_THRESHOLD },
      minReliableDurationMs: DEFAULT_MIN_RELIABLE_DURATION_MS,
    });
    expect(new Set(labels).size).toBe(2);

    // And this is what used to happen — kept as the explicit contrast, so the
    // reason the knob is off in production stays visible.
    const collapsed = clusterWithDurationGuard(embeddings, durationsMs, {
      clustering: { mode: 'auto', distanceThreshold: DEFAULT_CLUSTER_THRESHOLD, minClusterSize: 12 },
      minReliableDurationMs: DEFAULT_MIN_RELIABLE_DURATION_MS,
    });
    expect(new Set(collapsed).size).toBe(1);
  });
});

/**
 * The RELATIVE floor that replaces pyannote's absolute `min_cluster_size` —
 * hardware test 01's second run found 3 speakers for 2 people (the opposite
 * failure of the collapse above). See `DEFAULT_MIN_SPEAKER_SHARE`.
 */
describe('clusterWithDurationGuard: minSpeakerShare', () => {
  // Three directions, but the third holds only ~4 % of the speech time.
  const dominant = Array.from({ length: 10 }, (_, i) => v(1, 0.02 * (i % 3), 0));
  const second = Array.from({ length: 6 }, (_, i) => v(0.02 * (i % 3), 1, 0));
  const artifact = [v(0, 0.05, 1)];
  const embeddings = [...dominant, ...second, ...artifact];
  const durationsMs = [...dominant.map(() => 6000), ...second.map(() => 5000), 2000];

  it('folds a speaker holding less than the share into its nearest neighbour', () => {
    const labels = clusterWithDurationGuard(embeddings, durationsMs, {
      clustering: { mode: 'auto', distanceThreshold: DEFAULT_CLUSTER_THRESHOLD },
      minReliableDurationMs: DEFAULT_MIN_RELIABLE_DURATION_MS,
      minSpeakerShare: DEFAULT_MIN_SPEAKER_SHARE,
    });
    expect(new Set(labels).size).toBe(2); // the 2 real voices; the artifact joins one
  });

  it('keeps a real minority speaker that clears the share', () => {
    // Same shapes, but the third voice now holds ~25 % of the speech.
    const realThird = Array.from({ length: 5 }, (_, i) => v(0, 0.02 * (i % 3), 1));
    const labels = clusterWithDurationGuard(
      [...dominant, ...second, ...realThird],
      [...dominant.map(() => 6000), ...second.map(() => 5000), ...realThird.map(() => 6000)],
      {
        clustering: { mode: 'auto', distanceThreshold: DEFAULT_CLUSTER_THRESHOLD },
        minReliableDurationMs: DEFAULT_MIN_RELIABLE_DURATION_MS,
        minSpeakerShare: DEFAULT_MIN_SPEAKER_SHARE,
      },
    );
    expect(new Set(labels).size).toBe(3);
  });

  it('never collapses everything when no cluster clears the share (all equally quiet)', () => {
    const labels = clusterWithDurationGuard(embeddings, durationsMs, {
      clustering: { mode: 'auto', distanceThreshold: DEFAULT_CLUSTER_THRESHOLD },
      minReliableDurationMs: DEFAULT_MIN_RELIABLE_DURATION_MS,
      minSpeakerShare: 0.99, // nothing can clear this
    });
    expect(new Set(labels).size).toBe(3); // unchanged rather than arbitrarily merged
  });

  it('is a no-op when omitted (opt-in)', () => {
    const labels = clusterWithDurationGuard(embeddings, durationsMs, {
      clustering: { mode: 'auto', distanceThreshold: DEFAULT_CLUSTER_THRESHOLD },
      minReliableDurationMs: DEFAULT_MIN_RELIABLE_DURATION_MS,
    });
    expect(new Set(labels).size).toBe(3);
  });
});

describe('clusterWithDurationGuard: knownSpeakerCount', () => {
  const guard = (
    embeddings: Float32Array[],
    durationsMs: number[],
    knownSpeakerCount: number | undefined,
    distanceThreshold = DEFAULT_CLUSTER_THRESHOLD,
  ) =>
    clusterWithDurationGuard(embeddings, durationsMs, {
      clustering: { mode: 'auto', distanceThreshold },
      minReliableDurationMs: DEFAULT_MIN_RELIABLE_DURATION_MS,
      minSpeakerShare: DEFAULT_MIN_SPEAKER_SHARE,
      knownSpeakerCount,
    });

  it('overrides the share floor: a quiet real speaker survives when the user said 2', () => {
    // Hardware round 4's shape: second voice holds ~7 % — the floor alone folds it.
    const loud = Array.from({ length: 10 }, (_, i) => v(1, 0.02 * (i % 3), 0));
    const quiet = Array.from({ length: 2 }, (_, i) => v(0.02 * (i % 3), 1, 0));
    const embeddings = [...loud, ...quiet];
    const durationsMs = [...loud.map(() => 30000), ...quiet.map(() => 8000)];
    expect(new Set(guard(embeddings, durationsMs, undefined)).size).toBe(1); // floor folds (round 4)
    expect(new Set(guard(embeddings, durationsMs, 2)).size).toBe(2); // user knows better
  });

  it('folds by speech time, not merge distance: k=2 keeps the two voices and folds the artifact (the fixed-k trap)', () => {
    // Two real voices closer to EACH OTHER (orthogonal, d=1) than either is to
    // a far-off artifact cluster (opposite-ish hemisphere, d≈1.5+). Plain
    // agglomerative-to-k merges the closest pair first — the two voices — and
    // would return [both-voices, artifact] as the "2 speakers".
    const voiceA = Array.from({ length: 6 }, (_, i) => v(1, 0.02 * (i % 2), 0));
    const voiceB = Array.from({ length: 5 }, (_, i) => v(0.02 * (i % 2), 1, 0));
    const artifact = Array.from({ length: 2 }, () => v(-0.6, -1, 0));
    const embeddings = [...voiceA, ...voiceB, ...artifact];
    const durationsMs = [...voiceA.map(() => 20000), ...voiceB.map(() => 15000), ...artifact.map(() => 2000)];

    const trap = clusterEmbeddings(embeddings, { mode: 'fixed', k: 2 });
    expect(trap[0]).toBe(trap[voiceA.length]); // the trap is real: fixed-k merges A+B

    const labels = guard(embeddings, durationsMs, 2, 0.45); // threshold separates A/B/artifact
    expect(new Set(labels).size).toBe(2);
    expect(labels[0]).not.toBe(labels[voiceA.length]); // A and B stay apart
    expect(labels[voiceA.length + voiceB.length]).toBe(labels[0]); // artifact folded into its nearest voice (A)
  });

  it('re-cuts at lower thresholds when the default cut under-counts (round 5: merge cliff)', () => {
    // Two voices whose average distance sits just UNDER the threshold — the
    // auto cut merges them, but the user said 2 and a lower cut separates them.
    const voiceA = Array.from({ length: 6 }, (_, i) => v(1, 0.28 + 0.01 * (i % 2), 0));
    const voiceB = Array.from({ length: 6 }, (_, i) => v(0.28 + 0.01 * (i % 2), 1, 0));
    const embeddings = [...voiceA, ...voiceB];
    const durationsMs = embeddings.map(() => 10000);
    expect(new Set(guard(embeddings, durationsMs, undefined, 0.5)).size).toBe(1); // auto merges
    expect(new Set(guard(embeddings, durationsMs, 2, 0.5)).size).toBe(2); // re-cut finds them
  });

  it('never fabricates: identical voices stay one speaker even when the user says 3', () => {
    const embeddings = Array.from({ length: 8 }, () => v(1, 0.1, 0));
    const durationsMs = embeddings.map(() => 10000);
    expect(new Set(guard(embeddings, durationsMs, 3)).size).toBe(1);
  });
});

describe('clusterWithDurationGuard: onDiagnostics', () => {
  // Two voices the share floor then collapses into one — the exact shape
  // hardware round 3 produced, so the diagnostics are asserted against a case
  // whose answer we know.
  const loud = Array.from({ length: 10 }, (_, i) => v(1, 0.02 * (i % 3), 0));
  const quiet = Array.from({ length: 2 }, (_, i) => v(0.02 * (i % 3), 1, 0));
  const embeddings = [...loud, ...quiet];
  const durationsMs = [...loud.map(() => 30000), ...quiet.map(() => 8000)];

  const run = (minSpeakerShare?: number) => {
    let info: ClusterDiagnostics | undefined;
    clusterWithDurationGuard(embeddings, durationsMs, {
      clustering: { mode: 'auto', distanceThreshold: DEFAULT_CLUSTER_THRESHOLD },
      minReliableDurationMs: DEFAULT_MIN_RELIABLE_DURATION_MS,
      minSpeakerShare,
      onDiagnostics: (i) => (info = i),
    });
    return info!;
  };

  it('reports the population and both sides of the share floor', () => {
    const info = run(DEFAULT_MIN_SPEAKER_SHARE);
    expect(info.segments).toBe(12);
    expect(info.reliable).toBe(12);
    // Before the floor: two clusters. After: one — the fold is visible, which is
    // the whole point (a collapsed count no longer looks like a phase-1 failure).
    expect(info.phase1DurationsMs).toEqual([300000, 16000]);
    expect(info.keptDurationsMs).toEqual([316000]);
  });

  it('is never called when no observer is passed, and never changes the result', () => {
    const withObserver = clusterWithDurationGuard(embeddings, durationsMs, {
      clustering: { mode: 'auto', distanceThreshold: DEFAULT_CLUSTER_THRESHOLD },
      minReliableDurationMs: DEFAULT_MIN_RELIABLE_DURATION_MS,
      onDiagnostics: () => {},
    });
    const without = clusterWithDurationGuard(embeddings, durationsMs, {
      clustering: { mode: 'auto', distanceThreshold: DEFAULT_CLUSTER_THRESHOLD },
      minReliableDurationMs: DEFAULT_MIN_RELIABLE_DURATION_MS,
    });
    expect(withObserver).toEqual(without);
  });
});
