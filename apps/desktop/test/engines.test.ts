import { mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { EngineStatusSchema } from '@murmur/shared'

import { StatusHolder } from '../src/main/engines/types'
import {
  generateSidecarToken,
  isExecutable,
  resolveSidecarBinary,
  reserveLoopbackPort,
  sidecarSearchPaths,
} from '../src/main/engines/sidecar'
import {
  classifyEndpoint,
  endpointWarnings,
  toChatMessages,
} from '../src/main/engines/polish/client'
import {
  averageLogProb,
  buildInitialPrompt,
  pickModelFile,
} from '../src/main/engines/stt/whisper-cpp'
import { encodeWav, WAV_HEADER_BYTES } from '../src/main/engines/stt/wav'
import { redact, scrubSecrets } from '../src/main/logging'

/**
 * Engine plumbing: sidecar resolution and tokens, the OpenAI-compatible client's
 * endpoint classification, whisper's request helpers, WAV encoding, and the
 * logger's redaction rules.
 *
 * The security-relevant claims here — a per-launch token that is never logged
 * (PLAN §10.3), a warning when a polish endpoint is not loopback (PLAN §7.1),
 * and transcripts never reaching a log (PLAN §15.3) — are each asserted rather
 * than asserted-in-prose.
 */

let directory: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'murmur-engines-'))
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

describe('sidecar tokens and ports (PLAN §10.3)', () => {
  it('generates a fresh 256-bit token every time', () => {
    const first = generateSidecarToken()
    const second = generateSidecarToken()

    expect(first).toMatch(/^[0-9a-f]{64}$/)
    expect(first).not.toBe(second)
  })

  it('reserves an ephemeral loopback port', async () => {
    const port = await reserveLoopbackPort()
    expect(port).toBeGreaterThan(1024)
    expect(port).toBeLessThan(65_536)
  })
})

describe('sidecar binary resolution', () => {
  it('searches the override, the packaged resources, then the dev build', () => {
    const previous = process.env['MURMUR_SIDECAR_DIR']
    process.env['MURMUR_SIDECAR_DIR'] = '/custom/bin'
    try {
      const paths = sidecarSearchPaths('/Resources', '/app')
      expect(paths[0]).toBe('/custom/bin')
      expect(paths[1]).toBe(join('/Resources', 'bin'))
      expect(paths[2]).toContain('.sidecars')
    } finally {
      if (previous === undefined) delete process.env['MURMUR_SIDECAR_DIR']
      else process.env['MURMUR_SIDECAR_DIR'] = previous
    }
  })

  it('finds an executable binary', () => {
    const binDirectory = join(directory, 'bin')
    mkdirSync(binDirectory, { recursive: true })
    const path = join(binDirectory, 'whisper-server')
    writeFileSync(path, '#!/bin/sh\nexit 0\n')
    chmodSync(path, 0o755)

    expect(isExecutable(path)).toBe(true)
    expect(resolveSidecarBinary('whisper-server', directory, '/app').path).toBe(path)
  })

  it('ignores a non-executable file of the right name', () => {
    const binDirectory = join(directory, 'bin')
    mkdirSync(binDirectory, { recursive: true })
    const path = join(binDirectory, 'whisper-server')
    writeFileSync(path, 'not a program')
    chmodSync(path, 0o644)

    expect(isExecutable(path)).toBe(false)
    expect(resolveSidecarBinary('whisper-server', directory, '/app').path).toBeNull()
  })

  it('reports every path it searched, so the error is actionable', () => {
    const result = resolveSidecarBinary('llama-server', '/nowhere', '/app')
    expect(result.path).toBeNull()
    expect(result.searched.length).toBeGreaterThan(0)
  })
})

describe('StatusHolder', () => {
  it('notifies subscribers on every change', () => {
    const holder = new StatusHolder(EngineStatusSchema.parse({ state: 'idle' }))
    const seen: string[] = []
    const unsubscribe = holder.subscribe((status) => seen.push(status.state))

    holder.set({ state: 'loading', modelId: 'x' })
    holder.set({ state: 'ready', modelId: 'x' })
    unsubscribe()
    holder.set({ state: 'idle' })

    expect(seen).toEqual(['loading', 'ready'])
  })

  it('clears the previous reason unless a new one is given', () => {
    const holder = new StatusHolder(EngineStatusSchema.parse({ state: 'idle' }))
    holder.set({ state: 'unavailable', reason: 'binary-missing', detail: 'missing' })
    expect(holder.get().reason).toBe('binary-missing')

    holder.set({ state: 'ready', modelId: 'x' })
    expect(holder.get().reason).toBeNull()
  })

  it('hands out copies, so a consumer cannot mutate engine state', () => {
    const holder = new StatusHolder(EngineStatusSchema.parse({ state: 'idle' }))
    const snapshot = holder.get()
    snapshot.warnings.push('injected')
    expect(holder.get().warnings).toEqual([])
  })
})

describe('polish endpoint classification (PLAN §7.1)', () => {
  it('classifies loopback, private and public hosts', () => {
    expect(classifyEndpoint('http://127.0.0.1:8080')).toBe('loopback')
    expect(classifyEndpoint('http://localhost:1234/v1')).toBe('loopback')
    expect(classifyEndpoint('http://10.0.0.5:8000')).toBe('private')
    expect(classifyEndpoint('https://api.example.com')).toBe('public')
    expect(classifyEndpoint('not a url')).toBe('public')
  })

  it('does not warn about a loopback endpoint', () => {
    expect(endpointWarnings('http://127.0.0.1:8080')).toEqual([])
  })

  it('warns that a private endpoint takes text off the device', () => {
    const warnings = endpointWarnings('http://10.0.0.5:8000/v1')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('leave the device')
    expect(warnings[0]).toContain('10.0.0.5')
  })

  it('warns loudly about a public endpoint', () => {
    const warnings = endpointWarnings('https://api.example.com')
    expect(warnings[0]).toContain('local-only guarantee')
  })

  it('never puts credentials into a warning', () => {
    const warnings = endpointWarnings('https://user:secret@api.example.com/v1?api_key=abc')
    expect(warnings[0]).not.toContain('secret')
    expect(warnings[0]).not.toContain('abc')
  })
})

describe('toChatMessages', () => {
  it('lays the prompt out as system, few-shot turns, then the utterance', () => {
    const messages = toChatMessages({
      systemPrompt: 'SYSTEM',
      examples: [
        { user: 'raw one', assistant: 'clean one' },
        { user: 'raw two', assistant: 'clean two' },
      ],
      userText: 'the actual transcript',
      maxTokens: 64,
    })

    expect(messages.map((message) => message.role)).toEqual([
      'system',
      'user',
      'assistant',
      'user',
      'assistant',
      'user',
    ])
    expect(messages[0]?.content).toBe('SYSTEM')
    expect(messages.at(-1)?.content).toBe('the actual transcript')
  })
})

describe('whisper request helpers (PLAN §6.4)', () => {
  it('picks the ggml weights out of a model directory', () => {
    expect(
      pickModelFile({
        modelId: 'x',
        engine: 'whisper-cpp',
        directory: '/models/x',
        files: ['README.md', 'ggml-small.en.bin'],
      }),
    ).toBe('ggml-small.en.bin')
  })

  it('returns null when there are no weights', () => {
    expect(
      pickModelFile({ modelId: 'x', engine: 'whisper-cpp', directory: '/m', files: ['notes.txt'] }),
    ).toBeNull()
  })

  it('builds an initial_prompt as a bare comma-separated term list', () => {
    // Not an instruction: Whisper conditions on the prompt as preceding
    // context, so "please spell X correctly" would be transcribed back at us.
    expect(buildInitialPrompt(['Murmur', 'Kubernetes', 'ETA'])).toBe('Murmur, Kubernetes, ETA')
  })

  it('drops blanks and caps the length', () => {
    expect(buildInitialPrompt(['  ', 'Real'])).toBe('Real')

    const many = Array.from({ length: 500 }, (_value, index) => `term${index}`)
    expect(buildInitialPrompt(many, 100).length).toBeLessThanOrEqual(100)
  })

  it('averages the per-segment log probabilities', () => {
    expect(
      averageLogProb({ segments: [{ avg_logprob: -0.2 }, { avg_logprob: -0.4 }] }),
    ).toBeCloseTo(-0.3, 6)
  })

  it('returns null when the server reported no probabilities', () => {
    expect(averageLogProb({})).toBeNull()
    expect(averageLogProb({ segments: [{ text: 'hi' }] })).toBeNull()
    expect(averageLogProb({ segments: [{ avg_logprob: Number.NaN }] })).toBeNull()
  })
})

describe('encodeWav', () => {
  it('writes a valid 16 kHz mono 16-bit header', () => {
    const wav = encodeWav(new Float32Array([0, 0.5, -0.5]), 16_000)

    expect(wav.toString('ascii', 0, 4)).toBe('RIFF')
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE')
    expect(wav.readUInt16LE(20)).toBe(1) // PCM
    expect(wav.readUInt16LE(22)).toBe(1) // mono
    expect(wav.readUInt32LE(24)).toBe(16_000)
    expect(wav.readUInt16LE(34)).toBe(16) // bits per sample
    expect(wav.readUInt32LE(40)).toBe(6) // 3 samples × 2 bytes
    expect(wav.length).toBe(WAV_HEADER_BYTES + 6)
  })

  it('scales asymmetrically so ±1 map to the full int16 range', () => {
    const wav = encodeWav(new Float32Array([1, -1, 0]), 16_000)
    expect(wav.readInt16LE(WAV_HEADER_BYTES)).toBe(32_767)
    expect(wav.readInt16LE(WAV_HEADER_BYTES + 2)).toBe(-32_768)
    expect(wav.readInt16LE(WAV_HEADER_BYTES + 4)).toBe(0)
  })

  it('clamps out-of-range samples rather than wrapping them', () => {
    // A wrapped sample sounds like a gunshot and derails the model.
    const wav = encodeWav(new Float32Array([5, -5]), 16_000)
    expect(wav.readInt16LE(WAV_HEADER_BYTES)).toBe(32_767)
    expect(wav.readInt16LE(WAV_HEADER_BYTES + 2)).toBe(-32_768)
  })

  it('encodes an empty buffer as a valid, empty WAV', () => {
    const wav = encodeWav(new Float32Array(0), 16_000)
    expect(wav.length).toBe(WAV_HEADER_BYTES)
    expect(wav.readUInt32LE(40)).toBe(0)
  })
})

describe('logging redaction (PLAN §10.1, §15.3)', () => {
  it('never reveals transcript content', () => {
    const transcript = 'my bank password is hunter2'
    const redacted = redact(transcript)

    expect(redacted).not.toContain('hunter2')
    expect(redacted).not.toContain('password')
    // Enough to tell two transcripts apart while debugging, and no more.
    expect(redacted).toMatch(/^<27 chars, sha256:[0-9a-f]{8}>$/)
  })

  it('is stable for the same text and different for different text', () => {
    expect(redact('same')).toBe(redact('same'))
    expect(redact('one')).not.toBe(redact('two'))
  })

  it('handles empty and absent values', () => {
    expect(redact('')).toBe('<empty>')
    expect(redact(null)).toBe('<none>')
    expect(redact(undefined)).toBe('<none>')
  })

  it('scrubs bearer tokens and API keys from arbitrary strings', () => {
    expect(scrubSecrets('Authorization: Bearer abc123def456')).not.toContain('abc123def456')
    expect(scrubSecrets('failed GET https://x/y?api_key=sk-secret-value')).not.toContain(
      'sk-secret-value',
    )
    expect(scrubSecrets('{"authorization":"Bearer tok_live_xyz"}')).not.toContain('tok_live_xyz')
  })

  it('leaves ordinary text alone', () => {
    expect(scrubSecrets('whisper-server started on port 51234')).toBe(
      'whisper-server started on port 51234',
    )
  })
})
