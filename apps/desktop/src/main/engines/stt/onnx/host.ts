import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { computeLogMel, PARAKEET_MEL } from './featurizer'
import { decodeMoonshineGreedy, encodeMoonshine, MOONSHINE_DEFAULTS } from './moonshine-decode'
import type { OnnxRequest, OnnxResponse } from './protocol'
import { loadOnnxRuntime, type SessionFactory } from './runtime'
import type { InferenceSessionLike, TensorFactory, TensorLike } from './session'
import { decodeTdtGreedy, type PredictorState } from './tdt-decode'
import { decodeTokens, loadTokenizer, type Tokenizer } from './tokenizer'

/**
 * Entry point for the **STT utility process** (PLAN §3.1).
 *
 * `utilityProcess.fork`s this file; it owns ONNX Runtime, keeps sessions
 * resident between utterances, and answers the request/response protocol in
 * `protocol.ts`. Crash isolation is the point: an ONNX Runtime segfault takes
 * this process down and the main-process engine restarts it, rather than
 * killing the app mid-dictation.
 *
 * It talks over `process.parentPort` (Electron's utility-process channel) and
 * falls back to `process.send` when run as a plain Node child, which is what
 * makes it startable outside Electron for debugging.
 *
 * Nothing here touches the network, the filesystem outside the model directory,
 * or anything user-visible: it receives PCM and returns text.
 */

interface LoadedModel {
  modelId: string
  family: 'moonshine' | 'parakeet-tdt'
  encoder: InferenceSessionLike
  decoder: InferenceSessionLike
  /** Transducers only: the joint network, run once per (frame, label) step. */
  joint: InferenceSessionLike | null
  tokenizer: Tokenizer
  config: { decoderStartTokenId: number; eosTokenId: number; padTokenId: number; maxLength: number }
  /** Transducers only, from the export's `config.json`. */
  tdt: {
    vocabSize: number
    blankTokenId: number
    durations: readonly number[]
    maxSymbolsPerStep: number
    hiddenSize: number
    decoderLayers: number
  } | null
}

interface ParentPortLike {
  on(event: 'message', listener: (event: { data: OnnxRequest }) => void): void
  postMessage(message: OnnxResponse): void
}

let model: LoadedModel | null = null

function reply(message: OnnxResponse): void {
  const parentPort = (process as unknown as { parentPort?: ParentPortLike }).parentPort
  if (parentPort) {
    parentPort.postMessage(message)
    return
  }
  process.send?.(message)
}

/**
 * Load a Parakeet-TDT export: three graphs rather than two.
 *
 * A transducer runs its parts at different rates — the encoder once per
 * utterance, the prediction network once per emitted label, the joint once per
 * (frame, label) step — so they are exported separately and the loop that
 * drives them lives in `tdt-decode.ts`. Everything the loop needs that is a
 * property of the *checkpoint* rather than of the architecture (vocabulary
 * size, blank id, duration bins, the symbol budget) is read from the export's
 * own `config.json` instead of being hardcoded, so a future NVIDIA release that
 * moves any of them fails loudly at load rather than decoding subtly wrong.
 */
async function loadParakeet(
  request: Extract<OnnxRequest, { type: 'load' }>,
  createSession: SessionFactory,
): Promise<void> {
  const find = (needle: string): string | undefined =>
    request.files.find((file) => file === needle || file.endsWith(`/${needle}`))

  const encoderFile = find('encoder.onnx')
  const decoderFile = find('decoder.onnx')
  const jointFile = find('joint.onnx')
  const vocabFile = find('vocab.json')
  const configFile = find('config.json')

  if (!encoderFile || !decoderFile || !jointFile || !vocabFile || !configFile) {
    reply({
      type: 'error',
      id: request.id,
      reason: 'model-missing',
      message:
        `Model "${request.modelId}" is incomplete: a transducer needs encoder.onnx, ` +
        `decoder.onnx, joint.onnx, vocab.json and config.json, found ` +
        `[${request.files.join(', ')}].`,
    })
    return
  }

  let meta: {
    vocabSize: number
    blankTokenId: number
    durations: number[]
    maxSymbolsPerStep: number
    hiddenSize: number
    decoderLayers: number
  }
  try {
    meta = JSON.parse(readFileSync(join(request.directory, configFile), 'utf8')) as typeof meta
  } catch (error) {
    reply({
      type: 'error',
      id: request.id,
      reason: 'model-missing',
      message: `Could not read ${configFile}: ${error instanceof Error ? error.message : String(error)}`,
    })
    return
  }

  // The blank sits at the end of the token block, so the loop's arithmetic —
  // `vocabSize` token logits then the duration bins — only holds if the export
  // agrees. Checking beats decoding gibberish.
  if (meta.blankTokenId !== meta.vocabSize - 1) {
    reply({
      type: 'error',
      id: request.id,
      reason: 'unknown',
      message:
        `Export declares blankTokenId ${meta.blankTokenId} with vocabSize ${meta.vocabSize}; ` +
        `the decode loop assumes blank is the last token id.`,
    })
    return
  }

  const [encoder, decoder, joint] = await Promise.all([
    createSession(join(request.directory, encoderFile)),
    createSession(join(request.directory, decoderFile)),
    createSession(join(request.directory, jointFile)),
  ])

  model = {
    modelId: request.modelId,
    family: 'parakeet-tdt',
    encoder,
    decoder,
    joint,
    tokenizer: loadTokenizer(
      'vocab.json',
      readFileSync(join(request.directory, vocabFile), 'utf8'),
    ),
    config: { decoderStartTokenId: 0, eosTokenId: 0, padTokenId: 0, maxLength: 0 },
    tdt: {
      // `vocabSize` here counts the blank; the decode loop wants it excluded.
      vocabSize: meta.vocabSize - 1,
      blankTokenId: meta.blankTokenId,
      durations: meta.durations,
      maxSymbolsPerStep: meta.maxSymbolsPerStep,
      hiddenSize: meta.hiddenSize,
      decoderLayers: meta.decoderLayers,
    },
  }

  reply({ type: 'ok', id: request.id })
}

async function handleLoad(
  request: Extract<OnnxRequest, { type: 'load' }>,
  createSession: SessionFactory,
): Promise<void> {
  await disposeModel()

  if (request.family === 'parakeet-tdt') {
    await loadParakeet(request, createSession)
    return
  }

  const encoderFile = request.files.find((file) => file.includes('encoder_model'))
  const decoderFile = request.files.find((file) => file.includes('decoder_model'))
  const tokenizerFile = request.files.find(
    (file) => file === 'tokenizer.json' || file === 'vocab.txt',
  )

  if (!encoderFile || !decoderFile || !tokenizerFile) {
    reply({
      type: 'error',
      id: request.id,
      reason: 'model-missing',
      message:
        `Model "${request.modelId}" is incomplete: need an encoder, a decoder and a tokenizer, ` +
        `found [${request.files.join(', ')}].`,
    })
    return
  }

  const encoder = await createSession(join(request.directory, encoderFile))
  const decoder = await createSession(join(request.directory, decoderFile))
  const tokenizer = loadTokenizer(
    tokenizerFile,
    readFileSync(join(request.directory, tokenizerFile), 'utf8'),
  )

  model = {
    modelId: request.modelId,
    family: request.family,
    encoder,
    decoder,
    joint: null,
    tokenizer,
    config: readGenerationConfig(request.directory, request.files),
    tdt: null,
  }

  reply({ type: 'ok', id: request.id })
}

/**
 * Prefer the model's own `generation_config.json` / `config.json` over our
 * defaults, so a future Moonshine release that moves a special-token id keeps
 * working without a code change.
 */
function readGenerationConfig(directory: string, files: readonly string[]): LoadedModel['config'] {
  const config = { ...MOONSHINE_DEFAULTS }
  for (const name of ['generation_config.json', 'config.json']) {
    if (!files.includes(name)) continue
    try {
      const parsed = JSON.parse(readFileSync(join(directory, name), 'utf8')) as Record<
        string,
        unknown
      >
      if (typeof parsed['decoder_start_token_id'] === 'number') {
        config.decoderStartTokenId = parsed['decoder_start_token_id']
      }
      if (typeof parsed['eos_token_id'] === 'number') config.eosTokenId = parsed['eos_token_id']
      if (typeof parsed['pad_token_id'] === 'number') config.padTokenId = parsed['pad_token_id']
      if (typeof parsed['max_length'] === 'number') config.maxLength = parsed['max_length']
    } catch {
      // A malformed side-car config must not stop the model loading; the
      // defaults above come from the same released files.
    }
  }
  return config
}

/**
 * Transcribe with a Parakeet transducer.
 *
 * Unlike Moonshine, this needs a mel front-end — and that front-end has to
 * match NVIDIA's byte for byte, which is what
 * `test/parakeet-featurizer-parity.test.ts` pins.
 *
 * The decode loop itself lives in `tdt-decode.ts`; all this does is give it two
 * closures over the ONNX sessions. The prediction network's LSTM state is
 * threaded through opaquely — the loop never inspects it, which is what lets
 * the same loop serve a future export with a different state shape.
 */
async function transcribeParakeet(
  current: LoadedModel,
  pcm: Float32Array,
  tensors: TensorFactory,
  started: number,
  id: number,
): Promise<void> {
  const tdt = current.tdt
  const joint = current.joint
  if (!tdt || !joint) {
    reply({ type: 'error', id, reason: 'model-missing', message: 'Parakeet model is not loaded' })
    return
  }

  const mel = computeLogMel(pcm, PARAKEET_MEL)
  const encoded = await current.encoder.run({
    input_features: tensors.float32(mel.data, [1, mel.frames, mel.nMels]),
  })
  const encoderStates = encoded[current.encoder.outputNames[0] ?? 'encoder_states']
  if (!encoderStates) {
    reply({ type: 'error', id, reason: 'unknown', message: 'Encoder produced no output' })
    return
  }

  const zeros = (): TensorLike =>
    tensors.float32(new Float32Array(tdt.decoderLayers * tdt.hiddenSize), [
      tdt.decoderLayers,
      1,
      tdt.hiddenSize,
    ])

  const decoded = await decodeTdtGreedy(
    encoderStates,
    {
      predictor: async (label, state) => {
        // `null` means start-of-sequence, which for a transducer is the blank.
        const token = BigInt(label ?? tdt.blankTokenId)
        const out = await current.decoder.run({
          token: tensors.int64(BigInt64Array.from([token]), [1, 1]),
          h_in: state?.['h'] ?? zeros(),
          c_in: state?.['c'] ?? zeros(),
        })
        const output = out['decoder_state']
        const h = out['h_out']
        const c = out['c_out']
        if (!output || !h || !c) throw new Error('Decoder output is missing a tensor')
        return { output, state: { h, c } satisfies PredictorState }
      },
      joint: async (encoderFrame, predictorOutput) => {
        const out = await joint.run({
          decoder_state: predictorOutput,
          encoder_state: tensors.float32(encoderFrame, [1, 1, encoderFrame.length]),
        })
        const logits = out['logits']
        if (!logits) throw new Error('Joint produced no logits')
        return logits
      },
    },
    {
      vocabSize: tdt.vocabSize,
      durations: tdt.durations,
      maxSymbolsPerStep: tdt.maxSymbolsPerStep,
    },
  )

  reply({
    type: 'transcribed',
    id,
    text: decodeTokens(current.tokenizer, decoded.tokens).trim(),
    avgLogProb: decoded.avgLogProb,
    durationMs: Date.now() - started,
  })
}

async function handleTranscribe(
  request: Extract<OnnxRequest, { type: 'transcribe' }>,
  tensors: TensorFactory,
): Promise<void> {
  const current = model
  if (!current) {
    reply({ type: 'error', id: request.id, reason: 'model-missing', message: 'No model loaded' })
    return
  }

  const started = Date.now()
  const pcm = new Float32Array(request.pcm, 0, request.sampleCount)

  if (current.family === 'parakeet-tdt') {
    await transcribeParakeet(current, pcm, tensors, started, request.id)
    return
  }

  // Moonshine takes the raw waveform — no mel front-end (see moonshine-decode.ts).
  const encoderStates = await encodeMoonshine(current.encoder, pcm, tensors)
  const decoded = await decodeMoonshineGreedy(current.decoder, encoderStates, {
    tensors,
    config: current.config,
  })

  reply({
    type: 'transcribed',
    id: request.id,
    text: decodeTokens(current.tokenizer, decoded.tokens).trim(),
    avgLogProb: decoded.avgLogProb,
    durationMs: Date.now() - started,
  })
}

async function disposeModel(): Promise<void> {
  const current = model
  model = null
  if (!current) return
  await current.encoder.release?.()
  await current.decoder.release?.()
}

function main(): void {
  const runtime = loadOnnxRuntime()

  reply({
    type: 'ready',
    runtimeAvailable: runtime.ok,
    detail: runtime.ok ? `onnxruntime-node ${runtime.version}` : runtime.detail,
  })

  const parentPort = (process as unknown as { parentPort?: ParentPortLike }).parentPort
  const onRequest = (request: OnnxRequest): void => {
    void dispatch(request).catch((error: unknown) => {
      reply({
        type: 'error',
        id: request.id,
        reason: 'unknown',
        message: error instanceof Error ? error.message : String(error),
      })
    })
  }

  async function dispatch(request: OnnxRequest): Promise<void> {
    if (!runtime.ok) {
      reply({
        type: 'error',
        id: request.id,
        reason: 'runtime-missing',
        message: runtime.detail,
      })
      return
    }

    switch (request.type) {
      case 'load':
        await handleLoad(request, runtime.createSession)
        return
      case 'transcribe':
        await handleTranscribe(request, runtime.tensors)
        return
      case 'unload':
        await disposeModel()
        reply({ type: 'ok', id: request.id })
        return
    }
  }

  if (parentPort) {
    parentPort.on('message', (event) => onRequest(event.data))
  } else {
    process.on('message', (message) => onRequest(message as OnnxRequest))
  }
}

main()
