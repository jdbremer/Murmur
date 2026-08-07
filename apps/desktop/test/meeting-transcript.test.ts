import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { MeetingSegment } from '@murmur/shared'

import { TranscriptWriter, clock } from '../src/main/meeting/transcript-writer'

/**
 * The transcript is the artifact the user actually wanted, so the properties
 * worth pinning are: it is valid Markdown with parseable frontmatter, it is
 * written *as it happens* rather than at the end, and a write failure is
 * reported rather than swallowed.
 */

let folder: string

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'murmur-transcript-'))
})
afterEach(() => {
  rmSync(folder, { recursive: true, force: true })
})

function segment(
  text: string,
  track: MeetingSegment['track'] = 'me',
  startMs = 4_000,
): MeetingSegment {
  return { id: text, track, startMs, endMs: startMs + 1_000, text }
}

function writer(title = 'Weekly Sync'): { writer: TranscriptWriter; path: string } {
  const path = join(folder, 'transcript.md')
  return {
    writer: new TranscriptWriter(path, {
      title,
      startedAt: new Date(2026, 7, 6, 14, 30, 0),
      appBundleId: 'us.zoom.xos',
      sttModelId: 'whisper-large-v3-turbo',
      hasSystemAudio: true,
    }),
    path,
  }
}

describe('TranscriptWriter', () => {
  it('writes frontmatter and a heading before anything is said', () => {
    const { path } = writer()
    const text = readFileSync(path, 'utf8')
    expect(text.startsWith('---\n')).toBe(true)
    expect(text).toContain('title: Weekly Sync')
    expect(text).toContain('date: 2026-08-06')
    expect(text).toContain('audio: microphone + system')
    expect(text).toContain('# Weekly Sync')
  })

  it('quotes a title that would otherwise break its own frontmatter', () => {
    const { path } = writer('Q3: results')
    const text = readFileSync(path, 'utf8')
    expect(text).toContain("title: 'Q3: results'")
  })

  it('appends each segment as it lands, so a crash keeps what was said', () => {
    const { writer: w, path } = writer()
    w.append(segment('can everyone hear me', 'them', 4_000))

    // Readable on disk before the meeting has ended.
    expect(readFileSync(path, 'utf8')).toContain('**[00:04] Them:** can everyone hear me')

    w.append(segment('yep coming through', 'me', 7_000))
    expect(readFileSync(path, 'utf8')).toContain('**[00:07] You:** yep coming through')
  })

  it('labels the two tracks as the two speakers', () => {
    const { writer: w, path } = writer()
    w.append(segment('mine', 'me'))
    w.append(segment('theirs', 'them'))
    const text = readFileSync(path, 'utf8')
    expect(text).toContain('You:** mine')
    expect(text).toContain('Them:** theirs')
  })

  it('skips empty segments rather than writing blank bullets', () => {
    const { writer: w, path } = writer()
    w.append(segment('   ', 'me'))
    expect(readFileSync(path, 'utf8')).not.toContain('- **')
  })

  it('records a gap when transcription fails but capture continues', () => {
    const { writer: w, path } = writer()
    w.gap('transcription unavailable', 60_000, 90_000)
    expect(readFileSync(path, 'utf8')).toContain('[transcription unavailable — 01:00 to 01:30]')
  })

  it('puts the summary in a footer, never by rewriting frontmatter', () => {
    const { writer: w, path } = writer()
    w.append(segment('hello'))
    w.close(new Date(2026, 7, 6, 15, 30, 0), 3_600_000, 12)

    const text = readFileSync(path, 'utf8')
    expect(text).toContain('1:00:00')
    expect(text).toContain('12 segments')
    // Frontmatter is still the first thing in the file and still intact.
    expect(text.indexOf('---')).toBe(0)
    expect(text.indexOf('# Weekly Sync')).toBeLessThan(text.indexOf('1:00:00'))
  })

  it('refuses to overwrite an existing transcript', () => {
    const { path } = writer()
    expect(
      () =>
        new TranscriptWriter(path, {
          title: 'Another',
          startedAt: new Date(),
          appBundleId: null,
          sttModelId: 'x',
          hasSystemAudio: false,
        }),
    ).toThrow()
  })

  it('reports a write failure instead of silently dropping speech', () => {
    const { writer: w } = writer()
    rmSync(folder, { recursive: true, force: true })

    expect(w.append(segment('lost'))).toBe(false)
    expect(w.failure).not.toBeNull()
  })
})

describe('clock', () => {
  it('is mm:ss under an hour and h:mm:ss beyond it', () => {
    expect(clock(0)).toBe('00:00')
    expect(clock(65_000)).toBe('01:05')
    expect(clock(3_725_000)).toBe('1:02:05')
  })
})
