import { z } from 'zod'

/**
 * File transcription (PLAN §18.4) — drop an audio or video file on the Hub,
 * get a transcript.
 *
 * Its own vocabulary for the same reason meetings have one: the three loops
 * disagree about shape. A dictation is seconds long and ends in an injection; a
 * meeting is live and ends in a file on disk; a file import is *finite but
 * long*, arrives all at once, and ends in text the user takes somewhere else.
 *
 * The renderer decodes (Chromium's decoders are the only ones in the app that
 * read MP3 and MP4), main transcribes (the engines live there), and these
 * schemas are the seam between the two.
 */

// ---------------------------------------------------------------------------
// Segments
// ---------------------------------------------------------------------------

/**
 * One transcribed slice of the file.
 *
 * Boundaries are where the segmenter found silence, so a segment reads as a
 * spoken passage — which is why the exports below can treat segments as
 * paragraphs and subtitle cues without any re-splitting.
 */
export const TranscriptionSegmentSchema = z.object({
  /** Milliseconds from the start of the file, not epoch. */
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().nonnegative(),
  text: z.string(),
})
export type TranscriptionSegment = z.infer<typeof TranscriptionSegmentSchema>

// ---------------------------------------------------------------------------
// The job
// ---------------------------------------------------------------------------

export const TranscriptionStateSchema = z.enum([
  /** Audio is still arriving from the renderer. */
  'receiving',
  /** Everything has arrived; queued segments are still being transcribed. */
  'finishing',
  'done',
  'failed',
  'cancelled',
])
export type TranscriptionState = z.infer<typeof TranscriptionStateSchema>

/**
 * A job snapshot — everything the Hub needs to draw one file's row, and
 * nothing heavy. The segments travel separately (`transcribe.result`), so a
 * progress event for a two-hour file is never dragging the transcript so far
 * along with it.
 */
export const TranscriptionJobSchema = z.object({
  id: z.string().min(1),
  /** Display name of the source file; main never sees its path. */
  fileName: z.string().min(1),
  /** Epoch milliseconds when the job was created. */
  startedAt: z.number().int().nonnegative(),
  /** Duration of the decoded audio, from the renderer's decode. */
  totalMs: z.number().nonnegative(),
  /** How much audio has arrived, for the gap between decode and transcribe. */
  receivedMs: z.number().nonnegative(),
  /** High-water mark of transcribed (or confirmed-silent) audio. */
  completedMs: z.number().nonnegative(),
  segmentCount: z.number().int().nonnegative(),
  state: TranscriptionStateSchema,
  /** Set only in the `failed` state. */
  error: z.string().nullable().default(null),
})
export type TranscriptionJob = z.infer<typeof TranscriptionJobSchema>

/** What `transcribe.changed` carries: the snapshot, plus a segment when one landed. */
export const TranscriptionEventSchema = z.object({
  job: TranscriptionJobSchema,
  /** The segment this event announces, if it announces one. */
  segment: TranscriptionSegmentSchema.nullable().default(null),
})
export type TranscriptionEvent = z.infer<typeof TranscriptionEventSchema>

export const TranscriptionExportFormatSchema = z.enum(['txt', 'srt', 'md'])
export type TranscriptionExportFormat = z.infer<typeof TranscriptionExportFormatSchema>

// ---------------------------------------------------------------------------
// Export formatting (pure, unit-tested)
// ---------------------------------------------------------------------------

/**
 * Plain text: segments as paragraphs.
 *
 * A blank line per silence-cut boundary is the honest structure — the speaker
 * paused there — and it is what makes a pasted transcript readable instead of
 * one wall of prose.
 */
export function transcriptionText(segments: readonly TranscriptionSegment[]): string {
  return segments
    .map((segment) => segment.text.trim())
    .filter((text) => text.length > 0)
    .join('\n\n')
}

/**
 * Markdown: a small header, then timestamped paragraphs.
 *
 * The timestamp per paragraph is the feature — it is what lets someone quote a
 * podcast and say where the quote lives.
 */
export function transcriptionMarkdown(
  segments: readonly TranscriptionSegment[],
  meta: { fileName: string; totalMs: number },
): string {
  const lines = [
    `# Transcript of ${meta.fileName}`,
    '',
    `Duration: ${formatTimecode(meta.totalMs)} · Transcribed on-device by Murmur`,
    '',
  ]
  for (const segment of segments) {
    const text = segment.text.trim()
    if (!text) continue
    lines.push(`**[${formatTimecode(segment.startMs)}]** ${text}`, '')
  }
  return `${lines.join('\n').trimEnd()}\n`
}

/**
 * SubRip subtitles.
 *
 * Cues are the segments as cut — up to ~15 s each, which is long for a
 * subtitle but truthful to what was transcribed. Re-timing text onto shorter
 * cues would mean inventing word timings the engines do not report.
 */
export function transcriptionSrt(segments: readonly TranscriptionSegment[]): string {
  const cues: string[] = []
  let index = 1
  for (const segment of segments) {
    const text = segment.text.trim()
    if (!text) continue
    cues.push(
      `${index}\n${formatSrtTime(segment.startMs)} --> ${formatSrtTime(segment.endMs)}\n${text}`,
    )
    index += 1
  }
  return cues.length === 0 ? '' : `${cues.join('\n\n')}\n`
}

/** `h:mm:ss` (or `m:ss` under an hour) — for humans, not for parsers. */
export function formatTimecode(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const s = total % 60
  const m = Math.floor(total / 60) % 60
  const h = Math.floor(total / 3600)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

/** SubRip's `HH:MM:SS,mmm` — comma deliberate, it is the format's own quirk. */
export function formatSrtTime(ms: number): string {
  const clamped = Math.max(0, Math.round(ms))
  const milli = clamped % 1000
  const total = Math.floor(clamped / 1000)
  const s = total % 60
  const m = Math.floor(total / 60) % 60
  const h = Math.floor(total / 3600)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(h)}:${pad(m)}:${pad(s)},${String(milli).padStart(3, '0')}`
}

/**
 * The exported file's name: the source's base name, the new extension.
 *
 * Strips exactly one extension (`interview.final.mp3` → `interview.final.srt`)
 * and falls back to `transcript` for names that are nothing but extension —
 * the dialog needs *something* in the filename field.
 */
export function transcriptionExportName(
  fileName: string,
  format: TranscriptionExportFormat,
): string {
  const base = fileName.replace(/\.[^.]+$/, '').trim()
  return `${base || 'transcript'}.${format}`
}
