import { POLISH, TIMEOUTS } from '../../config'
import { isLoopbackHost, isPrivateHost } from '../../net/fetch'
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
}

interface ChatCompletionResponse {
  choices?: { message?: { content?: string }; finish_reason?: string }[]
  error?: { message?: string }
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
  async complete(request: PolishRequest): Promise<string> {
    const url = `${this.#options.baseUrl.replace(/\/$/, '')}/v1/chat/completions`
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (this.#options.apiKey) headers['authorization'] = `Bearer ${this.#options.apiKey}`

    const response = await fetch(url, {
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

    const content = payload.choices?.[0]?.message?.content
    if (typeof content !== 'string') {
      throw new Error('Polish endpoint returned no message content')
    }
    return content
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
