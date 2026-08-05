import { describe, expect, it } from 'vitest'

import { detectFamily } from '../src/main/engines/stt/onnx/protocol'
import { loadOnnxRuntime, resetOnnxRuntimeCache } from '../src/main/engines/stt/onnx/runtime'
import {
  argmax,
  asFloat32,
  createPlainTensorFactory,
  elementCount,
  logSoftmaxAt,
  sliceStep,
} from '../src/main/engines/stt/onnx/session'
import {
  decodeTokens,
  loadTokenizer,
  tokenizerFromHuggingFace,
  tokenizerFromVocabText,
} from '../src/main/engines/stt/onnx/tokenizer'

/**
 * Supporting pieces of the ONNX Runtime path: tensor helpers, the optional
 * runtime loader, and the SentencePiece detokeniser.
 *
 * The tokenizer tests encode the *actual* decoder pipeline Moonshine's
 * `tokenizer.json` declares — Replace(▁→" ") → ByteFallback → Fuse → Strip —
 * which was read off the released file rather than assumed.
 */

const tensors = createPlainTensorFactory()

describe('tensor helpers', () => {
  it('counts elements from dims', () => {
    expect(elementCount([1, 2, 3])).toBe(6)
    expect(elementCount([])).toBe(1)
  })

  it('passes Float32Array through without copying', () => {
    const data = new Float32Array([1, 2, 3])
    expect(asFloat32({ type: 'float32', data, dims: [3] })).toBe(data)
  })

  it('widens integer tensors, including BigInt64', () => {
    expect(
      Array.from(asFloat32({ type: 'int32', data: new Int32Array([1, 2]), dims: [2] })),
    ).toEqual([1, 2])
    expect(
      Array.from(asFloat32({ type: 'int64', data: BigInt64Array.from([5n, 9n]), dims: [2] })),
    ).toEqual([5, 9])
  })

  it('finds the argmax, resolving ties to the lowest index like NumPy', () => {
    expect(argmax(new Float32Array([1, 5, 3]))).toBe(1)
    expect(argmax(new Float32Array([5, 5, 1]))).toBe(0)
    expect(argmax(new Float32Array([0, 0, 9, 1]), 1, 2)).toBe(1) // window [0, 9]
  })

  it('computes a stable log-softmax', () => {
    // Two equal logits: each has probability 0.5, so log p = ln(0.5).
    expect(logSoftmaxAt(new Float32Array([2, 2]), 0)).toBeCloseTo(Math.log(0.5), 6)
    // Very large logits must not overflow.
    expect(Number.isFinite(logSoftmaxAt(new Float32Array([1e5, 1e5 - 1]), 0))).toBe(true)
  })

  it('slices one step out of a [batch, steps, features] tensor', () => {
    const tensor = tensors.float32(Float32Array.from([1, 2, 3, 4, 5, 6]), [1, 3, 2])
    expect(Array.from(sliceStep(tensor, 0))).toEqual([1, 2])
    expect(Array.from(sliceStep(tensor, 2))).toEqual([5, 6])
  })

  it('rejects an out-of-range step or batch', () => {
    const tensor = tensors.float32(new Float32Array(6), [1, 3, 2])
    expect(() => sliceStep(tensor, 3)).toThrow(RangeError)
    expect(() => sliceStep(tensor, 0, { batch: 2 })).toThrow(RangeError)
  })
})

describe('loadOnnxRuntime', () => {
  it('reports runtime-missing cleanly rather than throwing', () => {
    // `onnxruntime-node` is an optionalDependency whose postinstall needs the
    // network, so it is legitimately absent on this container. Whichever way it
    // lands, the loader must return data — never throw.
    resetOnnxRuntimeCache()
    const result = loadOnnxRuntime()

    if (result.ok) {
      expect(typeof result.createSession).toBe('function')
      expect(typeof result.tensors.float32).toBe('function')
    } else {
      expect(result.reason).toBe('runtime-missing')
      // The message must tell the user Whisper still works.
      expect(result.detail).toContain('Whisper models are unaffected')
    }
  })

  it('caches the result', () => {
    resetOnnxRuntimeCache()
    expect(loadOnnxRuntime()).toBe(loadOnnxRuntime())
  })
})

describe('detectFamily', () => {
  it('recognises a Moonshine bundle by its merged decoder', () => {
    expect(
      detectFamily(['encoder_model.onnx', 'decoder_model_merged.onnx', 'tokenizer.json']),
    ).toBe('moonshine')
  })

  it('recognises a transducer bundle by its joiner', () => {
    expect(
      detectFamily(['encoder-model.onnx', 'decoder-model.onnx', 'joiner-model.onnx', 'vocab.txt']),
    ).toBe('parakeet-tdt')
  })

  it('returns null for anything it does not know', () => {
    expect(detectFamily(['model.gguf'])).toBeNull()
    expect(detectFamily([])).toBeNull()
  })
})

describe('tokenizer', () => {
  /** A miniature version of the real Moonshine tokenizer.json shape. */
  const huggingFaceFile = {
    added_tokens: [
      { id: 0, content: '<unk>', special: true },
      { id: 1, content: '<s>', special: true },
      { id: 2, content: '</s>', special: true },
    ],
    model: {
      type: 'BPE',
      vocab: {
        '<unk>': 0,
        '<s>': 1,
        '</s>': 2,
        '<0xC3>': 3,
        '<0xA9>': 4,
        '▁hello': 5,
        '▁world': 6,
        ',': 7,
        '▁caf': 8,
        '▁': 9,
      },
    },
  }

  it('loads a HuggingFace vocabulary and its special tokens', () => {
    const tokenizer = tokenizerFromHuggingFace(huggingFaceFile)
    expect(tokenizer.size).toBe(10)
    expect(tokenizer.specialIds.has(1)).toBe(true)
    expect(tokenizer.pieces.get(5)).toBe('▁hello')
  })

  it('replaces the metaspace with a real space and strips the leading one', () => {
    const tokenizer = tokenizerFromHuggingFace(huggingFaceFile)
    // ▁hello ▁world , → "hello world,"
    expect(decodeTokens(tokenizer, [5, 6, 7])).toBe('hello world,')
  })

  it('fuses byte-fallback tokens into one character', () => {
    const tokenizer = tokenizerFromHuggingFace(huggingFaceFile)
    // "caf" + 0xC3 0xA9 → "café" (é is two UTF-8 bytes, two tokens).
    expect(decodeTokens(tokenizer, [8, 3, 4])).toBe('café')
  })

  it('skips special tokens by default and keeps them on request', () => {
    const tokenizer = tokenizerFromHuggingFace(huggingFaceFile)
    expect(decodeTokens(tokenizer, [1, 5, 6, 2])).toBe('hello world')
    expect(decodeTokens(tokenizer, [1, 5, 2], { skipSpecialTokens: false })).toContain('<s>')
  })

  it('can be told not to strip the leading space', () => {
    const tokenizer = tokenizerFromHuggingFace(huggingFaceFile)
    expect(decodeTokens(tokenizer, [5], { stripLeadingSpace: false })).toBe(' hello')
  })

  it('ignores unknown ids rather than emitting a placeholder', () => {
    const tokenizer = tokenizerFromHuggingFace(huggingFaceFile)
    expect(decodeTokens(tokenizer, [5, 9999, 6])).toBe('hello world')
  })

  it('handles an empty token list', () => {
    const tokenizer = tokenizerFromHuggingFace(huggingFaceFile)
    expect(decodeTokens(tokenizer, [])).toBe('')
  })

  it('reads a unigram-style array vocabulary', () => {
    const tokenizer = tokenizerFromHuggingFace({
      model: {
        vocab: [
          ['<unk>', 0],
          ['▁hi', -1],
        ],
      },
    })
    expect(tokenizer.pieces.get(1)).toBe('▁hi')
    expect(decodeTokens(tokenizer, [1])).toBe('hi')
  })

  it('throws on a tokenizer file with no vocabulary', () => {
    expect(() => tokenizerFromHuggingFace({ model: {} })).toThrow(/no vocabulary/)
  })

  it('reads a NeMo-style vocab.txt keyed by line number', () => {
    const tokenizer = tokenizerFromVocabText('<unk>\n▁the\n▁quick\n▁fox\n')
    expect(tokenizer.size).toBe(4)
    expect(decodeTokens(tokenizer, [1, 2, 3])).toBe('the quick fox')
  })

  it('rejects an empty vocab.txt', () => {
    expect(() => tokenizerFromVocabText('')).toThrow(/empty/)
  })

  it('picks the loader from the file name', () => {
    expect(loadTokenizer('vocab.txt', 'a\nb\n').size).toBe(2)
    expect(loadTokenizer('tokenizer.json', JSON.stringify(huggingFaceFile)).size).toBe(10)
  })
})
