import { describe, expect, it } from 'vitest'

import {
  decodeMoonshineGreedy,
  describeMergedDecoder,
  encodeMoonshine,
  MOONSHINE_DEFAULTS,
} from '../src/main/engines/stt/onnx/moonshine-decode'
import {
  createPlainTensorFactory,
  type Feeds,
  type Fetches,
  type InferenceSessionLike,
} from '../src/main/engines/stt/onnx/session'

/**
 * Moonshine encode/decode loop (PLAN §6.1, §6.2).
 *
 * Driven by a fake session that returns scripted logits, so EOS handling, the
 * merged-decoder cache hand-off and the length cap are all asserted without
 * ONNX Runtime or a 60 MB model. Real-model checks belong to the macOS CI leg.
 */

const tensors = createPlainTensorFactory()
const VOCAB = 16
const LAYERS = 2

/** Input/output names as `optimum` emits them for a merged encoder-decoder. */
function decoderNames(): { inputs: string[]; outputs: string[] } {
  const past: string[] = []
  const present: string[] = []
  for (let layer = 0; layer < LAYERS; layer += 1) {
    for (const side of ['decoder', 'encoder']) {
      for (const kind of ['key', 'value']) {
        past.push(`past_key_values.${layer}.${side}.${kind}`)
        present.push(`present.${layer}.${side}.${kind}`)
      }
    }
  }
  return {
    inputs: ['input_ids', 'encoder_hidden_states', 'use_cache_branch', ...past],
    outputs: ['logits', ...present],
  }
}

interface FakeDecoderOptions {
  /** Token argmax to return, per step. */
  script: number[]
  names?: { inputs: string[]; outputs: string[] }
}

function fakeDecoder(options: FakeDecoderOptions): InferenceSessionLike & { feeds: Feeds[] } {
  const names = options.names ?? decoderNames()
  const feeds: Feeds[] = []
  let step = 0

  const session = {
    inputNames: names.inputs,
    outputNames: names.outputs,
    feeds,
    async run(given: Feeds): Promise<Fetches> {
      feeds.push(given)
      const token = options.script[step] ?? MOONSHINE_DEFAULTS.eosTokenId
      step += 1

      const logits = new Float32Array(VOCAB).fill(-5)
      logits[token] = 5

      const out: Fetches = { logits: tensors.float32(logits, [1, 1, VOCAB]) }
      for (const name of names.outputs) {
        if (name === 'logits') continue
        // A cache tensor whose sequence axis grows by one each step, as a real
        // decoder's would.
        out[name] = tensors.float32(new Float32Array(step * 2), [1, 1, step, 2])
      }
      return out
    },
  }
  return session as InferenceSessionLike & { feeds: Feeds[] }
}

function fakeEncoder(frames = 4, hidden = 8): InferenceSessionLike & { feeds: Feeds[] } {
  const feeds: Feeds[] = []
  const session = {
    inputNames: ['input_values'],
    outputNames: ['last_hidden_state'],
    feeds,
    async run(given: Feeds): Promise<Fetches> {
      feeds.push(given)
      return {
        last_hidden_state: tensors.float32(new Float32Array(frames * hidden).fill(0.25), [
          1,
          frames,
          hidden,
        ]),
      }
    },
  }
  return session as InferenceSessionLike & { feeds: Feeds[] }
}

describe('describeMergedDecoder', () => {
  it('discovers the cache names from the session rather than hard-coding them', () => {
    const layout = describeMergedDecoder(fakeDecoder({ script: [] }))
    expect(layout.pastNames).toHaveLength(LAYERS * 4)
    expect(layout.presentNames[0]).toBe('present.0.decoder.key')
    expect(layout.useCacheBranchName).toBe('use_cache_branch')
    expect(layout.encoderStatesName).toBe('encoder_hidden_states')
    expect(layout.logitsName).toBe('logits')
  })

  it('tolerates an export with no use_cache_branch input', () => {
    const names = decoderNames()
    names.inputs = names.inputs.filter((name) => name !== 'use_cache_branch')
    const layout = describeMergedDecoder(fakeDecoder({ script: [], names }))
    expect(layout.useCacheBranchName).toBeNull()
  })

  it('fails loudly when the cache outputs do not match the inputs', () => {
    const names = decoderNames()
    names.outputs = ['logits']
    expect(() => describeMergedDecoder(fakeDecoder({ script: [], names }))).toThrow(
      /missing expected cache outputs/,
    )
  })
})

describe('encodeMoonshine', () => {
  it('feeds raw PCM straight in — there is no mel front-end', async () => {
    const encoder = fakeEncoder()
    const pcm = new Float32Array([0.1, -0.2, 0.3, -0.4])
    const output = await encodeMoonshine(encoder, pcm, tensors)

    const fed = encoder.feeds[0]!['input_values']!
    expect(fed.dims).toEqual([1, 4])
    expect(Array.from(fed.data as Float32Array)).toEqual(
      [0.1, -0.2, 0.3, -0.4].map((value) => Math.fround(value)),
    )
    expect(output.dims).toEqual([1, 4, 8])
  })

  it('supplies an attention mask when the export asks for one', async () => {
    const encoder = fakeEncoder()
    ;(encoder as unknown as { inputNames: string[] }).inputNames = [
      'input_values',
      'attention_mask',
    ]
    await encodeMoonshine(encoder, new Float32Array(3), tensors)

    const mask = encoder.feeds[0]!['attention_mask']!
    expect(mask.dims).toEqual([1, 3])
    expect(Array.from(mask.data as BigInt64Array)).toEqual([1n, 1n, 1n])
  })
})

describe('decodeMoonshineGreedy', () => {
  const encoderStates = tensors.float32(new Float32Array(32).fill(0.25), [1, 4, 8])

  it('decodes greedily and stops at EOS without emitting it', async () => {
    const decoder = fakeDecoder({ script: [7, 8, 9, MOONSHINE_DEFAULTS.eosTokenId] })
    const result = await decodeMoonshineGreedy(decoder, encoderStates, { tensors })

    expect(result.tokens).toEqual([7, 8, 9])
    expect(result.truncated).toBe(false)
    expect(result.avgLogProb).toBeLessThan(0)
  })

  it('seeds the first step with decoder_start_token_id and an empty cache', async () => {
    const decoder = fakeDecoder({ script: [7, MOONSHINE_DEFAULTS.eosTokenId] })
    await decodeMoonshineGreedy(decoder, encoderStates, { tensors })

    const first = decoder.feeds[0]!
    expect(Array.from(first['input_ids']!.data as BigInt64Array)).toEqual([
      BigInt(MOONSHINE_DEFAULTS.decoderStartTokenId),
    ])
    expect(Array.from(first['use_cache_branch']!.data as Uint8Array)).toEqual([0])

    // Every past-KV input must be bound, with a zero-length sequence axis.
    const past = Object.keys(first).filter((name) => name.startsWith('past_key_values.'))
    expect(past).toHaveLength(LAYERS * 4)
    for (const name of past) {
      expect(first[name]!.dims[2]).toBe(0)
      expect(first[name]!.data.length).toBe(0)
    }
  })

  it('hands each step present.* cache to the next as past_key_values.*', async () => {
    const decoder = fakeDecoder({ script: [7, 8, MOONSHINE_DEFAULTS.eosTokenId] })
    await decodeMoonshineGreedy(decoder, encoderStates, { tensors })

    const second = decoder.feeds[1]!
    expect(Array.from(second['use_cache_branch']!.data as Uint8Array)).toEqual([1])
    // Step 1 returned caches with a sequence axis of 1; step 2 must receive them.
    expect(second['past_key_values.0.decoder.key']!.dims[2]).toBe(1)
    expect(second['past_key_values.1.encoder.value']!.dims[2]).toBe(1)
  })

  it('feeds the previous token back in on each step', async () => {
    const decoder = fakeDecoder({ script: [11, 12, MOONSHINE_DEFAULTS.eosTokenId] })
    await decodeMoonshineGreedy(decoder, encoderStates, { tensors })

    expect(Array.from(decoder.feeds[1]!['input_ids']!.data as BigInt64Array)).toEqual([11n])
    expect(Array.from(decoder.feeds[2]!['input_ids']!.data as BigInt64Array)).toEqual([12n])
  })

  it('stops at maxLength and reports truncation', async () => {
    // Never emits EOS.
    const decoder = fakeDecoder({ script: Array.from({ length: 100 }, () => 3) })
    const result = await decodeMoonshineGreedy(decoder, encoderStates, {
      tensors,
      config: { maxLength: 5 },
    })

    expect(result.tokens).toHaveLength(5)
    expect(result.truncated).toBe(true)
  })

  it('returns nothing when the very first token is EOS', async () => {
    const decoder = fakeDecoder({ script: [MOONSHINE_DEFAULTS.eosTokenId] })
    const result = await decodeMoonshineGreedy(decoder, encoderStates, { tensors })

    expect(result.tokens).toEqual([])
    expect(result.avgLogProb).toBeNull()
    expect(result.truncated).toBe(false)
  })

  it('honours config overrides read from the model files', async () => {
    const decoder = fakeDecoder({ script: [4, 5, 13] })
    const result = await decodeMoonshineGreedy(decoder, encoderStates, {
      tensors,
      config: { decoderStartTokenId: 2, eosTokenId: 13 },
    })

    expect(Array.from(decoder.feeds[0]!['input_ids']!.data as BigInt64Array)).toEqual([2n])
    expect(result.tokens).toEqual([4, 5])
  })

  it('respects an abort signal', async () => {
    const controller = new AbortController()
    controller.abort()
    const decoder = fakeDecoder({ script: [1, 2, 3] })

    await expect(
      decodeMoonshineGreedy(decoder, encoderStates, { tensors, signal: controller.signal }),
    ).rejects.toThrow()
  })

  it('reads the last position when the decoder returns several', async () => {
    // A prefill of three positions: only the last one's argmax may be taken.
    const session = {
      inputNames: decoderNames().inputs,
      outputNames: decoderNames().outputs,
      async run(): Promise<Fetches> {
        const logits = new Float32Array(3 * VOCAB).fill(-5)
        logits[0 * VOCAB + 1] = 9 // position 0 → token 1 (must be ignored)
        logits[1 * VOCAB + 2] = 9 // position 1 → token 2 (must be ignored)
        logits[2 * VOCAB + MOONSHINE_DEFAULTS.eosTokenId] = 9 // last → EOS
        const out: Fetches = { logits: tensors.float32(logits, [1, 3, VOCAB]) }
        for (const name of decoderNames().outputs) {
          if (name !== 'logits') out[name] = tensors.float32(new Float32Array(2), [1, 1, 1, 2])
        }
        return out
      },
    } as unknown as InferenceSessionLike

    const result = await decodeMoonshineGreedy(session, encoderStates, { tensors })
    expect(result.tokens).toEqual([])
  })

  it('throws when the decoder produces no logits', async () => {
    const session = {
      inputNames: decoderNames().inputs,
      outputNames: decoderNames().outputs,
      async run(): Promise<Fetches> {
        const out: Fetches = {}
        for (const name of decoderNames().outputs) {
          if (name !== 'logits') out[name] = tensors.float32(new Float32Array(2), [1, 1, 1, 2])
        }
        return out
      },
    } as unknown as InferenceSessionLike

    await expect(decodeMoonshineGreedy(session, encoderStates, { tensors })).rejects.toThrow(
      /produced no "logits"/,
    )
  })
})

/** The values in MOONSHINE_DEFAULTS come from the released config files. */
describe('MOONSHINE_DEFAULTS', () => {
  it('matches moonshine-ai/moonshine-{base,tiny} config.json', () => {
    expect(MOONSHINE_DEFAULTS).toEqual({
      decoderStartTokenId: 1,
      eosTokenId: 2,
      padTokenId: 2,
      maxLength: 194,
    })
  })
})
