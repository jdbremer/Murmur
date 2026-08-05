import { describe, expect, it } from 'vitest'

import {
  decodeTdtGreedy,
  PARAKEET_DURATIONS,
  type PredictorState,
  type PredictorStep,
  type TdtSteppers,
} from '../src/main/engines/stt/onnx/tdt-decode'
import { createPlainTensorFactory, type TensorLike } from '../src/main/engines/stt/onnx/session'

/**
 * Parakeet TDT greedy decode (PLAN §6.1, §16).
 *
 * The loop is validated against *scripted* joint outputs rather than a real
 * model: every behaviour worth getting wrong — blank handling, the duration
 * skip, and the two termination guards — is a property of the arithmetic, not
 * of the weights. Real-model parity against NVIDIA reference transcripts is a
 * macOS-CI job and is described in `scripts/models/export-parakeet.md`; the
 * fixture hook is `steppers`, which a fixture file drops straight into.
 */

const VOCAB = 5
const BLANK = VOCAB // index 5; token logits are 0..5 inclusive
const tensors = createPlainTensorFactory()

/** `[1, frames, hidden]` encoder output; contents are irrelevant to the loop. */
function encoderOutput(frames: number, hidden = 4): TensorLike {
  return tensors.float32(new Float32Array(frames * hidden).fill(0.1), [1, frames, hidden])
}

/** One joint output: peak `token`, peak duration bin `durationIndex`. */
function jointLogits(token: number, durationIndex: number): TensorLike {
  const values = new Float32Array(VOCAB + 1 + PARAKEET_DURATIONS.length).fill(-10)
  values[token] = 10
  values[VOCAB + 1 + durationIndex] = 10
  return tensors.float32(values, [1, 1, values.length])
}

interface Script {
  /** One entry per joint() call, in order. */
  steps: { token: number; durationIndex: number }[]
}

/** A steppers double that replays `script` and records what it was asked. */
function scriptedSteppers(script: Script): TdtSteppers & {
  predictorCalls: (number | null)[]
  jointCalls: number
} {
  let index = 0
  const predictorCalls: (number | null)[] = []
  let jointCalls = 0

  const steppers = {
    predictorCalls,
    get jointCalls() {
      return jointCalls
    },
    async predictor(label: number | null, state: PredictorState | null): Promise<PredictorStep> {
      predictorCalls.push(label)
      return {
        output: tensors.float32(new Float32Array([label ?? -1]), [1, 1, 1]),
        // A real predictor threads its LSTM state; the loop only has to pass it
        // through unchanged, so a counter is enough to prove it does.
        state: { step: tensors.float32(new Float32Array([(state ? 1 : 0) + index]), [1]) },
      }
    },
    async joint(): Promise<TensorLike> {
      const step = script.steps[Math.min(index, script.steps.length - 1)]
      index += 1
      jointCalls += 1
      // Past the end of the script, emit blank with duration 1 so the loop can
      // always drain the remaining frames.
      if (!step) return jointLogits(BLANK, 1)
      return jointLogits(step.token, step.durationIndex)
    },
  }
  return steppers as TdtSteppers & { predictorCalls: (number | null)[]; jointCalls: number }
}

describe('decodeTdtGreedy — blank handling', () => {
  it('emits nothing when every frame is blank', async () => {
    const steppers = scriptedSteppers({
      steps: Array.from({ length: 8 }, () => ({ token: BLANK, durationIndex: 1 })),
    })
    const result = await decodeTdtGreedy(encoderOutput(8), steppers, { vocabSize: VOCAB })

    expect(result.tokens).toEqual([])
    expect(result.avgLogProb).toBeNull()
    expect(result.framesConsumed).toBe(8)
  })

  it('never emits the blank index as a token', async () => {
    const steppers = scriptedSteppers({
      steps: [
        { token: 2, durationIndex: 1 },
        { token: BLANK, durationIndex: 1 },
        { token: 3, durationIndex: 1 },
        { token: BLANK, durationIndex: 1 },
      ],
    })
    const result = await decodeTdtGreedy(encoderOutput(4), steppers, { vocabSize: VOCAB })
    expect(result.tokens).toEqual([2, 3])
    expect(result.tokens).not.toContain(BLANK)
  })

  it('does not advance the predictor label on a blank', async () => {
    const steppers = scriptedSteppers({
      steps: [
        { token: 4, durationIndex: 1 },
        { token: BLANK, durationIndex: 1 },
        { token: BLANK, durationIndex: 1 },
      ],
    })
    await decodeTdtGreedy(encoderOutput(3), steppers, { vocabSize: VOCAB })

    // First call has no label; after emitting 4, every later call carries 4 —
    // blanks leave the prediction network where it was.
    expect(steppers.predictorCalls).toEqual([null, 4, 4])
  })
})

describe('decodeTdtGreedy — duration-skip semantics', () => {
  it('skips `duration` encoder frames per step', async () => {
    // durationIndex 4 → PARAKEET_DURATIONS[4] === 4 frames.
    const steppers = scriptedSteppers({
      steps: [
        { token: 1, durationIndex: 4 },
        { token: 2, durationIndex: 4 },
      ],
    })
    const result = await decodeTdtGreedy(encoderOutput(8), steppers, { vocabSize: VOCAB })

    expect(result.tokens).toEqual([1, 2])
    // Two joint calls covered eight frames — this is why TDT is fast.
    expect(steppers.jointCalls).toBe(2)
    expect(result.framesConsumed).toBe(8)
  })

  it('emits several tokens on one frame when the duration is 0', async () => {
    const steppers = scriptedSteppers({
      steps: [
        { token: 1, durationIndex: 0 }, // stay on frame 0
        { token: 2, durationIndex: 0 }, // still frame 0
        { token: 3, durationIndex: 1 }, // now move on
        { token: BLANK, durationIndex: 1 },
      ],
    })
    const result = await decodeTdtGreedy(encoderOutput(2), steppers, { vocabSize: VOCAB })
    expect(result.tokens).toEqual([1, 2, 3])
  })

  it('forces time forward after maxSymbolsPerStep zero-duration emissions', async () => {
    // A model stuck emitting the same token with duration 0 forever would loop.
    const steppers = scriptedSteppers({
      steps: Array.from({ length: 200 }, () => ({ token: 1, durationIndex: 0 })),
    })
    const result = await decodeTdtGreedy(encoderOutput(3), steppers, {
      vocabSize: VOCAB,
      maxSymbolsPerStep: 4,
    })

    // 3 frames × 4 symbols each before the guard advances time.
    expect(result.tokens).toHaveLength(12)
    expect(result.framesConsumed).toBe(3)
  })

  it('advances time on a blank with duration 0, so it cannot stall', async () => {
    const steppers = scriptedSteppers({
      steps: Array.from({ length: 50 }, () => ({ token: BLANK, durationIndex: 0 })),
    })
    const result = await decodeTdtGreedy(encoderOutput(5), steppers, { vocabSize: VOCAB })

    expect(result.tokens).toEqual([])
    // One frame per blank, not an infinite loop.
    expect(steppers.jointCalls).toBe(5)
  })

  it('honours a non-default duration set', async () => {
    const steppers = scriptedSteppers({
      steps: [{ token: 1, durationIndex: 1 }],
    })
    const result = await decodeTdtGreedy(encoderOutput(8), steppers, {
      vocabSize: VOCAB,
      durations: [0, 8],
    })
    // One step of duration 8 consumes the whole encoder output.
    expect(steppers.jointCalls).toBe(1)
    expect(result.framesConsumed).toBe(8)
  })
})

describe('decodeTdtGreedy — bookkeeping', () => {
  it('reports the mean log-probability of the emitted tokens', async () => {
    const steppers = scriptedSteppers({
      steps: [
        { token: 1, durationIndex: 1 },
        { token: 2, durationIndex: 1 },
      ],
    })
    const result = await decodeTdtGreedy(encoderOutput(2), steppers, { vocabSize: VOCAB })

    expect(result.avgLogProb).not.toBeNull()
    // Peak logit 10 against five at −10: log-softmax is very close to 0.
    expect(result.avgLogProb!).toBeLessThan(0)
    expect(result.avgLogProb!).toBeGreaterThan(-0.01)
  })

  it('stops at maxTokens rather than running away', async () => {
    const steppers = scriptedSteppers({
      steps: Array.from({ length: 500 }, () => ({ token: 1, durationIndex: 0 })),
    })
    const result = await decodeTdtGreedy(encoderOutput(100), steppers, {
      vocabSize: VOCAB,
      maxTokens: 7,
    })
    expect(result.tokens).toHaveLength(7)
  })

  it('returns immediately for an empty encoder output', async () => {
    const steppers = scriptedSteppers({ steps: [] })
    const result = await decodeTdtGreedy(encoderOutput(0), steppers, { vocabSize: VOCAB })
    expect(result.tokens).toEqual([])
    expect(steppers.jointCalls).toBe(0)
  })

  it('throws a clear error when the joint output is too narrow', async () => {
    const steppers: TdtSteppers = {
      async predictor() {
        return {
          output: tensors.float32(new Float32Array([0]), [1, 1, 1]),
          state: {},
        }
      },
      async joint() {
        // Vocabulary + blank, but no duration head at all.
        return tensors.float32(new Float32Array(VOCAB + 1), [1, 1, VOCAB + 1])
      },
    }

    await expect(decodeTdtGreedy(encoderOutput(2), steppers, { vocabSize: VOCAB })).rejects.toThrow(
      /expected at least/,
    )
  })

  it('respects an abort signal', async () => {
    const controller = new AbortController()
    const steppers = scriptedSteppers({
      steps: Array.from({ length: 100 }, () => ({ token: 1, durationIndex: 1 })),
    })
    controller.abort()

    await expect(
      decodeTdtGreedy(encoderOutput(100), steppers, {
        vocabSize: VOCAB,
        signal: controller.signal,
      }),
    ).rejects.toThrow()
  })
})
