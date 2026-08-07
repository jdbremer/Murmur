import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { WavStreamWriter } from '../src/main/meeting/wav-writer'

/**
 * The meeting recording, when `meetings.keepAudio` is on.
 *
 * The property that matters is that it streams: a three-hour meeting cannot be
 * held in memory to be encoded at the end, so the header is written first with
 * placeholder lengths and patched on close.
 */

let folder: string
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'murmur-wav-'))
})
afterEach(() => {
  rmSync(folder, { recursive: true, force: true })
})

const path = (name = 'audio.wav'): string => join(folder, name)

describe('WavStreamWriter', () => {
  it('writes a valid RIFF header before any audio arrives', () => {
    const file = path()
    new WavStreamWriter(file, 16_000)
    const bytes = readFileSync(file)

    expect(bytes.length).toBe(44)
    expect(bytes.toString('ascii', 0, 4)).toBe('RIFF')
    expect(bytes.toString('ascii', 8, 12)).toBe('WAVE')
    expect(bytes.readUInt16LE(22)).toBe(1) // mono
    expect(bytes.readUInt32LE(24)).toBe(16_000)
    expect(bytes.readUInt16LE(34)).toBe(16) // 16-bit
  })

  it('patches the length fields on close so the file is playable', () => {
    const file = path()
    const writer = new WavStreamWriter(file, 16_000)
    writer.append(new Float32Array(1_600))
    writer.close()

    const bytes = readFileSync(file)
    const dataBytes = 1_600 * 2
    expect(bytes.readUInt32LE(40)).toBe(dataBytes)
    expect(bytes.readUInt32LE(4)).toBe(36 + dataBytes)
    expect(bytes.length).toBe(44 + dataBytes)
  })

  it('converts float samples to 16-bit without wrapping on overshoot', () => {
    // A sample above 1.0 must clip, not wrap round to a loud click.
    const file = path()
    const writer = new WavStreamWriter(file, 16_000)
    writer.append(Float32Array.from([0, 1, -1, 2, -2]))
    writer.close()

    const bytes = readFileSync(file)
    expect(bytes.readInt16LE(44)).toBe(0)
    expect(bytes.readInt16LE(46)).toBe(32767)
    expect(bytes.readInt16LE(48)).toBe(-32767)
    expect(bytes.readInt16LE(50)).toBe(32767)
    expect(bytes.readInt16LE(52)).toBe(-32767)
  })

  it('keeps appending across many chunks', () => {
    const file = path()
    const writer = new WavStreamWriter(file, 16_000)
    for (let i = 0; i < 50; i += 1) writer.append(new Float32Array(1_600))
    writer.close()

    expect(readFileSync(file).length).toBe(44 + 50 * 1_600 * 2)
  })

  it('leaves recoverable audio when it is never closed', () => {
    // A crash mid-meeting leaves a header claiming zero length. Every decoder
    // reads a truncated WAV to EOF, so the audio survives — which is the whole
    // reason the header is not buffered until the end.
    const file = path()
    const writer = new WavStreamWriter(file, 16_000)
    writer.append(new Float32Array(800))

    const bytes = readFileSync(file)
    expect(bytes.length).toBe(44 + 1_600)
    expect(bytes.readUInt32LE(40)).toBe(0)
  })

  it('closes idempotently', () => {
    const writer = new WavStreamWriter(path(), 16_000)
    writer.append(new Float32Array(160))
    writer.close()
    expect(() => writer.close()).not.toThrow()
  })

  it('never overwrites an existing recording', () => {
    const file = path()
    new WavStreamWriter(file, 16_000).close()
    expect(() => new WavStreamWriter(file, 16_000)).toThrow()
  })
})
