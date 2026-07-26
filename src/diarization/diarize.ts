/**
 * U16 diarization pipeline: turns raw 16 kHz mono PCM into a global speaker
 * timeline by assembling the swappable `DiarizationEngine` (U15) with the pure
 * `clustering.ts` core. Post-hoc only (KTD13) — runs once after stop/import,
 * not streaming.
 *
 * segment → embed each region → cluster embeddings into global speakers →
 * merge adjacent same-speaker regions into one timeline. The only model work
 * is `engine.segment`/`engine.embed`; everything else is pure, so this whole
 * assembly is testable with a fake engine (`diarize.test.ts`).
 */
import { clusterWithDurationGuard, type ClusterOptions } from './clustering';
import type { DiarizationEngine } from './DiarizationEngine';
import type { SpeakerTimeline, SpeakerTurn } from './types';

/** 16 kHz — the rate `audioDecode.ts` (U14) resamples to and the diarization models expect. */
export const DIARIZATION_SAMPLE_RATE = 16000;

/**
 * Default minimum segment duration (ms) to count as "reliable" for defining
 * speakers (see `clusterWithDurationGuard`). Short segments embed noisily; on a
 * real recording, clustering them directly produced far too many speakers.
 * Calibrated on real WeSpeaker embeddings (a 2-speaker meeting clustered
 * cleanly into 2 only once the sub-~1.5 s segments stopped defining speakers).
 */
export const DEFAULT_MIN_RELIABLE_DURATION_MS = 1500;

/**
 * How many segments to embed per model call (roadmap 1a). Segments are length-
 * bucketed before batching (see `diarize`), so a batch's members are near-equal
 * length and the padding-to-max the embedder does is small. Larger batches
 * amortize more per-call WASM overhead but grow the padded tensor; 16 is a lean
 * middle ground pending on-device tuning.
 */
export const DEFAULT_EMBED_BATCH_SIZE = 16;

/**
 * Default `minSpeakerShare` (see `clusterWithDurationGuard`): a phase-1 cluster
 * holding less than 10 % of the reliable speech time is folded into its nearest
 * neighbour instead of surviving as its own speaker.
 *
 * This is the RELATIVE replacement for pyannote's absolute `min_cluster_size`,
 * which collapsed a real 2-speaker interview into one (hardware test 01). Its
 * second run then showed the opposite failure — 3 speakers for 2 people — which
 * is what this counters: a genuine second voice in a conversation holds tens of
 * percent of the speech, a cluster split off a few oddly-embedded segments
 * holds a few. 10 % is reasoned from that gap, NOT hardware-calibrated (the
 * only honest label for it until a real run says otherwise) and deliberately
 * one number in one place, easy to move.
 */
export const DEFAULT_MIN_SPEAKER_SHARE = 0.1;

export interface DiarizeOptions {
  /** How to group per-segment embeddings into speakers (auto threshold or fixed k). */
  clustering: ClusterOptions;
  /** PCM sample rate; defaults to `DIARIZATION_SAMPLE_RATE`. */
  sampleRate?: number;
  /** Segments embedded per model call (roadmap 1a); defaults to `DEFAULT_EMBED_BATCH_SIZE`. */
  embedBatchSize?: number;
  /** Minimum segment duration (ms) to define a speaker (see `clusterWithDurationGuard`); defaults to `DEFAULT_MIN_RELIABLE_DURATION_MS`. */
  minReliableDurationMs?: number;
  /** Minimum share of reliable speech time for a speaker to survive phase 1 (see `clusterWithDurationGuard`); defaults to `DEFAULT_MIN_SPEAKER_SHARE`. */
  minSpeakerShare?: number;
  /** User-stated speaker count — overrides the automatic count decisions (see `clusterWithDurationGuard`). */
  knownSpeakerCount?: number;
}

/** Slices the PCM for a `[startMs, endMs)` region, clamped to the buffer bounds. */
function sliceByMs(pcm: Float32Array, startMs: number, endMs: number, sampleRate: number): Float32Array {
  const from = Math.max(0, Math.round((startMs / 1000) * sampleRate));
  const to = Math.min(pcm.length, Math.round((endMs / 1000) * sampleRate));
  return pcm.subarray(from, Math.max(from, to));
}

/**
 * Runs the full pipeline. Empty audio or no detected speech → empty timeline
 * (never throws). Speaker indices are 0-based by first appearance.
 */
export async function diarize(
  pcm: Float32Array,
  engine: DiarizationEngine,
  options: DiarizeOptions,
): Promise<SpeakerTimeline> {
  const sampleRate = options.sampleRate ?? DIARIZATION_SAMPLE_RATE;
  const segments = await engine.segment(pcm);
  if (segments.length === 0) return [];

  // Embed in length-bucketed batches (roadmap 1a): order segments by duration
  // so each `embedBatch` groups near-equal-length regions (minimal padding —
  // see `embedding.ts`), run the model once per batch, and scatter the results
  // back to each segment's original index.
  const batchSize = Math.max(1, options.embedBatchSize ?? DEFAULT_EMBED_BATCH_SIZE);
  const order = segments.map((_, i) => i).sort((a, b) => segments[a].endMs - segments[a].startMs - (segments[b].endMs - segments[b].startMs));
  const embeddings = new Array<Float32Array>(segments.length);
  for (let start = 0; start < order.length; start += batchSize) {
    const chunk = order.slice(start, start + batchSize);
    const slices = chunk.map((i) => sliceByMs(pcm, segments[i].startMs, segments[i].endMs, sampleRate));
    const embs = await engine.embedBatch(slices);
    chunk.forEach((i, k) => (embeddings[i] = embs[k]));
  }

  // Duration-guarded: only reliable (long-enough) segments define the speaker
  // count; every segment is then labelled by its nearest speaker centroid.
  const labels = clusterWithDurationGuard(embeddings, segments.map((s) => s.endMs - s.startMs), {
    clustering: options.clustering,
    minReliableDurationMs: options.minReliableDurationMs ?? DEFAULT_MIN_RELIABLE_DURATION_MS,
    minSpeakerShare: options.minSpeakerShare ?? DEFAULT_MIN_SPEAKER_SHARE,
    knownSpeakerCount: options.knownSpeakerCount,
    // One line in the worker console per run. A wrong speaker count is only
    // diagnosable ON HARDWARE (no model, no GPU in CI or the dev container), and
    // the numbers below say immediately whether phase 1 failed to separate the
    // voices or the share floor folded a real one away. Counts and durations
    // only — no audio, nothing that leaves the device.
    onDiagnostics: (info) => {
      const secs = (list: readonly number[]) => list.map((ms) => (ms / 1000).toFixed(1)).join(', ');
      console.info(
        `[diarize] segments=${info.segments} reliable=${info.reliable} known=${options.knownSpeakerCount ?? 'auto'} ` +
          `phase1=[${secs(info.phase1DurationsMs)}]s → speakers=[${secs(info.keptDurationsMs)}]s`,
      );
    },
  });

  // Attach speakers, order by time, then merge runs of the same speaker into
  // single turns (KTD14 "benachbarte gleiche Sprecher verschmelzen").
  const turns: SpeakerTurn[] = segments
    .map((seg, i) => ({ startMs: seg.startMs, endMs: seg.endMs, speaker: labels[i] }))
    .sort((a, b) => a.startMs - b.startMs);

  return mergeAdjacentSameSpeaker(turns);
}

/** Merges consecutive turns (time order) that share a speaker into one spanning turn. */
export function mergeAdjacentSameSpeaker(turns: readonly SpeakerTurn[]): SpeakerTimeline {
  const merged: SpeakerTurn[] = [];
  for (const turn of turns) {
    const last = merged[merged.length - 1];
    if (last && last.speaker === turn.speaker) {
      last.endMs = Math.max(last.endMs, turn.endMs);
    } else {
      merged.push({ ...turn });
    }
  }
  return merged;
}
