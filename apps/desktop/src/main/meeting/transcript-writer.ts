import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import type { MeetingSegment, MeetingTrack } from '@murmur/shared'

import { createLogger, type Logger } from '../logging'

/**
 * Streams a meeting transcript to Markdown as it is spoken (PLAN §18.2).
 *
 * **Appends per segment rather than writing once at the end.** A meeting runs
 * for an hour; a crash, a force-quit or a flat battery at minute 58 must not
 * cost the previous 57. This is deliberately *not* the atomic
 * write-then-rename `settings-store.ts` uses — that pattern is for replacing a
 * whole file, and applying it here would mean holding the entire transcript in
 * memory and rewriting it on every line.
 *
 * Frontmatter carries only what is known when recording *starts*. Duration and
 * end time go in a footer at the bottom, because rewriting frontmatter would
 * mean rewriting the file, which is the thing we are avoiding.
 */

export interface TranscriptHeader {
  title: string
  startedAt: Date
  appBundleId: string | null
  sttModelId: string
  hasSystemAudio: boolean
}

/** How each track is labelled in the transcript. */
const SPEAKER: Record<MeetingTrack, string> = { me: 'You', them: 'Them' }

export class TranscriptWriter {
  readonly #path: string
  readonly #log: Logger
  #closed = false
  #failed: string | null = null

  constructor(path: string, header: TranscriptHeader, log?: Logger) {
    this.#path = path
    this.#log = log ?? createLogger('meeting')
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, frontmatter(header), { encoding: 'utf8', flag: 'wx' })
  }

  get path(): string {
    return this.#path
  }

  /** Non-null once a write failed; the recorder surfaces it and stops. */
  get failure(): string | null {
    return this.#failed
  }

  /**
   * Append one transcribed segment.
   *
   * Swallows nothing: a failure here (a full disk, a revoked folder grant) is
   * recorded so the recorder can stop and tell the user, rather than
   * cheerfully carrying on writing into the void.
   */
  append(segment: MeetingSegment): boolean {
    const text = segment.text.trim()
    if (!text) return true
    return this.#write(`- **[${clock(segment.startMs)}] ${SPEAKER[segment.track]}:** ${text}\n`)
  }

  /**
   * Note a stretch where capture continued but transcription could not.
   *
   * An engine crash-loop must not end the meeting — the audio is still being
   * heard, and an honest gap is worth more than a silent omission.
   */
  gap(reason: string, fromMs: number, toMs: number): boolean {
    return this.#write(`\n> [${reason} — ${clock(fromMs)} to ${clock(toMs)}]\n\n`)
  }

  close(endedAt: Date, durationMs: number, segmentCount: number): void {
    if (this.#closed) return
    this.#closed = true
    this.#write(
      `\n---\n\nEnded ${endedAt.toLocaleTimeString()} · ` +
        `${clock(durationMs)} · ${segmentCount} segment${segmentCount === 1 ? '' : 's'}\n`,
    )
  }

  #write(chunk: string): boolean {
    if (this.#failed) return false
    try {
      appendFileSync(this.#path, chunk, 'utf8')
      return true
    } catch (error) {
      this.#failed = error instanceof Error ? error.message : String(error)
      this.#log.error(`could not write the transcript: ${this.#failed}`)
      return false
    }
  }
}

function frontmatter(header: TranscriptHeader): string {
  const at = header.startedAt
  const p = (n: number): string => String(n).padStart(2, '0')
  const lines = [
    '---',
    `title: ${yaml(header.title)}`,
    `date: ${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}`,
    `started: ${p(at.getHours())}:${p(at.getMinutes())}:${p(at.getSeconds())}`,
    `source: ${yaml(header.appBundleId ?? 'manual')}`,
    `audio: ${header.hasSystemAudio ? 'microphone + system' : 'microphone only'}`,
    `engine: ${yaml(header.sttModelId)}`,
    '---',
    '',
    `# ${header.title}`,
    '',
  ]
  return lines.join('\n')
}

/**
 * Quote anything YAML would otherwise reinterpret.
 *
 * A meeting called `Q3: results` or `- standup` is perfectly ordinary and
 * would produce a file whose own frontmatter no longer parses.
 */
function yaml(value: string): string {
  const flat = value.replace(/[\r\n]+/g, ' ').trim()
  if (!flat) return "''"
  if (/^[\w .()[\]/&+,'-]+$/.test(flat) && !/^[-?:,[\]{}#&*!|>%@`'"]/.test(flat)) return flat
  return `'${flat.replace(/'/g, "''")}'`
}

/** `mm:ss` under an hour, `h:mm:ss` beyond it. */
export function clock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const s = total % 60
  const m = Math.floor(total / 60) % 60
  const h = Math.floor(total / 3600)
  const p = (n: number): string => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`
}
