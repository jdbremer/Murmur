import { POLISH, TIMEOUTS } from '../../config'
import { isLoopbackHost, isPrivateHost, type FetchLike } from '../../net/fetch'
import type { PolishRequest } from '../types'

/**
 * The OpenAI-compatible chat client used by *both* polish backends (PLAN §7.1).
 *
 * The bundled `llama-server` and an external endpoint (Ollama, LM Studio, a
 * company vLLM box) speak the same `/v1/chat/completions` API, so "bring your
 * own endpoint" is genuinely the same code path with a different base URL — no
 * second client to keep in sync, and no second place for a prompt to leak from.
 *
 * Two safety properties live here rather than at the call sites:
 *
 *  - the request never goes through the model-download allowlist wrapper, and
 *    the allowlist wrapper never reaches a chat endpoint: they are disjoint by
 *    construction, which is what makes the "only Hugging Face" claim in PLAN
 *    §10.2 checkable;
 *  - {@link classifyEndpoint} tells the caller whether a base URL is loopback,
 *    private, or public, so the UI can warn before a single prompt is sent
 *    (PLAN §7.1's "so 'local-only' stays honest").
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatClientOptions {
  baseUrl: string
  /** Bearer token. The sidecar's per-launch token, or a user-supplied key. */
  apiKey: string | null
  model: string
  /**
   * The transport, chosen consciously by whoever constructs the client:
   * `loopbackFetch` when fronting the bundled llama-server (a prompt must
   * never leave the machine), the plain global for a user-configured external
   * endpoint (allowed by PLAN §7.1 and warned about when not loopback).
   * Required so that no call site gets a network path by accident.
   */
  fetchImpl: FetchLike
}

interface ChatCompletionResponse {
  choices?: { message?: { content?: string }; finish_reason?: string }[]
  error?: { message?: string }
}

interface ChatStreamChunk {
  choices?: { delta?: { content?: string }; finish_reason?: string | null }[]
  error?: { message?: string }
}

export interface ChatCompletion {
  text: string
  /**
   * True when the model hit the token cap (`finish_reason: "length"`). Command
   * mode must refuse such an edit: pasting half a rewrite over the whole
   * selection destroys its tail.
   */
  truncated: boolean
}

export type EndpointClass = 'loopback' | 'private' | 'public'

/** Where a base URL points, for the warning badge in the engine status. */
export function classifyEndpoint(baseUrl: string): EndpointClass {
  let host: string
  try {
    host = new URL(baseUrl).hostname
  } catch {
    return 'public'
  }
  if (isLoopbackHost(host)) return 'loopback'
  if (isPrivateHost(host)) return 'private'
  return 'public'
}

/**
 * Human-readable warnings for a polish endpoint, or an empty array when it is
 * plain loopback. Surfaced in `EngineStatus.warnings`.
 */
export function endpointWarnings(baseUrl: string): string[] {
  switch (classifyEndpoint(baseUrl)) {
    case 'loopback':
      return []
    case 'private':
      return [
        `Polishing sends transcripts to ${safeHost(baseUrl)}, which is on your local network ` +
          `rather than this machine. They leave the device.`,
      ]
    case 'public':
      return [
        `Polishing sends transcripts to ${safeHost(baseUrl)}, which is a public internet host. ` +
          `This breaks Murmur's local-only guarantee — use it only if you trust that endpoint.`,
      ]
  }
}

function safeHost(baseUrl: string): string {
  try {
    const url = new URL(baseUrl)
    return `${url.protocol}//${url.host}`
  } catch {
    return '<invalid URL>'
  }
}

/** Turn a built prompt into the chat turns the API wants. */
export function toChatMessages(request: PolishRequest): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: 'system', content: request.systemPrompt }]
  for (const example of request.examples) {
    messages.push({ role: 'user', content: example.user })
    messages.push({ role: 'assistant', content: example.assistant })
  }
  messages.push({ role: 'user', content: request.userText })
  return messages
}

export class ChatClient {
  readonly #options: ChatClientOptions

  constructor(options: ChatClientOptions) {
    this.#options = options
  }

  get baseUrl(): string {
    return this.#options.baseUrl
  }

  /**
   * One non-streaming completion.
   *
   * Non-streaming on purpose: the output is a sentence or two and the Bar shows
   * a shimmer, not partial text, in v1 (PLAN §2.1). Streaming arrives with the
   * M5 latency work.
   */
  async complete(request: PolishRequest): Promise<ChatCompletion> {
    const url = `${this.#options.baseUrl.replace(/\/$/, '')}/v1/chat/completions`
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (this.#options.apiKey) headers['authorization'] = `Bearer ${this.#options.apiKey}`

    const response = await this.#options.fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: this.#options.model,
        messages: toChatMessages(request),
        temperature: POLISH.temperature,
        top_p: POLISH.topP,
        max_tokens: request.maxTokens,
        stream: false,
        // Thinking-mode models must run with thinking off (PLAN §7.3).
        // llama.cpp accepts these as no-ops when the model has no such mode.
        reasoning_effort: 'none',
        chat_template_kwargs: { enable_thinking: false },
      }),
      signal: request.signal ?? AbortSignal.timeout(TIMEOUTS.sidecarRequestMs),
    })

    if (!response.ok) {
      const detail = await safeErrorBody(response)
      throw new Error(`Polish endpoint returned ${response.status}${detail ? `: ${detail}` : ''}`)
    }

    const payload = (await response.json()) as ChatCompletionResponse
    if (payload.error?.message) throw new Error(`Polish endpoint error: ${payload.error.message}`)

    const choice = payload.choices?.[0]
    const content = choice?.message?.content
    if (typeof content !== 'string') {
      throw new Error('Polish endpoint returned no message content')
    }
    return { text: content, truncated: choice?.finish_reason === 'length' }
  }

  /**
   * A streaming completion, yielding text as the model produces it.
   *
   * Separate from {@link complete} rather than a flag on it, because the two
   * have genuinely different failure modes and the caller has to handle them
   * differently. A non-streaming call either returns a whole answer or throws;
   * a stream can fail *after* it has already emitted half an answer, and Ask
   * has to keep and display that half rather than discard it. Collapsing both
   * into one signature would mean every polish call site growing a branch for
   * partial output it can never receive.
   */
  async *stream(request: ChatStreamRequest): AsyncGenerator<string, ChatStreamEnd> {
    const url = `${this.#options.baseUrl.replace(/\/$/, '')}/v1/chat/completions`
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (this.#options.apiKey) headers['authorization'] = `Bearer ${this.#options.apiKey}`

    const response = await this.#options.fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: this.#options.model,
        messages: request.messages,
        temperature: request.temperature ?? POLISH.temperature,
        top_p: POLISH.topP,
        max_tokens: request.maxTokens,
        stream: true,
        reasoning_effort: 'none',
        chat_template_kwargs: { enable_thinking: false },
      }),
      signal: request.signal,
    })

    if (!response.ok) {
      const detail = await safeErrorBody(response)
      throw new Error(`Chat endpoint returned ${response.status}${detail ? `: ${detail}` : ''}`)
    }
    if (!response.body) throw new Error('Chat endpoint returned no body to stream')

    const decoder = new SseDecoder()
    const utf8 = new TextDecoder()
    const reader = response.body.getReader()
    let truncated = false

    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        // `stream: true` on the TextDecoder, so a multi-byte character split
        // across two network reads is held rather than emitted as U+FFFD.
        for (const payload of decoder.push(utf8.decode(value, { stream: true }))) {
          if (payload === '[DONE]') return { truncated }

          let chunk: ChatStreamChunk
          try {
            chunk = JSON.parse(payload) as ChatStreamChunk
          } catch {
            // A malformed frame mid-stream is not worth destroying an
            // in-progress answer over; the next one is usually fine.
            continue
          }

          if (chunk.error?.message) throw new Error(`Chat endpoint error: ${chunk.error.message}`)
          const choice = chunk.choices?.[0]
          if (choice?.finish_reason === 'length') truncated = true
          const text = choice?.delta?.content
          if (text) yield text
        }
      }
    } finally {
      // Releasing the lock lets an aborted stream's socket be torn down at
      // once, which matters here more than usual: llama-server runs with
      // `--parallel 1`, so a socket we have stopped reading is a slot the next
      // dictation cannot have.
      reader.releaseLock()
    }

    return { truncated }
  }
}

export interface ChatStreamRequest {
  messages: ChatMessage[]
  maxTokens: number
  temperature?: number
  signal: AbortSignal
}

export interface ChatStreamEnd {
  truncated: boolean
}

/**
 * Server-sent-events framing, split out so it can be tested without a socket.
 *
 * The whole job is that network reads have nothing to do with message
 * boundaries: one read can carry three events, or the first half of one. Every
 * naive implementation of this works perfectly against a fast local server and
 * corrupts output against a slow one, because locally each write usually
 * arrives as its own read. Keeping the buffer in an object with a `push` method
 * makes the split-frame case something a test can construct directly.
 */
export class SseDecoder {
  #buffer = ''

  /** Feed a raw chunk; get back whatever complete `data:` payloads it finished. */
  push(chunk: string): string[] {
    this.#buffer += chunk
    const payloads: string[] = []

    for (;;) {
      // Events are separated by a blank line. Tolerate CRLF: the spec allows it
      // and some proxies rewrite line endings.
      const boundary = this.#buffer.search(/\r?\n\r?\n/)
      if (boundary === -1) break
      const raw = this.#buffer.slice(0, boundary)
      this.#buffer = this.#buffer.slice(boundary).replace(/^\r?\n\r?\n/, '')

      const data = raw
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n')
      if (data) payloads.push(data)
    }

    return payloads
  }
}

/**
 * Read an error body without letting it become an attack on the log: capped,
 * and only the message field of a JSON error is kept.
 */
async function safeErrorBody(response: Response): Promise<string> {
  try {
    const text = (await response.text()).slice(0, 500)
    try {
      const parsed = JSON.parse(text) as ChatCompletionResponse
      return parsed.error?.message ?? ''
    } catch {
      return text
    }
  } catch {
    return ''
  }
}
