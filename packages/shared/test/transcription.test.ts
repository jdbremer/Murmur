import { describe, expect, it } from 'vitest'

import {
  formatSrtTime,
  formatTimecode,
  transcriptionExportName,
  transcriptionMarkdown,
  transcriptionSrt,
  transcriptionText,
  type TranscriptionSegment,
} from '../src/domain/transcription'

/**
 * The export formats are what leaves the app — a subtitle file that VLC
 * rejects or a timestamp that drifts an hour is a bug the user meets in
 * someone else's software, so the formats are pinned here character by
 * character.
 */

const SEGMENTS: TranscriptionSegment[] = [
  { startMs: 0, endMs: 4_200, text: 'First thought.' },
  { startMs: 4_800, endMs: 9_100, text: 'Second thought, a bit longer.' },
]

describe('transcriptionText', () => {
  it('joins segments as paragraphs', () => {
    expect(transcriptionText(SEGMENTS)).toBe('First thought.\n\nSecond thought, a bit longer.')
  })

  it('skips empty and whitespace-only segments', () => {
    expect(
      transcriptionText([
        { startMs: 0, endMs: 1_000, text: '  ' },
        { startMs: 1_000, endMs: 2_000, text: 'Kept.' },
        { startMs: 2_000, endMs: 3_000, text: '' },
      ]),
    ).toBe('Kept.')
  })

  it('is empty for an empty transcript', () => {
    expect(transcriptionText([])).toBe('')
  })
})

describe('transcriptionSrt', () => {
  it('produces numbered cues in SubRip format', () => {
    expect(transcriptionSrt(SEGMENTS)).toBe(
      '1\n00:00:00,000 --> 00:00:04,200\nFirst thought.\n\n' +
        '2\n00:00:04,800 --> 00:00:09,100\nSecond thought, a bit longer.\n',
    )
  })

  it('keeps cue numbers contiguous when empty segments are skipped', () => {
    const srt = transcriptionSrt([
      { startMs: 0, endMs: 1_000, text: 'One.' },
      { startMs: 1_000, endMs: 2_000, text: '   ' },
      { startMs: 2_000, endMs: 3_000, text: 'Two.' },
    ])
    // The skipped middle segment must not leave a hole in the numbering —
    // players treat a gap as a malformed file.
    expect(srt).toContain('1\n')
    expect(srt).toContain('2\n00:00:02,000')
    expect(srt).not.toContain('3\n')
  })

  it('is empty for an empty transcript', () => {
    expect(transcriptionSrt([])).toBe('')
  })
})

describe('transcriptionMarkdown', () => {
  it('carries the source name, the duration and a timestamp per paragraph', () => {
    const md = transcriptionMarkdown(SEGMENTS, { fileName: 'standup.mp3', totalMs: 9_100 })
    expect(md).toContain('# Transcript of standup.mp3')
    expect(md).toContain('Duration: 0:09')
    expect(md).toContain('**[0:00]** First thought.')
    expect(md).toContain('**[0:04]** Second thought, a bit longer.')
    expect(md.endsWith('\n')).toBe(true)
  })
})

describe('formatSrtTime', () => {
  it('is zero-padded through the hours field', () => {
    expect(formatSrtTime(0)).toBe('00:00:00,000')
  })

  it('uses a comma for milliseconds, as SubRip does', () => {
    expect(formatSrtTime(3_723_456)).toBe('01:02:03,456')
  })

  it('clamps negatives to zero rather than emitting nonsense', () => {
    expect(formatSrtTime(-5)).toBe('00:00:00,000')
  })
})

describe('formatTimecode', () => {
  it('reads as m:ss under an hour', () => {
    expect(formatTimecode(65_000)).toBe('1:05')
    expect(formatTimecode(0)).toBe('0:00')
  })

  it('grows an hours field only when needed', () => {
    expect(formatTimecode(3_661_000)).toBe('1:01:01')
  })
})

describe('transcriptionExportName', () => {
  it('swaps exactly one extension', () => {
    expect(transcriptionExportName('interview.mp3', 'srt')).toBe('interview.srt')
    expect(transcriptionExportName('interview.final.mp3', 'txt')).toBe('interview.final.txt')
  })

  it('handles names with no extension', () => {
    expect(transcriptionExportName('voicemail', 'md')).toBe('voicemail.md')
  })

  it('never produces an empty base name', () => {
    expect(transcriptionExportName('.mp3', 'txt')).toBe('transcript.txt')
  })
})
