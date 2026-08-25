/**
 * Messages between the main process and the STT utility process (PLAN §3.1).
 *
 * Kept in its own file so both sides import the same definitions and a change
 * to one end is a type error at the other. Deliberately tiny — the utility
 * process exists to isolate ONNX Runtime crashes, not to become a second
 * application.
 *
 * Audio crosses as a transferred `ArrayBuffer` (structured clone), so a
 * five-minute utterance is not serialised to JSON. Nothing else on this channel
 * carries user content: `transcribed` returns text, which is the *point*, and
 * the request/response ids are numbers.
 */

export interface OnnxLoadRequest {
  type: 'load'
  id: number
  modelId: string
  family: OnnxFamily
  directory: string
  files: readonly string[]
}

export interface OnnxTranscribeRequest {
  type: 'transcribe'
  id: number
  /** 16 kHz mono Float32 samples. */
  pcm: ArrayBuffer
  sampleCount: number
}

export interface OnnxUnloadRequest {
  type: 'unload'
  id: number
}

export type OnnxRequest = OnnxLoadRequest | OnnxTranscribeRequest | OnnxUnloadRequest

export interface OnnxReadyMessage {
  type: 'ready'
  /** False when `onnxruntime-node` could not be required. */
  runtimeAvailable: boolean
  detail: string
}

export interface OnnxOkMessage {
  type: 'ok'
  id: number
}

export interface OnnxTranscribedMessage {
  type: 'transcribed'
  id: number
  text: string
  avgLogProb: number | null
  durationMs: number
}

export interface OnnxErrorMessage {
  type: 'error'
  id: number
  message: string
  /** Maps onto `EngineUnavailableReason` where the cause is structural. */
  reason: 'runtime-missing' | 'model-missing' | 'unknown'
}

export type OnnxResponse =
  OnnxReadyMessage | OnnxOkMessage | OnnxTranscribedMessage | OnnxErrorMessage

/** Which model family a directory holds, from the files it contains. */
/**
 * Which decode path a model needs.
 *
 * Not the same question as which architecture it is: `granite-ctc` names a
 * single-graph CTC model, and any future CTC export would join it rather than
 * bring a fourth branch.
 */
export type OnnxFamily = 'moonshine' | 'parakeet-tdt' | 'granite-ctc'

export function detectFamily(files: readonly string[]): OnnxFamily | null {
  const names = files.map((file) => file.toLowerCase())
  if (names.some((name) => name.includes('decoder_model_merged'))) return 'moonshine'
  if (names.some((name) => name.includes('joint') || name.includes('encoder-model'))) {
    return 'parakeet-tdt'
  }
  // A CTC model is one graph and a vocabulary — no decoder, no joint. Checked
  // last and by exclusion, because "has a model.onnx" is the weakest signal
  // here and would otherwise swallow the two above.
  if (
    names.some((name) => name === 'model.onnx' || name === 'model.int8.onnx') &&
    names.some((name) => name === 'tokenizer.json')
  ) {
    return 'granite-ctc'
  }
  return null
}
