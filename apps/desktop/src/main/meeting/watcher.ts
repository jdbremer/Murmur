import { execFile } from 'node:child_process'

import type { Settings } from '@murmur/shared'

import { MEETING } from '../config'
import { createLogger, type Logger } from '../logging'
import { native } from '../native'
import { MeetingDetector, type AudioProcessSnapshot } from './detector'
import type { MeetingRecorder } from './recorder'

/**
 * Polls for meetings and offers to record them (PLAN §18.2).
 *
 * Owns the *policy* around the detector's verdict: whether to poll at all,
 * whether to ask or just start, and how to name what it found. The detector
 * itself stays a pure decision function so the interesting rules can be tested
 * without any of this.
 *
 * **Nothing here runs unless the user opted in.** `settings.meetings.enabled`
 * and `autoDetect` are checked every tick, and when either is false the timer
 * is torn down rather than left spinning on a discarded result — the promise
 * that "off" means inert rather than merely quiet has to be true in the code,
 * not just in the copy.
 */
export class MeetingWatcher {
  readonly #recorder: MeetingRecorder
  readonly #settings: () => Settings
  readonly #listProcesses: () => Promise<AudioProcessSnapshot[]>
  readonly #detector: MeetingDetector
  readonly #log: Logger
  #timer: NodeJS.Timeout | null = null
  #busy = false

  constructor(options: {
    recorder: MeetingRecorder
    settings: () => Settings
    listProcesses: () => Promise<AudioProcessSnapshot[]>
    log?: Logger
  }) {
    this.#recorder = options.recorder
    this.#settings = options.settings
    this.#listProcesses = options.listProcesses
    this.#log = options.log ?? createLogger('meeting')
    this.#detector = new MeetingDetector(this.#log)
  }

  /** Idempotent: safe to call whenever settings change. */
  sync(): void {
    const meetings = this.#settings().meetings
    const wanted = meetings.enabled && meetings.autoDetect
    if (wanted === Boolean(this.#timer)) return
    if (wanted) this.#start()
    else this.stop()
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = null
    this.#detector.reset()
  }

  dispose(): void {
    this.stop()
  }

  #start(): void {
    this.#log.info('watching for meetings')
    this.#timer = setInterval(() => void this.#tick(), MEETING.detectPollMs)
    this.#timer.unref?.()
  }

  async #tick(): Promise<void> {
    // Overlapping ticks would double-count dwell if a poll ever ran long.
    if (this.#busy) return
    this.#busy = true
    try {
      const meetings = this.#settings().meetings
      if (!meetings.enabled || !meetings.autoDetect) {
        this.stop()
        return
      }
      if (this.#recorder.recording) return

      const processes = await this.#listProcesses()
      const verdict = this.#detector.evaluate({
        processes,
        titleFor: (pid) => windowTitle(pid),
        now: Date.now(),
      })
      if (verdict.kind !== 'meeting') return

      const remembered = meetings.autoRecord[verdict.candidate.bundleId] ?? 'ask'
      if (remembered === 'never') return
      if (remembered === 'always') {
        await this.#recorder.start(verdict.name, verdict.candidate.bundleId)
        return
      }
      // Offer rather than record. Someone else is in the room and has not
      // agreed to anything; a prompt is the difference between a feature and
      // a surprise.
      this.#recorder.offer(verdict.name, verdict.candidate.bundleId)
    } catch (error) {
      this.#log.warn(`meeting detection failed: ${String(error)}`)
    } finally {
      this.#busy = false
    }
  }

  /** The user declined — stay quiet about this app for a while. */
  declined(bundleId: string | null): void {
    if (bundleId) this.#detector.decline(bundleId, Date.now())
    else this.#detector.reset()
  }
}

/**
 * Window title for a pid, via the accessibility API.
 *
 * Scoped deliberately: called only for a process that already looks like a
 * live call, only while a candidate is being watched, and never logged. It is
 * the only way to tell a Google Meet tab from any other tab, and the only
 * source of a real meeting name for browser-hosted calls.
 */
function windowTitle(pid: number): string | null {
  const result = native().getWindowTitle?.(pid)
  if (!result?.ok) return null
  const title = (result.title ?? '').trim()
  return title.length > 0 ? title : null
}

/**
 * Audio processes, from the tap helper's `--list` mode.
 *
 * Enumeration needs no permission at all — only *capturing* does — so this is
 * safe to run on a timer for a user who has never granted anything.
 */
export function listAudioProcessesVia(binary: string): () => Promise<AudioProcessSnapshot[]> {
  return () =>
    new Promise<AudioProcessSnapshot[]>((resolve) => {
      execFile(binary, ['--list'], { timeout: 2_000 }, (error, stdout) => {
        if (error) {
          resolve([])
          return
        }
        try {
          const parsed = JSON.parse(stdout) as { processes?: AudioProcessSnapshot[] }
          resolve(parsed.processes ?? [])
        } catch {
          resolve([])
        }
      })
    })
}
