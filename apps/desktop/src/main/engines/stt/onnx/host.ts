import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { decodeMoonshineGreedy, encodeMoonshine, MOONSHINE_DEFAULTS } from './moonshine-decode'
import type { OnnxRequest, OnnxResponse } from './protocol'
import { loadOnnxRuntime, type SessionFactory } from './runtime'
import type { InferenceSessionLike, TensorFactory } from './session'
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
  tokenizer: Tokenizer
  config: { decoderStartTokenId: number; eosTokenId: number; padTokenId: number; maxLength: number }
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

async function handleLoad(
  request: Extract<OnnxRequest, { type: 'load' }>,
  createSession: SessionFactory,
): Promise<void> {
  await disposeModel()

  if (request.family !== 'moonshine') {
    reply({
      type: 'error',
      id: request.id,
      reason: 'unknown',
      message:
        `The "${request.family}" family has no decode path in this build. Parakeet lands once ` +
        `the first-party NeMo→ONNX export exists (scripts/models/export-parakeet.md).`,
    })
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
    tokenizer,
    config: readGenerationConfig(request.directory, request.files),
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
