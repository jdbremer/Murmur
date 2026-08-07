import { MEETING } from '../config'
import { createLogger, type Logger } from '../logging'
import { matchMeetingApp, titleLooksLikeMeeting, titleToMeetingName, type MeetingApp } from './apps'

/**
 * Notices that a meeting has started (PLAN §18.2).
 *
 * The decision is a **pure function over a snapshot**, so the interesting part
 * — which combinations of signals should and should not fire — is testable
 * without CoreAudio, a calendar, or an actual meeting.
 *
 * ### Why "holds the microphone" is not enough on its own
 *
 * The tempting signal is the device-level "is anything recording" property.
 * It cannot work here: **Murmur holds the microphone warm for five minutes
 * after every dictation** and warms it at boot, so that property is very
 * nearly always true on this machine.
 *
 * What works is per-process input *and* output together, which macOS 14.2+
 * reports per audio process. A call is the only ordinary thing that does both
 * continuously — a voice memo is input-only, a YouTube tab is output-only.
 *
 * Even that is not sufficient alone: `com.apple.CoreSpeech` sets both flags
 * whenever dictation-adjacent system services are up. So the allowlist is
 * load-bearing, not an optimisation, and browsers need a title check on top
 * because a bundle id cannot tell Google Meet from any other tab.
 */

export interface AudioProcessSnapshot {
  pid: number
  bundleId: string | null
  runningInput: boolean
  runningOutput: boolean
}

export interface DetectorInput {
  processes: readonly AudioProcessSnapshot[]
  /** Window title for a pid, looked up only for candidates. */
  titleFor: (pid: number) => string | null
  now: number
}

export interface MeetingCandidate {
  pid: number
  bundleId: string
  app: MeetingApp
  title: string | null
  /** When this candidate first looked meeting-shaped. */
  since: number
}

/** What the detector concluded this tick. */
export type DetectorVerdict =
  | { kind: 'none' }
  | { kind: 'watching'; candidate: MeetingCandidate }
  | { kind: 'meeting'; candidate: MeetingCandidate; name: string }

/**
 * Which processes look like a live call right now, before any dwell.
 *
 * Exported for tests: this is the rule that decides false-positive rate.
 */
export function meetingShaped(
  processes: readonly AudioProcessSnapshot[],
): { pid: number; bundleId: string; app: MeetingApp }[] {
  const out: { pid: number; bundleId: string; app: MeetingApp }[] = []
  for (const process of processes) {
    if (!process.runningInput || !process.runningOutput) continue
    const app = matchMeetingApp(process.bundleId)
    if (!app || !process.bundleId) continue
    out.push({ pid: process.pid, bundleId: process.bundleId, app })
  }
  return out
}

export class MeetingDetector {
  readonly #log: Logger
  #candidate: MeetingCandidate | null = null
  /** bundleId → epoch ms until which we stay quiet after a decline. */
  readonly #cooldown = new Map<string, number>()
  #announced = false

  constructor(log?: Logger) {
    this.#log = log ?? createLogger('meeting')
  }

  /** Suppress offers for this app for a while — the user said no. */
  decline(bundleId: string, now: number): void {
    this.#cooldown.set(bundleId, now + MEETING.detectCooldownMs)
    this.#candidate = null
    this.#announced = false
  }

  /** Called when a recording starts or stops, so the next one can be offered. */
  reset(): void {
    this.#candidate = null
    this.#announced = false
  }

  evaluate(input: DetectorInput): DetectorVerdict {
    const shaped = meetingShaped(input.processes)

    // Keep the current candidate if it is still shaped; otherwise take the
    // first new one. Sticking to one candidate is what makes dwell meaningful.
    const still = this.#candidate
      ? shaped.find((entry) => entry.pid === this.#candidate?.pid)
      : undefined

    if (!still) {
      this.#candidate = null
      this.#announced = false
      const next = shaped.find((entry) => (this.#cooldown.get(entry.bundleId) ?? 0) <= input.now)
      if (!next) return { kind: 'none' }
      this.#candidate = {
        pid: next.pid,
        bundleId: next.bundleId,
        app: next.app,
        title: input.titleFor(next.pid),
        since: input.now,
      }
      return { kind: 'watching', candidate: this.#candidate }
    }

    const candidate = this.#candidate
    if (!candidate) return { kind: 'none' }

    // Refresh the title: a browser tab may not have navigated into the call
    // when we first noticed it holding audio.
    candidate.title = input.titleFor(candidate.pid) ?? candidate.title

    // A browser is only a meeting if its window says so.
    if (candidate.app.browser && !titleLooksLikeMeeting(candidate.title)) {
      return { kind: 'watching', candidate }
    }

    if (input.now - candidate.since < MEETING.detectDwellMs) {
      return { kind: 'watching', candidate }
    }

    if (this.#announced) return { kind: 'watching', candidate }
    this.#announced = true

    const name = candidate.title
      ? titleToMeetingName(candidate.title, candidate.app.name)
      : `${candidate.app.name} meeting`
    this.#log.info(`meeting detected in ${candidate.bundleId} — "${name}"`)
    return { kind: 'meeting', candidate, name }
  }
}
