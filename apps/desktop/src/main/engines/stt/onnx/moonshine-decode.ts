import {
  argmax,
  asFloat32,
  logSoftmaxAt,
  type Feeds,
  type InferenceSessionLike,
  type TensorFactory,
  type TensorLike,
} from './session'

/**
 * Moonshine encode/decode loop (PLAN §6.1, §6.2).
 *
 * ## Shape of the model
 *
 * Moonshine is a small encoder–decoder ASR model from Moonshine AI (formerly
 * Useful Sensors, US). Two facts drive this file:
 *
 *  1. **It eats raw audio.** `preprocessor_config.json` declares a
 *     `Wav2Vec2FeatureExtractor` with `feature_size: 1`, i.e. the encoder takes
 *     the 16 kHz waveform directly — there is no mel front-end to reproduce.
 *     That is why nothing here imports the featurizer.
 *  2. **The decoder is exported "merged".** One graph serves both the first
 *     step (no cache) and every later step (with cache), selected by a
 *     `use_cache_branch` boolean input. On the first pass the past-KV inputs
 *     must still be present but zero-length in the sequence axis.
 *
 * ## The loop
 *
 * Standard greedy autoregressive decoding: seed with `decoder_start_token_id`,
 * take the argmax of the last position's logits, feed it back with the returned
 * `present.*` tensors as the next `past_key_values.*`, stop on EOS or the
 * length cap.
 *
 * The session is injected, so this unit-tests against a fake that returns
 * scripted logits — EOS handling, cache hand-off and the length cap are all
 * assertable without ONNX Runtime or a 60 MB model.
 */

export interface MoonshineConfig {
  /** First decoder input. Moonshine: 1 (`<s>`). */
  decoderStartTokenId: number
  /** Stops decoding. Moonshine: 2 (`</s>`). */
  eosTokenId: number
  /** Never emitted. Moonshine: 2 — same id as EOS, which is fine. */
  padTokenId: number
  /** Hard cap on generated tokens. Moonshine: `max_length` 194. */
  maxLength: number
}

/** Values read from the model's own `config.json` / `generation_config.json`. */
export const MOONSHINE_DEFAULTS: MoonshineConfig = Object.freeze({
  decoderStartTokenId: 1,
  eosTokenId: 2,
  padTokenId: 2,
  maxLength: 194,
})

export interface MoonshineSessions {
  encoder: InferenceSessionLike
  decoder: InferenceSessionLike
}

export interface MoonshineDecodeOptions {
  config?: Partial<MoonshineConfig>
  tensors: TensorFactory
  signal?: AbortSignal
}

export interface MoonshineDecodeResult {
  tokens: number[]
  avgLogProb: number | null
  /** True when the loop stopped because it hit `maxLength`, not EOS. */
  truncated: boolean
}

/** ORT input names for a merged encoder-decoder export, discovered per model. */
export interface MergedDecoderLayout {
  /** `past_key_values.<n>.decoder.key` etc., in the order the graph wants them. */
  pastNames: readonly string[]
  /** The matching `present.<n>...` output names. */
  presentNames: readonly string[]
  /** Present when the graph exposes the merged-branch switch. */
  useCacheBranchName: string | null
  encoderStatesName: string
  inputIdsName: string
  logitsName: string
}

/**
 * Work out the merged decoder's input/output names from the session itself.
 *
 * Doing this by inspection rather than by hard-coding survives an exporter
 * bump: `optimum` has changed the `present`/`past_key_values` spelling more
 * than once, and a wrong guess would surface as a confusing ORT error rather
 * than a clear one.
 */
export function describeMergedDecoder(decoder: InferenceSessionLike): MergedDecoderLayout {
  const inputs = decoder.inputNames
  const outputs = decoder.outputNames

  const pastNames = inputs.filter((name) => name.startsWith('past_key_values.'))
  // `present.N.decoder.key` ↔ `past_key_values.N.decoder.key`.
  const presentNames = pastNames.map((name) => name.replace(/^past_key_values\./, 'present.'))

  const missing = presentNames.filter((name) => !outputs.includes(name))
  if (missing.length > 0) {
    throw new Error(
      `Moonshine decoder is missing expected cache outputs: ${missing.slice(0, 3).join(', ')}` +
        `${missing.length > 3 ? ` (+${missing.length - 3} more)` : ''}`,
    )
  }

  const encoderStatesName =
    inputs.find((name) => name === 'encoder_hidden_states') ??
    inputs.find((name) => name.includes('encoder')) ??
    'encoder_hidden_states'
  const inputIdsName = inputs.find((name) => name === 'input_ids') ?? 'input_ids'
  const logitsName = outputs.find((name) => name === 'logits') ?? outputs[0] ?? 'logits'

  return {
    pastNames,
    presentNames,
    useCacheBranchName: inputs.includes('use_cache_branch') ? 'use_cache_branch' : null,
    encoderStatesName,
    inputIdsName,
    logitsName,
  }
}

/**
 * Encode raw PCM.
 *
 * @param pcm 16 kHz mono Float32, already VAD-trimmed.
 * @returns the encoder's `[1, frames, hidden]` output.
 */
export async function encodeMoonshine(
  encoder: InferenceSessionLike,
  pcm: Float32Array,
  tensors: TensorFactory,
): Promise<TensorLike> {
  const inputName = encoder.inputNames[0] ?? 'input_values'
  const feeds: Feeds = { [inputName]: tensors.float32(pcm, [1, pcm.length]) }

  // Some exports also take an attention mask; supply an all-ones one when so.
  const maskName = encoder.inputNames.find((name) => name.includes('attention_mask'))
  if (maskName) {
    feeds[maskName] = tensors.int64(new BigInt64Array(pcm.length).fill(1n), [1, pcm.length])
  }

  const outputs = await encoder.run(feeds)
  const outputName = encoder.outputNames[0] ?? 'last_hidden_state'
  const hidden = outputs[outputName] ?? Object.values(outputs)[0]
  if (!hidden) throw new Error('Moonshine encoder returned no output tensor')
  return hidden
}

/**
 * Greedy decode against the merged decoder graph.
 *
 * The empty-cache seed matters: `optimum`'s merged export still requires every
 * `past_key_values.*` input to be bound on the first pass, with a zero-length
 * sequence axis. Binding nothing produces "Missing Input", and binding
 * length-1 zeros silently corrupts attention.
 */
export async function decodeMoonshineGreedy(
  decoder: InferenceSessionLike,
  encoderStates: TensorLike,
  options: MoonshineDecodeOptions,
): Promise<MoonshineDecodeResult> {
  const config = { ...MOONSHINE_DEFAULTS, ...options.config }
  const layout = describeMergedDecoder(decoder)
  const { tensors } = options

  const tokens: number[] = []
  const logProbs: number[] = []

  let past: Record<string, TensorLike> = seedEmptyCache(layout, encoderStates, tensors)
  let useCache = false
  let nextToken = config.decoderStartTokenId
  let truncated = true

  for (let step = 0; step < config.maxLength; step += 1) {
    options.signal?.throwIfAborted()

    const feeds: Feeds = {
      [layout.inputIdsName]: tensors.int64(BigInt64Array.from([BigInt(nextToken)]), [1, 1]),
      [layout.encoderStatesName]: encoderStates,
      ...past,
    }
    if (layout.useCacheBranchName) {
      feeds[layout.useCacheBranchName] = tensors.bool(Uint8Array.of(useCache ? 1 : 0), [1])
    }

    const outputs = await decoder.run(feeds)
    const logitsTensor = outputs[layout.logitsName]
    if (!logitsTensor) throw new Error(`Moonshine decoder produced no "${layout.logitsName}"`)

    // `[1, seq, vocab]` — with one input token, `seq` is 1, but read the last
    // position explicitly so a prefill of several tokens would also work.
    const [, seq = 1, vocab = 0] = logitsTensor.dims
    const values = asFloat32(logitsTensor)
    const offset = (seq - 1) * vocab
    const token = argmax(values, offset, vocab)

    if (token === config.eosTokenId) {
      truncated = false
      break
    }

    tokens.push(token)
    logProbs.push(logSoftmaxAt(values, token, offset, vocab))

    // Hand this step's cache to the next one. The names shift from
    // `present.*` back to `past_key_values.*`.
    past = {}
    for (let index = 0; index < layout.pastNames.length; index += 1) {
      const pastName = layout.pastNames[index]
      const presentName = layout.presentNames[index]
      if (!pastName || !presentName) continue
      const tensor = outputs[presentName]
      if (tensor) past[pastName] = tensor
    }
    useCache = true
    nextToken = token
  }

  return {
    tokens,
    avgLogProb:
      logProbs.length === 0 ? null : logProbs.reduce((sum, v) => sum + v, 0) / logProbs.length,
    truncated,
  }
}

/**
 * Zero-length cache tensors for the first decoder pass.
 *
 * Decoder-side entries have shape `[batch, heads, 0, headDim]`; encoder-side
 * cross-attention entries use the encoder's own sequence length. Head counts
 * are not in the graph metadata, so they are inferred from the encoder's hidden
 * size — the only value we can see — and the sequence axis (index 2) is what
 * actually has to be 0.
 */
function seedEmptyCache(
  layout: MergedDecoderLayout,
  encoderStates: TensorLike,
  tensors: TensorFactory,
): Record<string, TensorLike> {
  const empty: Record<string, TensorLike> = {}
  for (const name of layout.pastNames) {
    // Both branches use a zero-length sequence axis on the first pass: the
    // graph's cache-less branch ignores the contents entirely.
    const dims = [Number(encoderStates.dims[0] ?? 1), 1, 0, 1]
    empty[name] = tensors.float32(new Float32Array(0), dims)
  }
  return empty
}
