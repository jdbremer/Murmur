import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { createPlainTensorFactory, type TensorLike } from '../src/main/engines/stt/onnx/session'
import {
  decodeTdtGreedy,
  type PredictorState,
  type PredictorStep,
} from '../src/main/engines/stt/onnx/tdt-decode'
import { decodeTokens, loadTokenizer } from '../src/main/engines/stt/onnx/tokenizer'

/**
 * Decode parity against the real model (PLAN §6.1, §16;
 * `scripts/models/export-parakeet.md` step 4).
 *
 * `tdt-decode.test.ts` scripts the joint by hand, which proves the arithmetic
 * is self-consistent but says nothing about whether it matches what Parakeet
 * actually does. These fixtures are the missing half: the real decisions the
 * exported model made — which token, which duration bin, at every joint call —
 * captured from four utterances whose transcripts were verified 10/10 against
 * `transformers`' own `generate()`.
 *
 * Replaying them exercises the parts of the loop that a hand-written script is
 * least likely to stress: real transducers emit long runs of blanks with
 * varying duration skips, occasionally several tokens on one frame, and the
 * arithmetic has to land on exactly the right frame count at the end.
 * `framesConsumed` is the sharpest assertion here — a duration-skip that is
 * off by one still produces plausible text, but cannot end on the right frame.
 *
 * What this deliberately does *not* cover: argmax over real logits, and the
 * log-probability arithmetic. Both need full 8198-wide logit vectors per step,
 * which would be megabytes of fixture; both are already covered by the live
 * run recorded in the export guide.
 */

const DIR = join(__dirname, '__fixtures__/parakeet')

interface Fixture {
  source: string
  vocabSize: number
  blankTokenId: number
  durations: number[]
  maxSymbolsPerStep: number
  utterances: {
    audio: string
    encoderFrames: number
    steps: { token: number; durationIndex: number }[]
    expectedTokens: number[]
    expectedText: string
  }[]
}

const fixture = JSON.parse(readFileSync(join(DIR, 'decode.json'), 'utf8')) as Fixture
const tensors = createPlainTensorFactory()

/**
 * Rebuild a joint output that peaks where the real model peaked.
 *
 * The recorded argmaxes are what the loop consumes, so a one-hot reconstruction
 * drives it down exactly the path the real model took. The magnitudes are
 * arbitrary — only the positions of the two maxima matter.
 */
function jointLogits(token: number, durationIndex: number): TensorLike {
  const width = fixture.vocabSize + 1 + fixture.durations.length
  const values = new Float32Array(width).fill(-10)
  values[token] = 10
  values[fixture.vocabSize + 1 + durationIndex] = 10
  return tensors.float32(values, [1, 1, width])
}

describe('Parakeet decode parity', () => {
  it('pins the checkpoint constants the fixtures were captured against', () => {
    // If a future export moves any of these, the recorded step sequences no
    // longer describe the same model and the fixtures must be recaptured.
    expect(fixture.blankTokenId).toBe(fixture.vocabSize)
    expect(fixture.durations).toEqual([0, 1, 2, 3, 4])
    expect(fixture.maxSymbolsPerStep).toBe(10)
    expect(fixture.source).toContain('parakeet-tdt-0.6b-v3')
    expect(fixture.utterances.length).toBeGreaterThanOrEqual(4)
  })

  for (const utterance of fixture.utterances) {
    it(`reproduces the real decode of ${utterance.audio}`, async () => {
      let call = 0
      const result = await decodeTdtGreedy(
        tensors.float32(new Float32Array(utterance.encoderFrames * 4), [
          1,
          utterance.encoderFrames,
          4,
        ]),
        {
          async predictor(label: number | null): Promise<PredictorStep> {
            return {
              output: tensors.float32(new Float32Array([label ?? -1]), [1, 1, 1]),
              state: {} satisfies PredictorState,
            }
          },
          async joint(): Promise<TensorLike> {
            const step = utterance.steps[call]
            // Running past the recorded steps means the loop consumed frames
            // differently from the real model — the failure worth catching.
            expect(
              step,
              `joint call ${call} is past the recorded ${utterance.steps.length}`,
            ).toBeDefined()
            call += 1
            return jointLogits(step?.token ?? fixture.blankTokenId, step?.durationIndex ?? 1)
          },
        },
        {
          vocabSize: fixture.vocabSize,
          durations: fixture.durations,
          maxSymbolsPerStep: fixture.maxSymbolsPerStep,
        },
      )

      expect(result.tokens).toEqual(utterance.expectedTokens)
      // The duration arithmetic has to land exactly, not approximately.
      expect(call).toBe(utterance.steps.length)
      expect(result.framesConsumed).toBe(utterance.encoderFrames)
    })
  }

  it('detokenises the real token ids back to the real transcript', () => {
    // Validates the SentencePiece handling — the `▁` word marker and the
    // leading-space strip — against ids a real model emitted, and validates
    // that `loadTokenizer` accepts the piece-array vocabulary our own export
    // writes rather than only HuggingFace's `tokenizer.json` shape.
    const tokenizer = loadTokenizer('vocab.json', readFileSync(join(DIR, 'vocab.json'), 'utf8'))
    expect(tokenizer.size).toBeGreaterThan(8_000)

    for (const utterance of fixture.utterances) {
      expect(decodeTokens(tokenizer, utterance.expectedTokens).trim()).toBe(utterance.expectedText)
    }
  })
})
