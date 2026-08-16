import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'

import type {
  Settings,
  TranscriptionEvent,
  TranscriptionJob,
  TranscriptionSegment,
} from '@murmur/shared'

import { PcmSegmenter } from '../audio/segmenter'
import { AUDIO, TRANSCRIBE } from '../config'
import type { TranscribeQueue } from '../engines/stt-queue'
import type { SttEngine } from '../engines/types'
import { createLogger, type Logger } from '../logging'

/**
 * Transcribes an uploaded audio/video file (PLAN §18.4).
 *
 * A sibling of `MeetingRecorder`, and shaped by the same constraint from the
 * opposite direction: a meeting's audio arrives in real time and cannot be
 * paused, while a file's audio arrives as fast as the renderer can push it and
 * *must* be paused — otherwise a two-hour film sits decoded in main's memory
 * while a 15×-realtime engine works through it.
 *
 * So the core of this class is back-pressure, not transcription:
 *
 *  - The renderer awaits each `push()`. The promise resolves only while less
 *    than `TRANSCRIBE.highWaterMs` of audio is buffered here (segmenter +
 *    cuts waiting on the queue), so main's share of a file of any length is
 *    bounded and the decoded original stays where it already exists anyway —
 *    in the renderer.
 *  - Segments ride the shared {@link TranscribeQueue} at `background`
 *    priority, exactly like meeting segments: an import grinding through an
 *    audiobook must never add a millisecond to a dictation.
 *
 * ## Ordering
 *
 * One stream, one queue, FIFO within a priority — segments therefore complete
 * in file order and `segments` is append-only. No reorder buffer, unlike the
 * meeting recorder, whose two racing tracks are the whole reason it has one.
 *
 * ## Failure
 *
 * A meeting degrades and keeps recording, because its audio is unrepeatable.
 * A file is the opposite — perfectly repeatable — so this fails honestly
 * instead: each segment gets one retry (a timeout mid-audiobook should not
 * cost the other 89 minutes), and a second failure fails the job with the
 * engine's own words. Silently skipping a segment would hand the user a
 * transcript with an invisible hole, which is worse than no transcript.
 */

export interface FileTranscriberDeps {
  queue: TranscribeQueue
  stt: () => SttEngine | null
  settings: () => Settings
  /** Dictionary terms, biasing STT exactly as a dictation would (PLAN §6.4). */
  dictionary: () => readonly string[]
  now?: () => number
  log?: Logger
}

export interface FileTranscriberEvents {
  changed: [TranscriptionEvent]
}

interface Job {
  id: string
  fileName: string
  startedAt: number
  totalMs: number
  state: TranscriptionJob['state']
  error: string | null
  segmenter: PcmSegmenter
  segments: TranscriptionSegment[]
  receivedSamples: number
  completedMs: number
  /** Audio cut but not yet transcribed — the queue's share of the buffer. */
  pendingCutMs: number
  inFlight: number
  /** The final slice has arrived and the segmenter is flushed. */
  drained: boolean
  lastPushAt: number
  /** Kills in-flight engine requests on cancel/failure. */
  abort: AbortController
  /** Pushes parked by back-pressure, woken as segments complete. */
  waiters: (() => void)[]
}

const SAMPLES_PER_MS = AUDIO.sampleRate / 1000
/** Feed the segmenter at the cadence it was tuned for (~100 ms frames). */
const FRAME_SAMPLES = Math.round(AUDIO.sampleRate * (AUDIO.frameMs / 1000))

export class FileTranscriber extends EventEmitter<FileTranscriberEvents> {
  readonly #deps: FileTranscriberDeps
  readonly #log: Logger
  readonly #now: () => number
  readonly #jobs = new Map<string, Job>()
  #watchdog: NodeJS.Timeout | null = null

  constructor(deps: FileTranscriberDeps) {
    super()
    this.#deps = deps
    this.#log = deps.log ?? createLogger('transcribe')
    this.#now = deps.now ?? (() => Date.now())
  }

  /**
   * Start a job.
   *
   * One live job at a time, enforced here rather than assumed of the renderer:
   * the queue is shared with meetings and dictation, and two files racing each
   * other through it would interleave their segments' completion for no wall-
   * clock gain — the engine is serial anyway.
   */
  begin(fileName: string, totalMs: number): TranscriptionJob {
    const active = [...this.#jobs.values()].find(
      (job) => job.state === 'receiving' || job.state === 'finishing',
    )
    if (active) {
      throw new Error(`"${active.fileName}" is still being transcribed — one file at a time.`)
    }

    const engine = this.#deps.stt()
    if (!engine) {
      throw new Error('No speech model is loaded. Choose one under Models, then try again.')
    }

    const job: Job = {
      id: randomUUID(),
      fileName,
      startedAt: this.#now(),
      totalMs,
      state: 'receiving',
      error: null,
      segmenter: new PcmSegmenter(AUDIO.sampleRate, {
        silenceMs: TRANSCRIBE.segmentSilenceMs,
        minMs: TRANSCRIBE.minSegmentMs,
        maxMs: TRANSCRIBE.maxSegmentMs,
        preRollMs: TRANSCRIBE.segmentPreRollMs,
      }),
      segments: [],
      receivedSamples: 0,
      completedMs: 0,
      pendingCutMs: 0,
      inFlight: 0,
      drained: false,
      lastPushAt: this.#now(),
      abort: new AbortController(),
      waiters: [],
    }

    this.#jobs.set(job.id, job)
    this.#pruneFinished()
    this.#startWatchdog()
    this.#log.info(`transcribing "${fileName}" (${Math.round(totalMs / 1000)} s)`)
    this.#emit(job)
    return this.#snapshot(job)
  }

  /**
   * One slice of 16 kHz mono PCM. Resolves when there is room for the next —
   * see the class comment; this promise *is* the memory bound.
   */
  async push(jobId: string, pcm: Float32Array, last: boolean): Promise<{ bufferedMs: number }> {
    const job = this.#jobs.get(jobId)
    if (!job) throw new Error('That transcription no longer exists.')
    if (job.state !== 'receiving') {
      throw new Error(`That transcription is not accepting audio (${job.state}).`)
    }

    job.lastPushAt = this.#now()
    job.receivedSamples += pcm.length

    // The segmenter is tuned for ~100 ms frames; a 15 s IPC slice is not one.
    for (let at = 0; at < pcm.length; at += FRAME_SAMPLES) {
      const cut = job.segmenter.push(pcm.subarray(at, Math.min(at + FRAME_SAMPLES, pcm.length)))
      if (cut) this.#onCut(job, cut)
      // Cheap staleness check: a cut above may have failed the job (no engine).
      if (job.state !== 'receiving') {
        throw new Error(job.error ?? `That transcription is not accepting audio (${job.state}).`)
      }
    }

    if (last) {
      job.state = 'finishing'
      job.drained = true
      const cut = job.segmenter.flush()
      if (cut) this.#onCut(job, cut)
      this.#emit(job)
      this.#maybeFinish(job)
      return { bufferedMs: this.#bufferedMs(job) }
    }

    // Back-pressure: hold the renderer here until transcription catches up.
    // The awaits hand control back to the loop, so `cancel()` or a failing
    // segment can move `state` under us — hence the explicit re-read, which is
    // also what stops TypeScript from narrowing the comparison away.
    while (this.#bufferedMs(job) >= TRANSCRIBE.highWaterMs && job.state === 'receiving') {
      await new Promise<void>((resolve) => job.waiters.push(resolve))
    }
    const state = job.state as TranscriptionJob['state']
    if (state === 'failed' || state === 'cancelled') {
      throw new Error(job.error ?? 'The transcription was stopped.')
    }

    job.lastPushAt = this.#now()
    this.#emit(job)
    return { bufferedMs: this.#bufferedMs(job) }
  }

  /** Stop a job. Safe on any state, loud about none. */
  cancel(jobId: string): TranscriptionJob | null {
    const job = this.#jobs.get(jobId)
    if (!job) return null
    if (job.state === 'receiving' || job.state === 'finishing') {
      this.#settle(job, 'cancelled', null)
      this.#log.info(`cancelled "${job.fileName}"`)
    }
    return this.#snapshot(job)
  }

  list(): TranscriptionJob[] {
    return [...this.#jobs.values()]
      .sort((a, b) => a.startedAt - b.startedAt)
      .map((job) => this.#snapshot(job))
  }

  result(jobId: string): { job: TranscriptionJob; segments: TranscriptionSegment[] } | null {
    const job = this.#jobs.get(jobId)
    if (!job) return null
    return { job: this.#snapshot(job), segments: [...job.segments] }
  }

  /** Forget a finished job. Active jobs must be cancelled first, explicitly. */
  clear(jobId: string): void {
    const job = this.#jobs.get(jobId)
    if (!job) return
    if (job.state === 'receiving' || job.state === 'finishing') {
      throw new Error('Cancel the transcription before removing it.')
    }
    this.#jobs.delete(jobId)
  }

  async dispose(): Promise<void> {
    for (const job of this.#jobs.values()) {
      if (job.state === 'receiving' || job.state === 'finishing') {
        this.#settle(job, 'cancelled', null)
      }
    }
    this.#stopWatchdog()
    this.removeAllListeners()
  }

  // -- segments --------------------------------------------------------------

  #onCut(job: Job, cut: ReturnType<PcmSegmenter['flush']>): void {
    if (!cut) return

    // Confirmed silence: progress moved, nothing to transcribe. Without this a
    // recording's dead air reads as a stall.
    if (!cut.voiced) {
      job.completedMs = Math.max(job.completedMs, cut.endMs)
      this.#emit(job)
      return
    }

    const durationMs = cut.pcm.length / SAMPLES_PER_MS
    job.pendingCutMs += durationMs
    job.inFlight += 1

    void this.#transcribe(job, cut.pcm)
      .then((text) => {
        if (this.#jobs.get(job.id) !== job || job.state === 'cancelled' || job.state === 'failed') {
          return
        }
        job.completedMs = Math.max(job.completedMs, cut.endMs)
        const trimmed = text.trim()
        // Whisper can return an empty string for a throat-clear the VAD liked;
        // progress still moved, so the event still goes out.
        let segment: TranscriptionSegment | null = null
        if (trimmed) {
          segment = { startMs: cut.startMs, endMs: cut.endMs, text: trimmed }
          job.segments.push(segment)
        }
        this.#emit(job, segment)
      })
      .catch((error: unknown) => {
        if (this.#jobs.get(job.id) !== job) return
        // Cancelled and already-failed jobs abort their in-flight requests;
        // those rejections are the abort's own echo, not new failures.
        if (job.state === 'receiving' || job.state === 'finishing') {
          this.#settle(job, 'failed', describe(error))
        }
      })
      .finally(() => {
        job.inFlight -= 1
        job.pendingCutMs = Math.max(0, job.pendingCutMs - durationMs)
        this.#wake(job)
        this.#maybeFinish(job)
      })
  }

  /** One engine call, one retry. The engine is re-fetched per attempt so a
   *  model swap mid-file picks up the new one rather than a dead reference. */
  async #transcribe(job: Job, pcm: Float32Array): Promise<string> {
    const attempt = async (): Promise<string> => {
      const engine = this.#deps.stt()
      if (!engine) throw new Error('The speech model was unloaded mid-transcription.')
      const settings = this.#deps.settings()
      const transcript = await this.#deps.queue.submit('background', () =>
        engine.transcribe(pcm, {
          language: settings.language,
          vocabulary: this.#deps.dictionary(),
          signal: job.abort.signal,
        }),
      )
      return transcript.text
    }

    try {
      return await attempt()
    } catch (error) {
      if (job.abort.signal.aborted) throw error
      this.#log.warn(`segment failed, retrying once: ${describe(error)}`)
      await new Promise((resolve) => setTimeout(resolve, TRANSCRIBE.retryDelayMs))
      if (job.abort.signal.aborted) {
        throw new Error('The transcription was stopped.', { cause: error })
      }
      return await attempt()
    }
  }

  // -- lifecycle ---------------------------------------------------------------

  #maybeFinish(job: Job): void {
    if (job.state !== 'finishing' || !job.drained || job.inFlight > 0) return
    job.state = 'done'
    // The tail of the file may be silence; the bar should still reach the end.
    job.completedMs = Math.max(job.completedMs, job.totalMs)
    this.#log.info(`finished "${job.fileName}" — ${job.segments.length} segments`)
    this.#emit(job)
    this.#stopWatchdogIfIdle()
  }

  #settle(job: Job, state: 'failed' | 'cancelled', error: string | null): void {
    job.state = state
    job.error = state === 'failed' ? (error ?? 'The transcription failed.') : null
    if (state === 'failed') this.#log.warn(`"${job.fileName}" failed: ${job.error}`)
    job.abort.abort()
    this.#wake(job)
    this.#emit(job)
    this.#stopWatchdogIfIdle()
  }

  /** Release every parked push so it can observe the new state. */
  #wake(job: Job): void {
    const waiters = job.waiters.splice(0, job.waiters.length)
    for (const resolve of waiters) resolve()
  }

  #bufferedMs(job: Job): number {
    return job.segmenter.pendingMs + job.pendingCutMs
  }

  #pruneFinished(): void {
    const finished = [...this.#jobs.values()]
      .filter((job) => job.state !== 'receiving' && job.state !== 'finishing')
      .sort((a, b) => a.startedAt - b.startedAt)
    while (finished.length > TRANSCRIBE.maxFinishedJobs) {
      const oldest = finished.shift()
      if (oldest) this.#jobs.delete(oldest.id)
    }
  }

  // -- the stall watchdog ------------------------------------------------------

  /**
   * A `receiving` job whose renderer has died gets no cancel, no last slice,
   * nothing — the Hub window closed, or the page reloaded. Its pushes simply
   * stop. This is the only signal there is, so it is watched for: a job that
   * has heard nothing for `pushStallMs` is failed with an honest message
   * rather than sitting at 40 % forever.
   */
  #startWatchdog(): void {
    if (this.#watchdog) return
    this.#watchdog = setInterval(() => {
      for (const job of this.#jobs.values()) {
        if (job.state !== 'receiving') continue
        if (this.#now() - job.lastPushAt < TRANSCRIBE.pushStallMs) continue
        this.#settle(job, 'failed', 'The audio stopped arriving — was the window closed?')
      }
      this.#stopWatchdogIfIdle()
    }, TRANSCRIBE.watchdogTickMs)
    this.#watchdog.unref?.()
  }

  #stopWatchdogIfIdle(): void {
    const anyLive = [...this.#jobs.values()].some(
      (job) => job.state === 'receiving' || job.state === 'finishing',
    )
    if (!anyLive) this.#stopWatchdog()
  }

  #stopWatchdog(): void {
    if (this.#watchdog) clearInterval(this.#watchdog)
    this.#watchdog = null
  }

  // -- events -------------------------------------------------------------------

  #snapshot(job: Job): TranscriptionJob {
    return {
      id: job.id,
      fileName: job.fileName,
      startedAt: job.startedAt,
      totalMs: job.totalMs,
      receivedMs: job.receivedSamples / SAMPLES_PER_MS,
      completedMs: Math.min(job.completedMs, job.totalMs),
      segmentCount: job.segments.length,
      state: job.state,
      error: job.error,
    }
  }

  #emit(job: Job, segment: TranscriptionSegment | null = null): void {
    this.emit('changed', { job: this.#snapshot(job), segment })
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
