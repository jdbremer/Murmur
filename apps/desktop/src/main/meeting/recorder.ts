import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'

import {
  MEETING_IDLE,
  type MeetingEvent,
  type MeetingRecord,
  type MeetingSegment,
  type MeetingTrack,
  type Settings,
} from '@murmur/shared'

import type { CaptureController, CaptureLease } from '../audio/controller'
import type { FrameBus } from '../audio/frame-bus'
import type { SystemAudioSource } from '../audio/system-capture'
import { frameRms } from '../audio/vad'
import { AUDIO, MEETING } from '../config'
import type { TranscribeQueue } from '../engines/stt-queue'
import type { SttEngine } from '../engines/types'
import { createLogger, type Logger } from '../logging'
import { transcriptPath } from './filename'
import { looksLikeBleed, MicHoldback } from './holdback'
import { TrackSegmenter, type MeetingSegmentCut } from './segmenter'
import { TranscriptWriter } from './transcript-writer'
import { WavStreamWriter } from './wav-writer'

/**
 * Records and transcribes a meeting, live, to a file (PLAN §18.2).
 *
 * A **sibling** of `DictationOrchestrator`, deliberately not a mode flag on it.
 * The two loops disagree about almost everything: a dictation lasts seconds
 * and ends in an injection and a history row; a meeting lasts an hour and ends
 * in a Markdown file. They also have to run *at the same time* — someone can
 * dictate into Slack in the middle of a call — which a shared state machine
 * could not express.
 *
 * ### Memory
 *
 * A three-hour meeting is ~690 MB of PCM if buffered, so it never is. Segments
 * are drained the moment they are cut and freed once transcribed; at most two
 * open segments (~15 s each, about a megabyte) are resident. The file on disk
 * is the store — the Hub reads it back rather than holding anything.
 */

export interface MeetingRecorderDeps {
  capture: CaptureController
  frames: FrameBus
  systemAudio: SystemAudioSource
  queue: TranscribeQueue
  stt: () => SttEngine | null
  settings: () => Settings
  /** Where transcripts go when `settings.meetings.folder` is null. */
  defaultFolder: string
  persist: (record: MeetingRecord) => void
  now?: () => number
  log?: Logger
}

export interface MeetingRecorderEvents {
  changed: [MeetingEvent]
  completed: [MeetingRecord]
}

interface Session {
  id: string
  title: string
  appBundleId: string | null
  startedAt: number
  writer: TranscriptWriter
  lease: CaptureLease
  unsubscribe: () => void
  segmenters: Record<MeetingTrack, TrackSegmenter>
  holdback: MicHoldback
  hasSystemAudio: boolean
  segments: MeetingSegment[]
  /** Transcribed but not yet written — see `#flush` for why they wait. */
  pending: MeetingSegment[]
  /** Only when `meetings.keepAudio` is on. */
  audio: { me: WavStreamWriter; them: WavStreamWriter | null } | null
  /** Last time the tap delivered anything, for the silent-death watchdog. */
  lastSystemFrameAt: number
  /** Suspended by the machine sleeping; frames are expected to stop. */
  suspended: boolean
  /** Set while the far end is audible, so mic bleed can be suspected. */
  systemSpeakingUntil: number
  degraded: string | null
  inFlight: number
}

export class MeetingRecorder extends EventEmitter<MeetingRecorderEvents> {
  readonly #deps: MeetingRecorderDeps
  readonly #log: Logger
  readonly #now: () => number
  #session: Session | null = null
  #offer: { title: string; appBundleId: string | null } | null = null
  #ticker: NodeJS.Timeout | null = null
  #stopping = false

  constructor(deps: MeetingRecorderDeps) {
    super()
    this.#deps = deps
    this.#log = deps.log ?? createLogger('meeting')
    this.#now = deps.now ?? (() => Date.now())
  }

  get recording(): boolean {
    return this.#session !== null
  }

  state(): MeetingEvent {
    const session = this.#session
    if (session) {
      return {
        state: this.#stopping ? 'finishing' : 'recording',
        id: session.id,
        title: session.title,
        elapsedMs: Math.max(0, this.#now() - session.startedAt),
        segmentCount: session.segments.length,
        hasSystemAudio: session.hasSystemAudio,
        degraded: session.degraded,
      } as MeetingEvent
    }
    if (this.#offer) {
      return { state: 'offered', title: this.#offer.title, appBundleId: this.#offer.appBundleId }
    }
    return MEETING_IDLE
  }

  /** Raise the consent prompt. Ignored while already recording. */
  offer(title: string, appBundleId: string | null): void {
    if (this.#session || this.#offer) return
    this.#offer = { title, appBundleId }
    this.#emit()
  }

  clearOffer(): void {
    if (!this.#offer) return
    this.#offer = null
    this.#emit()
  }

  async start(title: string, appBundleId: string | null): Promise<MeetingEvent> {
    const settings = this.#deps.settings()
    if (!settings.meetings.enabled) {
      throw new Error('Meeting capture is turned off in Settings.')
    }
    if (this.#session) return this.state()

    this.#offer = null
    const startedAt = this.#now()
    const id = randomUUID()
    const name = title.trim() || (appBundleId ? `Meeting (${appBundleId})` : 'Meeting')
    const folder = settings.meetings.folder ?? this.#deps.defaultFolder

    // The far side is best-effort: a denied or broken tap must degrade to
    // mic-only rather than refuse to record anything at all.
    let hasSystemAudio = false
    try {
      hasSystemAudio = await this.#deps.systemAudio.start((frame) => this.#onSystemFrame(frame))
    } catch (error) {
      this.#log.warn(`system audio unavailable: ${describe(error)}`)
    }

    let writer: TranscriptWriter
    try {
      writer = new TranscriptWriter(transcriptPath(folder, name, new Date(startedAt)), {
        title: name,
        startedAt: new Date(startedAt),
        appBundleId,
        sttModelId: settings.sttModelId ?? 'unknown',
        hasSystemAudio,
      })
    } catch (error) {
      this.#deps.systemAudio.stop()
      // Almost always the Documents folder's own permission prompt being
      // declined. Say which folder, because "EPERM" helps nobody.
      throw new Error(`Could not create the transcript in ${folder}: ${describe(error)}`, {
        cause: error,
      })
    }

    // The recording itself, when asked for. Deliberately its own setting
    // rather than riding on `audioRetention`, which is about dictation: one
    // switch controlling both a few MB of utterances and a 350 MB meeting
    // would be a bad control.
    let audio: Session['audio'] = null
    if (settings.meetings.keepAudio) {
      try {
        const base = writer.path.replace(/\.md$/, '')
        audio = {
          me: new WavStreamWriter(`${base} (you).wav`, AUDIO.sampleRate),
          them: hasSystemAudio ? new WavStreamWriter(`${base} (them).wav`, AUDIO.sampleRate) : null,
        }
      } catch (error) {
        // Losing the audio must never cost the transcript.
        this.#log.warn(`could not keep the meeting audio: ${describe(error)}`)
        audio = null
      }
    }

    const lease = this.#deps.capture.acquire('meeting')
    const unsubscribe = this.#deps.frames.subscribe((frame) => this.#onMicFrame(frame))

    this.#session = {
      id,
      title: name,
      appBundleId,
      startedAt,
      writer,
      lease,
      unsubscribe,
      segmenters: { me: new TrackSegmenter('me'), them: new TrackSegmenter('them') },
      holdback: new MicHoldback(),
      hasSystemAudio,
      segments: [],
      pending: [],
      audio,
      lastSystemFrameAt: startedAt,
      suspended: false,
      systemSpeakingUntil: 0,
      degraded: null,
      inFlight: 0,
    }

    this.#log.info(`recording "${name}" -> ${writer.path}${hasSystemAudio ? '' : ' (mic only)'}`)
    this.#startTicker()
    this.#emit()
    return this.state()
  }

  async stop(): Promise<MeetingRecord | null> {
    const session = this.#session
    if (!session || this.#stopping) return null
    this.#stopping = true
    this.#emit()

    // Detach inputs first so nothing new arrives while we drain.
    session.unsubscribe()
    session.lease.release()
    this.#deps.systemAudio.stop()
    this.#stopTicker()

    for (const track of ['me', 'them'] as const) {
      const cut = session.segmenters[track].flush()
      if (cut) this.#transcribe(session, cut)
    }

    // Let queued segments land; a held mic segment may still be cancelled by a
    // system transcript that has not been transcribed yet.
    await this.#awaitDrain(session)
    for (const segment of session.holdback.drain()) this.#commit(session, segment)
    // Nothing else is coming, so ordering is settled — write the rest.
    this.#flush(session, { all: true })

    // Patch the WAV headers with their real lengths.
    session.audio?.me.close()
    session.audio?.them?.close()

    const endedAt = this.#now()
    const durationMs = Math.max(0, endedAt - session.startedAt)
    session.writer.close(new Date(endedAt), durationMs, session.segments.length)

    const record: MeetingRecord = {
      id: session.id,
      startedAt: session.startedAt,
      endedAt,
      title: session.title,
      path: session.writer.path,
      appBundleId: session.appBundleId,
      hadSystemAudio: session.hasSystemAudio,
      segmentCount: session.segments.length,
      durationMs,
    }

    this.#session = null
    this.#stopping = false
    try {
      this.#deps.persist(record)
    } catch (error) {
      this.#log.error(`could not save the meeting row: ${describe(error)}`)
    }
    this.#log.info(`finished "${record.title}" — ${record.segmentCount} segments`)
    this.emit('completed', record)
    this.#emit()
    return record
  }

  async dispose(): Promise<void> {
    this.#stopTicker()
    if (this.#session) await this.stop()
    this.removeAllListeners()
  }

  /**
   * Feed the system-audio track directly.
   *
   * For the agent harness and dev tools: it is how the two-track pipeline —
   * speaker attribution, the echo holdback, ordering across tracks — gets
   * exercised end to end without a real call, a real tap, or a granted
   * permission. Production audio arrives through the `SystemAudioSource`
   * listener instead.
   */
  pushSystemFrame(frame: Float32Array): void {
    this.#onSystemFrame(frame)
  }

  // -- audio ---------------------------------------------------------------

  #onMicFrame(frame: Float32Array): void {
    const session = this.#session
    if (!session || session.suspended) return
    session.audio?.me.append(frame)
    const cut = session.segmenters.me.push(frame)
    if (cut) this.#transcribe(session, cut)
  }

  #onSystemFrame(frame: Float32Array): void {
    const session = this.#session
    if (!session || session.suspended) return
    session.lastSystemFrameAt = this.#now()
    session.audio?.them?.append(frame)
    // Remember that the far end is audible, so a quiet mic segment overlapping
    // it can be *suspected* of being bleed. Suspicion only ever delays.
    if (frameRms(frame, 0, frame.length) > 0.01) {
      session.systemSpeakingUntil = this.#now() + 400
    }
    const cut = session.segmenters.them.push(frame)
    if (cut) this.#transcribe(session, cut)
  }

  // -- transcription -------------------------------------------------------

  #transcribe(session: Session, cut: MeetingSegmentCut): void {
    const engine = this.#deps.stt()
    if (!engine) {
      this.#degrade(session, 'the speech engine is not loaded')
      return
    }

    const settings = this.#deps.settings()
    const suspect =
      cut.track === 'me' &&
      session.hasSystemAudio &&
      (looksLikeBleed(rmsOf(cut.pcm), peakOf(cut.pcm), this.#now() < session.systemSpeakingUntil) ||
        this.#now() - session.startedAt < MEETING.warmupMs)

    session.inFlight += 1
    this.#deps.queue
      .submit('background', () =>
        engine.transcribe(cut.pcm, {
          language: settings.language,
          vocabulary: [],
        }),
      )
      .then((transcript) => {
        if (this.#session !== session) return
        const text = transcript.text.trim()
        if (!text) return

        const segment: MeetingSegment = {
          id: randomUUID(),
          track: cut.track,
          startMs: cut.startMs,
          endMs: cut.endMs,
          text,
        }

        if (cut.track === 'them') {
          // Recording the far side's words is what lets a held mic segment be
          // recognised as an echo of them.
          session.holdback.noteSystem(text, this.#now())
          this.#commit(session, segment)
        } else {
          const release = session.holdback.offer(segment, suspect, this.#now())
          if (release) this.#commit(session, release)
        }

        for (const due of session.holdback.due(this.#now())) this.#commit(session, due)
        if (session.degraded) this.#recover(session)
      })
      .catch((error: unknown) => {
        if (this.#session !== session) return
        this.#degrade(session, describe(error))
      })
      .finally(() => {
        session.inFlight -= 1
      })
  }

  /**
   * Queue a finished segment for writing, in start-time order.
   *
   * Arrivals are genuinely unordered: the two tracks are cut independently, and
   * the echo policy can hold a mic segment back for seconds while a later
   * system segment sails past it. Appending in arrival order would interleave
   * the conversation wrongly — "You" answering a question that appears three
   * lines further down.
   *
   * So segments wait in a small reorder buffer and are flushed once nothing
   * still in flight could precede them. `flushAll` forces the rest out when the
   * recording ends.
   */
  #commit(session: Session, segment: MeetingSegment): void {
    session.pending.push(segment)
    this.#flush(session, { all: false })
  }

  /**
   * Write everything that can no longer be overtaken.
   *
   * A segment is safe once it is older than the furthest-back thing still
   * arriving — which is the holdback window, since that is the longest a mic
   * segment can be delayed. Anything older than that has had its chance.
   */
  #flush(session: Session, options: { all: boolean }): void {
    if (session.pending.length === 0) return
    session.pending.sort((a, b) => a.startMs - b.startMs || a.track.localeCompare(b.track))

    const horizon = options.all
      ? Number.POSITIVE_INFINITY
      : Math.max(0, this.#now() - session.startedAt) - MEETING.micHoldbackMs - MEETING.maxSegmentMs

    while (session.pending.length > 0) {
      const next = session.pending[0]
      if (!next || next.startMs > horizon) break
      session.pending.shift()
      session.segments.push(next)
      if (!session.writer.append(next)) {
        this.#fail(session.writer.failure ?? 'the transcript could not be written')
        return
      }
    }
    this.#emit()
  }

  /**
   * Transcription is failing but capture is not.
   *
   * The meeting keeps recording: an engine that crash-loops for thirty seconds
   * should cost thirty seconds of transcript, marked honestly, not the whole
   * remaining hour.
   */
  #degrade(session: Session, reason: string): void {
    if (session.degraded === reason) return
    session.degraded = reason
    this.#log.warn(`transcription degraded: ${reason}`)
    session.writer.gap(
      'transcription unavailable',
      Math.max(0, this.#now() - session.startedAt),
      Math.max(0, this.#now() - session.startedAt),
    )
    this.#emit()
  }

  #recover(session: Session): void {
    session.degraded = null
    this.#emit()
  }

  /** Unrecoverable: stop rather than pretend to be recording. */
  #fail(message: string): void {
    this.#log.error(`stopping the meeting: ${message}`)
    void this.stop().then(() => {
      this.emit('changed', { state: 'error', message })
    })
  }

  async #awaitDrain(session: Session): Promise<void> {
    const deadline = this.#now() + 30_000
    while (session.inFlight > 0 && this.#now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }

  // -- state ---------------------------------------------------------------

  #startTicker(): void {
    this.#stopTicker()
    this.#ticker = setInterval(() => {
      this.#watchSystemAudio()
      const session = this.#session
      if (session) this.#flush(session, { all: false })
      this.#emit()
    }, MEETING.tickMs)
    this.#ticker.unref?.()
  }

  /**
   * Notice the tap dying quietly and rebuild it.
   *
   * This is the failure mode most likely to ruin a recording, because it makes
   * no noise at all: the aggregate device is clocked against the output device,
   * so connecting AirPods mid-call can leave the IOProc running and delivering
   * nothing. There is no error, no exit, no callback — just a transcript that
   * silently stops having anyone else in it.
   */
  #watchSystemAudio(): void {
    const session = this.#session
    if (!session || !session.hasSystemAudio || session.suspended || this.#stopping) return
    if (this.#now() - session.lastSystemFrameAt < MEETING.systemAudioWatchdogMs) return

    this.#log.warn('system audio went quiet; rebuilding the tap')
    session.lastSystemFrameAt = this.#now()
    this.#deps.systemAudio.stop()
    void this.#deps.systemAudio
      .start((frame) => this.#onSystemFrame(frame))
      .then((ok) => {
        if (this.#session !== session) return
        if (!ok) {
          // Keep recording the microphone rather than ending the meeting.
          session.hasSystemAudio = false
          this.#log.warn('could not restart system audio; continuing microphone-only')
          this.#emit()
        }
      })
      .catch((error: unknown) => {
        this.#log.warn(`system audio restart failed: ${describe(error)}`)
      })
  }

  /**
   * The machine is going to sleep.
   *
   * Frames stop either way; the point is to mark the break honestly rather
   * than leave a transcript that reads as if nobody spoke for two hours.
   */
  suspend(): void {
    const session = this.#session
    if (!session || session.suspended) return
    session.suspended = true
    this.#log.info('sleeping — pausing the meeting')

    for (const track of ['me', 'them'] as const) {
      const cut = session.segmenters[track].flush()
      if (cut) this.#transcribe(session, cut)
    }
    this.#deps.systemAudio.stop()
    const at = Math.max(0, this.#now() - session.startedAt)
    session.writer.gap('asleep', at, at)
  }

  /** Woken up: bring the far side back. */
  resume(): void {
    const session = this.#session
    if (!session || !session.suspended) return
    session.suspended = false
    session.lastSystemFrameAt = this.#now()
    this.#log.info('woke — resuming the meeting')

    if (!session.hasSystemAudio) return
    void this.#deps.systemAudio
      .start((frame) => this.#onSystemFrame(frame))
      .catch(() => {
        session.hasSystemAudio = false
        this.#emit()
      })
  }

  #stopTicker(): void {
    if (this.#ticker) clearInterval(this.#ticker)
    this.#ticker = null
  }

  #emit(): void {
    this.emit('changed', this.state())
  }
}

function rmsOf(pcm: Float32Array): number {
  return frameRms(pcm, 0, pcm.length)
}

function peakOf(pcm: Float32Array): number {
  let peak = 0
  for (let i = 0; i < pcm.length; i += 1) {
    const v = Math.abs(pcm[i] ?? 0)
    if (v > peak) peak = v
  }
  return peak
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
