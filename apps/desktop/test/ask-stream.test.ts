import { describe, expect, it } from 'vitest'

import { ChatClient, SseDecoder } from '../src/main/engines/polish/client'

/**
 * Server-sent-events framing and the streaming chat path (PLAN §2.2.9).
 *
 * The bug this file exists to prevent is one that passes every manual test: on
 * loopback each server write usually arrives as its own read, so a decoder that
 * assumes "one read is one event" looks perfect locally and corrupts output the
 * moment a chunk is split — which is what happens under load, over a network
 * endpoint, or with a longer answer. Split frames are therefore constructed
 * directly here rather than hoped for.
 */

describe('SseDecoder', () => {
  it('reads one event from one chunk', () => {
    const decoder = new SseDecoder()
    expect(decoder.push('data: {"a":1}\n\n')).toEqual(['{"a":1}'])
  })

  it('reads several events arriving in a single read', () => {
    const decoder = new SseDecoder()
    expect(decoder.push('data: one\n\ndata: two\n\ndata: three\n\n')).toEqual([
      'one',
      'two',
      'three',
    ])
  })

  it('holds a frame split across two reads until it is complete', () => {
    const decoder = new SseDecoder()
    expect(decoder.push('data: {"cho')).toEqual([])
    expect(decoder.push('ices":[]}\n\n')).toEqual(['{"choices":[]}'])
  })

  it('holds a frame whose blank line is split across reads', () => {
    // The nastiest split: the payload is complete but the terminator is not.
    // Emitting here would produce a truncated JSON parse on every long answer.
    const decoder = new SseDecoder()
    expect(decoder.push('data: done\n')).toEqual([])
    expect(decoder.push('\n')).toEqual(['done'])
  })

  it('survives a byte-at-a-time stream', () => {
    const decoder = new SseDecoder()
    const wire = 'data: alpha\n\ndata: beta\n\n'
    const out: string[] = []
    for (const char of wire) out.push(...decoder.push(char))
    expect(out).toEqual(['alpha', 'beta'])
  })

  it('accepts CRLF line endings', () => {
    const decoder = new SseDecoder()
    expect(decoder.push('data: hi\r\n\r\n')).toEqual(['hi'])
  })

  it('joins a multi-line data field, as the spec requires', () => {
    const decoder = new SseDecoder()
    expect(decoder.push('data: line one\ndata: line two\n\n')).toEqual(['line one\nline two'])
  })

  it('ignores comments, ids and event-type fields', () => {
    const decoder = new SseDecoder()
    expect(decoder.push(': keep-alive\n\n')).toEqual([])
    expect(decoder.push('event: message\nid: 7\ndata: payload\n\n')).toEqual(['payload'])
  })

  it('passes the terminator through so the caller can stop', () => {
    const decoder = new SseDecoder()
    expect(decoder.push('data: [DONE]\n\n')).toEqual(['[DONE]'])
  })

  it('does not emit a trailing partial frame at end of stream', () => {
    const decoder = new SseDecoder()
    expect(decoder.push('data: incomplete')).toEqual([])
  })
})

// ---------------------------------------------------------------------------

/** A fetch that replays a scripted SSE body in whatever chunks the test wants. */
function fakeStream(chunks: string[], init: { status?: number; body?: string } = {}) {
  return (): Promise<Response> => {
    if (init.status && init.status !== 200) {
      return Promise.resolve(
        new Response(init.body ?? '{"error":{"message":"nope"}}', { status: init.status }),
      )
    }
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
        controller.close()
      },
    })
    return Promise.resolve(new Response(stream, { status: 200 }))
  }
}

function client(chunks: string[], init?: { status?: number; body?: string }): ChatClient {
  return new ChatClient({
    baseUrl: 'http://127.0.0.1:9999',
    apiKey: 'token',
    model: 'test',
    fetchImpl: fakeStream(chunks, init) as never,
  })
}

const frame = (content: string): string =>
  `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`

async function collect(
  generator: AsyncGenerator<string, { truncated: boolean }>,
): Promise<{ text: string; truncated: boolean }> {
  let text = ''
  for (;;) {
    const next = await generator.next()
    if (next.done) return { text, truncated: next.value.truncated }
    text += next.value
  }
}

describe('ChatClient.stream', () => {
  const request = { messages: [], maxTokens: 64, signal: new AbortController().signal }

  it('yields each delta and reports a clean finish', async () => {
    const result = await collect(
      client([frame('Hello'), frame(' world'), 'data: [DONE]\n\n']).stream(request),
    )
    expect(result).toEqual({ text: 'Hello world', truncated: false })
  })

  it('reassembles deltas split across network reads', async () => {
    const wire = frame('Hello') + frame(' world')
    const half = Math.floor(wire.length / 2)
    const result = await collect(
      client([wire.slice(0, half), wire.slice(half), 'data: [DONE]\n\n']).stream(request),
    )
    expect(result.text).toBe('Hello world')
  })

  it('reassembles a multi-byte character split across reads', async () => {
    // A UTF-8 continuation byte arriving in the next read must not become
    // U+FFFD. Dictation is multilingual; this is not hypothetical.
    const wire = new TextEncoder().encode(frame('café ☕'))
    // Cut inside the three bytes of ☕, so the first read ends mid-character.
    const cut = wire.length - 6
    const chunks = [wire.slice(0, cut), wire.slice(cut)]

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk)
        controller.close()
      },
    })
    const streaming = new ChatClient({
      baseUrl: 'http://127.0.0.1:9999',
      apiKey: null,
      model: 'test',
      fetchImpl: (() => Promise.resolve(new Response(stream, { status: 200 }))) as never,
    })
    const result = await collect(streaming.stream(request))
    expect(result.text).toBe('café ☕')
    expect(result.text).not.toContain('�')
  })

  it('reports truncation when the model hits the token cap', async () => {
    const capped = `data: ${JSON.stringify({
      choices: [{ delta: { content: 'cut' }, finish_reason: 'length' }],
    })}\n\n`
    const result = await collect(client([capped, 'data: [DONE]\n\n']).stream(request))
    expect(result).toEqual({ text: 'cut', truncated: true })
  })

  it('skips a malformed frame instead of destroying the answer', async () => {
    // Half an answer already on screen is worth more than a clean failure.
    const result = await collect(
      client([frame('good '), 'data: {not json\n\n', frame('news'), 'data: [DONE]\n\n']).stream(
        request,
      ),
    )
    expect(result.text).toBe('good news')
  })

  it('throws when the endpoint refuses before streaming', async () => {
    await expect(
      collect(client([], { status: 503, body: '{"error":{"message":"loading"}}' }).stream(request)),
    ).rejects.toThrow(/503.*loading/)
  })

  it('raises an error frame arriving mid-stream', async () => {
    await expect(
      collect(
        client([frame('start'), 'data: {"error":{"message":"context overflow"}}\n\n']).stream(
          request,
        ),
      ),
    ).rejects.toThrow(/context overflow/)
  })

  it('stops when the caller aborts', async () => {
    const controller = new AbortController()
    const generator = client([frame('one'), frame('two'), 'data: [DONE]\n\n']).stream({
      ...request,
      signal: controller.signal,
    })
    expect((await generator.next()).value).toBe('one')
    controller.abort()
    // `return()` is what a `for await` loop calls on break; it must run the
    // generator's `finally` and release the reader rather than hang.
    await expect(generator.return({ truncated: false })).resolves.toBeTruthy()
  })

  it('ends cleanly when the body closes without a [DONE]', async () => {
    // llama-server sends one; not every OpenAI-compatible server does.
    const result = await collect(client([frame('partial')]).stream(request))
    expect(result).toEqual({ text: 'partial', truncated: false })
  })
})
