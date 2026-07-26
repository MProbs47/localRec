import { describe, expect, it, vi } from 'vitest';
import { WeSpeakerEmbedder, WESPEAKER_EMBEDDING_DIM, type OrtSessionLike, type OrtTensorLike } from './embedding';

const tensor = (data: Float32Array, dims: number[]): OrtTensorLike => ({ data, dims });

/**
 * A fake ort session that records the feats it was fed and returns a fixed
 * embedding. Declares its input/output names the way the real onnx-community
 * model does (`input_features` / `embeddings`, NOT the classic `feats`/`embs`)
 * — the embedder must read those names off the session, never hardcode them.
 */
function fakeSession(
  embedding: Float32Array,
  names: { input?: string; output?: string } = {},
): OrtSessionLike & { lastFeats?: OrtTensorLike } {
  const input = names.input ?? 'input_features';
  const output = names.output ?? 'embeddings';
  const session: OrtSessionLike & { lastFeats?: OrtTensorLike } = {
    inputNames: [input],
    outputNames: [output],
    async run(feeds) {
      session.lastFeats = feeds[input];
      return { [output]: tensor(embedding, [1, embedding.length]) };
    },
  };
  return session;
}

describe('WeSpeakerEmbedder', () => {
  it("feeds [1, numFrames, 80] feats under the session's declared input name and returns the model embedding", async () => {
    const embedding = new Float32Array(WESPEAKER_EMBEDDING_DIM).fill(0.5);
    const session = fakeSession(embedding);
    const embedder = new WeSpeakerEmbedder(session, tensor);

    const pcm = new Float32Array(16000); // 1s → 98 frames
    for (let i = 0; i < pcm.length; i++) pcm[i] = Math.sin(i / 5) * 0.3;
    const out = await embedder.embed(pcm);

    expect(session.lastFeats?.dims).toEqual([1, 98, 80]);
    expect(out).toEqual(embedding);
  });

  it('uses whatever input/output names the model declares (not a hardcoded feats/embs)', async () => {
    const embedding = new Float32Array(WESPEAKER_EMBEDDING_DIM).fill(0.25);
    // A model that names its tensors differently again — the embedder must still work.
    const session = fakeSession(embedding, { input: 'feats', output: 'embs' });
    const embedder = new WeSpeakerEmbedder(session, tensor);
    const out = await embedder.embed(new Float32Array(16000));
    expect(session.lastFeats).toBeDefined();
    expect(out).toEqual(embedding);
  });

  it('copies the embedding out of the session-owned buffer (no aliasing)', async () => {
    const modelBuffer = new Float32Array(WESPEAKER_EMBEDDING_DIM).fill(1);
    const embedder = new WeSpeakerEmbedder(fakeSession(modelBuffer), tensor);
    const out = await embedder.embed(new Float32Array(16000));
    expect(out).not.toBe(modelBuffer);
    modelBuffer[0] = 999; // mutating the model buffer must not affect the returned copy
    expect(out[0]).toBe(1);
  });

  it('returns a zero embedding for a sub-frame segment without invoking the model', async () => {
    const run = vi.fn();
    const embedder = new WeSpeakerEmbedder({ run, inputNames: ['input_features'], outputNames: ['embeddings'] }, tensor);
    const out = await embedder.embed(new Float32Array(100)); // < one 400-sample frame
    expect(run).not.toHaveBeenCalled();
    expect(out).toEqual(new Float32Array(WESPEAKER_EMBEDDING_DIM));
  });

  it('throws a clear error if the model output lacks the embedding tensor', async () => {
    const badSession: OrtSessionLike = {
      inputNames: ['input_features'],
      outputNames: ['embeddings'],
      async run() {
        return {};
      },
    };
    const embedder = new WeSpeakerEmbedder(badSession, tensor);
    await expect(embedder.embed(new Float32Array(16000))).rejects.toThrow(/embeddings/);
  });
});

/**
 * A batch-aware fake session: returns one row per batch member, each row
 * carrying `[rowIndex, maxFrames, …0]` so a test can read back both the row
 * ORDER (input order must be preserved) and the padded frame count the batch
 * was run at. Records how many times the graph was actually run.
 */
function fakeBatchSession(dim: number): OrtSessionLike & { lastFeats?: OrtTensorLike; runCalls: number } {
  const session: OrtSessionLike & { lastFeats?: OrtTensorLike; runCalls: number } = {
    inputNames: ['input_features'],
    outputNames: ['embeddings'],
    runCalls: 0,
    async run(feeds) {
      const feats = feeds['input_features'];
      session.lastFeats = feats;
      session.runCalls++;
      const [n, maxFrames] = feats.dims;
      const data = new Float32Array(n * dim);
      for (let r = 0; r < n; r++) {
        data[r * dim] = r; // row index → verifies output order
        data[r * dim + 1] = maxFrames; // padded frame count → verifies padding-to-max
      }
      return { embeddings: tensor(data, [n, dim]) };
    },
  };
  return session;
}

describe('WeSpeakerEmbedder.embedBatch', () => {
  it('returns [] for an empty batch without invoking the model', async () => {
    const run = vi.fn();
    const embedder = new WeSpeakerEmbedder({ run, inputNames: ['input_features'], outputNames: ['embeddings'] }, tensor);
    expect(await embedder.embedBatch([])).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });

  it('embeds many segments in ONE run, padded to the batch max frames, order preserved', async () => {
    const session = fakeBatchSession(WESPEAKER_EMBEDDING_DIM);
    const embedder = new WeSpeakerEmbedder(session, tensor);

    const oneSecond = new Float32Array(16000); // 98 frames
    const twoSeconds = new Float32Array(32000); // 198 frames
    const out = await embedder.embedBatch([oneSecond, twoSeconds]);

    expect(session.runCalls).toBe(1);
    expect(session.lastFeats?.dims).toEqual([2, 198, 80]); // padded to the longest member
    expect(out).toHaveLength(2);
    expect(out[0][0]).toBe(0); // row 0 stayed at input position 0
    expect(out[1][0]).toBe(1); // row 1 stayed at input position 1
    expect(out[0][1]).toBe(198); // both rows ran at the padded frame count
  });

  it('gives sub-frame members a zero embedding and still batches the rest in one run', async () => {
    const session = fakeBatchSession(WESPEAKER_EMBEDDING_DIM);
    const embedder = new WeSpeakerEmbedder(session, tensor);

    const out = await embedder.embedBatch([new Float32Array(16000), new Float32Array(100), new Float32Array(16000)]);

    expect(session.runCalls).toBe(1);
    expect(session.lastFeats?.dims).toEqual([2, 98, 80]); // only the two real 1 s segments are fed
    expect(out).toHaveLength(3);
    expect(out[1]).toEqual(new Float32Array(WESPEAKER_EMBEDDING_DIM)); // the sub-frame member → zeros
    expect(out[0][0]).toBe(0); // real members keep their input slots (0 and 2)
    expect(out[2][0]).toBe(1);
  });

  it('embed() delegates to embedBatch (single-item convenience)', async () => {
    const session = fakeBatchSession(WESPEAKER_EMBEDDING_DIM);
    const embedder = new WeSpeakerEmbedder(session, tensor);
    const out = await embedder.embed(new Float32Array(16000));
    expect(session.runCalls).toBe(1);
    expect(session.lastFeats?.dims).toEqual([1, 98, 80]);
    expect(out[0]).toBe(0);
  });
});
