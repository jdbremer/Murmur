import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  CTC_BLANK_ID,
  ctcAverageLogProb,
  decodeByteLevelTokens,
  decodeCtcGreedy,
} from '../src/main/engines/stt/onnx/ctc-decode'
import { loadTokenizer } from '../src/main/engines/stt/onnx/tokenizer'

/**
 * Greedy CTC decode and byte-level detokenisation, against real model output.
 *
 * The fixture is the argmax of actual Granite Speech 5.0 logits for a real
 * recording, captured with the checkpoint pinned. That makes this a check of
 * the *whole* back half of the pipeline — collapse, blank removal and byte
 * reassembly — against the transcript the Python reference produced, rather
 * than against my own idea of what CTC does.
 */
describe('Granite CTC decode', () => {
  const fixture = JSON.parse(
    readFileSync(join(__dirname, '__fixtures__/granite-speech/decode.json'), 'utf8'),
  ) as {
    revision: string
    blankId: number
    rawArgmax: number[]
    collapsedIds: number[]
    pieces: string[]
    text: string
  }

  const tokenizer = loadTokenizer(
    'tokenizer.json',
    readFileSync(join(__dirname, '__fixtures__/granite-speech/tokenizer.json'), 'utf8'),
  )

  /** One-hot logits that reproduce the fixture's argmax exactly. */
  function logitsFrom(argmax: readonly number[], vocabSize: number): Float32Array {
    const out = new Float32Array(argmax.length * vocabSize)
    argmax.forEach((token, frame) => {
      out[frame * vocabSize + token] = 1
    })
    return out
  }

  it('collapses the model’s own argmax to the reference token ids', () => {
    const vocabSize = tokenizer.size
    const got = decodeCtcGreedy(
      logitsFrom(fixture.rawArgmax, vocabSize),
      fixture.rawArgmax.length,
      vocabSize,
    )
    expect(got).toEqual(fixture.collapsedIds)
  })

  it('reads those ids back as the reference transcript', () => {
    expect(decodeByteLevelTokens(fixture.collapsedIds, tokenizer)).toBe(fixture.text)
  })

  it('turns 79 frames into 21 tokens, which is the whole point of the collapse', () => {
    expect(fixture.rawArgmax).toHaveLength(79)
    expect(fixture.collapsedIds).toHaveLength(21)
  })

  it('uses id 0 as the blank, as the vocabulary declares', () => {
    expect(fixture.blankId).toBe(CTC_BLANK_ID)
    expect(tokenizer.pieces.get(0)).toBe('<|blank|>')
  })
})

describe('decodeCtcGreedy', () => {
  /** `[frames][vocab]` from a list of per-frame winners. */
  const logits = (argmax: number[], vocab: number): Float32Array => {
    const out = new Float32Array(argmax.length * vocab)
    argmax.forEach((t, f) => {
      out[f * vocab + t] = 1
    })
    return out
  }

  it('drops blanks and collapses repeats', () => {
    expect(decodeCtcGreedy(logits([0, 5, 5, 0, 7, 7, 7], 8), 7, 8)).toEqual([5, 7])
  })

  it('keeps a doubled letter that a blank separates', () => {
    // The reason collapsing must happen before blanks are removed: "ll" is
    // emitted as l, blank, l, and dropping blanks first would fuse them.
    expect(decodeCtcGreedy(logits([5, 0, 5], 8), 3, 8)).toEqual([5, 5])
  })

  it('fuses a repeat with no blank between, which is one held frame', () => {
    expect(decodeCtcGreedy(logits([5, 5, 5], 8), 3, 8)).toEqual([5])
  })

  it('returns nothing for silence', () => {
    expect(decodeCtcGreedy(logits([0, 0, 0], 8), 3, 8)).toEqual([])
    expect(decodeCtcGreedy(new Float32Array(0), 0, 8)).toEqual([])
  })

  it('picks the highest logit, not the first above zero', () => {
    const frame = new Float32Array([0.1, -2, 5, 4])
    expect(decodeCtcGreedy(frame, 1, 4)).toEqual([2])
  })
})

describe('decodeByteLevelTokens', () => {
  const tokenizer = loadTokenizer(
    'tokenizer.json',
    readFileSync(join(__dirname, '__fixtures__/granite-speech/tokenizer.json'), 'utf8'),
  )

  it('reads Ġ as a leading space', () => {
    const ids = [...tokenizer.pieces].filter(([, piece]) => piece === 'Ġthe').map(([id]) => id)
    expect(ids).toHaveLength(1)
    expect(decodeByteLevelTokens([ids[0] ?? 0], tokenizer)).toBe('the')
  })

  it('skips the blank rather than rendering it', () => {
    expect(decodeByteLevelTokens([0], tokenizer)).toBe('')
  })

  it('ignores an id the vocabulary does not have', () => {
    expect(decodeByteLevelTokens([999_999], tokenizer)).toBe('')
  })

  it('returns empty for no tokens', () => {
    expect(decodeByteLevelTokens([], tokenizer)).toBe('')
  })
})

describe('ctcAverageLogProb', () => {
  it('is near zero when every frame is certain', () => {
    const confident = new Float32Array([50, 0, 0, 0, 50, 0, 0, 0])
    const value = ctcAverageLogProb(confident, 2, 4)
    expect(value).not.toBeNull()
    expect(value ?? -1).toBeGreaterThan(-0.001)
  })

  it('falls as the distribution flattens', () => {
    const flat = new Float32Array([1, 1, 1, 1])
    // Four equal options is log(1/4).
    expect(ctcAverageLogProb(flat, 1, 4) ?? 0).toBeCloseTo(Math.log(0.25), 5)
  })

  it('has nothing to report for an empty clip', () => {
    expect(ctcAverageLogProb(new Float32Array(0), 0, 16)).toBeNull()
  })
})
