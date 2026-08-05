import { argmax, asFloat32, logSoftmaxAt, sliceStep, type TensorLike } from './session'

/**
 * Greedy decoding for NVIDIA's **Token-and-Duration Transducer** (TDT), the
 * decoder behind Parakeet-TDT (PLAN §6.1, §16 "In-house Parakeet decode loop").
 *
 * ## What a TDT is, in one paragraph
 *
 * A classic RNN-T emits, at each (audio frame *t*, label position *u*), either
 * a token — which advances *u* — or a blank, which advances *t* by exactly one
 * frame. TDT extends the joint network's output with a second head that
 * predicts a **duration**: how many frames to skip after this emission. So the
 * joint produces `V + 1 + D` logits, where the first `V + 1` are the vocabulary
 * plus blank and the last `D` are a distribution over a fixed duration set
 * (Parakeet uses `[0, 1, 2, 3, 4]`). Skipping several frames at once is why
 * Parakeet is fast: most frames are never scored at all.
 *
 * ## The three rules that make it terminate
 *
 * The duration head can legally predict 0, which means "stay on this frame and
 * emit again". Left alone that is an infinite loop, so every reference
 * implementation (NeMo's `GreedyTDTInfer` included) adds guards, and getting
 * them wrong is the classic way this loop goes subtly bad:
 *
 *  1. **A non-zero duration always advances time.** `t += duration`.
 *  2. **A zero duration counts a symbol against a per-frame budget.** After
 *     {@link TdtDecodeOptions.maxSymbolsPerStep} symbols at the same `t`, time
 *     is force-advanced by one frame and the counter resets.
 *  3. **A blank with duration 0 advances time by one anyway.** Otherwise the
 *     model can sit on a frame emitting nothing forever.
 *
 * ## Why it is written like this
 *
 * The loop takes an injected {@link TdtSteppers} rather than sessions, so the
 * whole thing unit-tests against synthetic logits: blank handling, the
 * duration-skip arithmetic and the two termination guards are all assertable
 * without ONNX Runtime, a model file or audio. Real-model validation against
 * NVIDIA reference transcripts happens on the macOS CI leg — see
 * `scripts/models/export-parakeet.md`.
 */

/** Parakeet-TDT's duration bins, in encoder frames. */
export const PARAKEET_DURATIONS: readonly number[] = Object.freeze([0, 1, 2, 3, 4])

/** Opaque prediction-network state, threaded through unchanged. */
export type PredictorState = Readonly<Record<string, TensorLike>>

export interface PredictorStep {
  /** `[1, 1, hidden]` prediction-network output for the current label. */
  output: TensorLike
  state: PredictorState
}

/**
 * What the loop needs from the model, split into the two graphs a transducer
 * export actually has.
 */
export interface TdtSteppers {
  /**
   * Run the prediction network for `label` (or the SOS/blank when `null`),
   * continuing from `state`.
   */
  predictor(label: number | null, state: PredictorState | null): Promise<PredictorStep>
  /**
   * Run the joint network for one encoder frame and one predictor output.
   * Must return a tensor whose last dimension is `vocabSize + 1 + durations.length`.
   */
  joint(encoderFrame: Float32Array, predictorOutput: TensorLike): Promise<TensorLike>
}

export interface TdtDecodeOptions {
  /** Vocabulary size *excluding* blank. Blank is index `vocabSize`. */
  vocabSize: number
  /** Duration bins, in frames. Defaults to {@link PARAKEET_DURATIONS}. */
  durations?: readonly number[]
  /** Emissions allowed at one time step before time is forced forward. */
  maxSymbolsPerStep?: number
  /** Hard ceiling on emitted tokens, so a broken model cannot run forever. */
  maxTokens?: number
  signal?: AbortSignal
}

export interface TdtDecodeResult {
  /** Emitted token ids, in order. Blank is never included. */
  tokens: number[]
  /** Mean log-probability of the emitted tokens; `null` when nothing was emitted. */
  avgLogProb: number | null
  /** Encoder frames consumed — useful for spotting a loop that stalled. */
  framesConsumed: number
}

const DEFAULT_MAX_SYMBOLS_PER_STEP = 10

/**
 * Greedy TDT decode over an encoder output tensor of `[1, frames, hidden]`.
 *
 * @param encoderOutput Encoder states, batch size 1.
 * @param steppers Prediction + joint networks.
 */
export async function decodeTdtGreedy(
  encoderOutput: TensorLike,
  steppers: TdtSteppers,
  options: TdtDecodeOptions,
): Promise<TdtDecodeResult> {
  const durations = options.durations ?? PARAKEET_DURATIONS
  const maxSymbolsPerStep = options.maxSymbolsPerStep ?? DEFAULT_MAX_SYMBOLS_PER_STEP
  const blankIndex = options.vocabSize
  const tokenLogitCount = options.vocabSize + 1
  const [, frameCount = 0] = encoderOutput.dims
  const maxTokens = options.maxTokens ?? Math.max(64, frameCount * 4)

  const tokens: number[] = []
  const logProbs: number[] = []

  let time = 0
  let symbolsAtStep = 0
  let lastLabel: number | null = null
  let state: PredictorState | null = null

  while (time < frameCount && tokens.length < maxTokens) {
    options.signal?.throwIfAborted()

    const encoderFrame = sliceStep(encoderOutput, time)
    const prediction = await steppers.predictor(lastLabel, state)
    const jointOutput = await steppers.joint(encoderFrame, prediction.output)
    const logits = asFloat32(jointOutput)

    if (logits.length < tokenLogitCount + durations.length) {
      throw new Error(
        `TDT joint returned ${logits.length} logits; expected at least ` +
          `${tokenLogitCount + durations.length} (vocab ${options.vocabSize} + blank + ` +
          `${durations.length} durations)`,
      )
    }

    // Head 1: vocabulary + blank.
    const token = argmax(logits, 0, tokenLogitCount)
    // Head 2: duration bins, which start immediately after the token head.
    const durationIndex = argmax(logits, tokenLogitCount, durations.length)
    const duration = durations[durationIndex] ?? 1

    if (token !== blankIndex) {
      tokens.push(token)
      logProbs.push(logSoftmaxAt(logits, token, 0, tokenLogitCount))
      // The emitted label becomes the predictor's next input, and its state
      // advances with it. This is the `u += 1` of a classic transducer.
      lastLabel = token
      state = prediction.state
      symbolsAtStep += 1
    }

    if (duration > 0) {
      // Rule 1: a real duration always advances time, and resets the budget.
      time += duration
      symbolsAtStep = 0
    } else if (token === blankIndex) {
      // Rule 3: blank with duration 0 would stall; step one frame regardless.
      time += 1
      symbolsAtStep = 0
    } else if (symbolsAtStep >= maxSymbolsPerStep) {
      // Rule 2: too many emissions on one frame — force progress.
      time += 1
      symbolsAtStep = 0
    }
    // Otherwise: duration 0 with a real token and budget left. Stay on this
    // frame; the next iteration scores the same audio against the new label.
  }

  return {
    tokens,
    avgLogProb:
      logProbs.length === 0 ? null : logProbs.reduce((sum, v) => sum + v, 0) / logProbs.length,
    framesConsumed: Math.min(time, frameCount),
  }
}
