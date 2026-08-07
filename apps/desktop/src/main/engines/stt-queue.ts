import type { Transcript } from '@murmur/shared'

/**
 * Serialises transcription so a meeting cannot slow a dictation down.
 *
 * ## Why this is a correctness requirement, not an optimisation
 *
 * Neither engine tolerates concurrent calls:
 *
 *  - **whisper.cpp** runs a single `whisper-server` whose `/inference`
 *    serialises on one `whisper_context`. A second POST blocks *inside the
 *    server*, invisible to us, while the caller's `TIMEOUTS.sttMs` counts down
 *    on a request that has not begun.
 *  - **ONNX** is worse: its host dispatches every message with a bare
 *    `void dispatch(request)` and no queue at all, so two overlapping calls
 *    interleave on the same encoder and decoder session objects. Nothing in
 *    the app has ever issued overlapping calls, so nothing guarantees that is
 *    safe.
 *
 * ## Why priority alone is not enough
 *
 * The obvious design lets dictation preempt an in-flight meeting segment via
 * its `AbortSignal`. That does not work: aborting the fetch frees our client,
 * but whisper-server has already started inference and runs it to completion,
 * so dictation waits anyway.
 *
 * What does work is **not starting background work when a dictation is
 * imminent**. `isBusy` reports whether the dictation loop is active, and it
 * goes true at hotkey-*down* — seconds before the transcription request
 * actually arrives. So the queue simply stops dequeuing meeting segments the
 * moment the user touches the key, and by the time dictation needs the engine
 * it is almost always already free.
 *
 * The residual worst case is one segment that had already started, which is
 * why `MEETING.maxSegmentMs` is capped at 15 s rather than 25 s.
 */

export type JobPriority = 'interactive' | 'background'

type Job = {
  priority: JobPriority
  run: () => Promise<Transcript>
  resolve: (value: Transcript) => void
  reject: (error: unknown) => void
}

export interface TranscribeQueueDeps {
  /**
   * True while the dictation loop is mid-utterance. Background work is held
   * back whenever this is true.
   */
  isBusy: () => boolean
}

export class TranscribeQueue {
  readonly #deps: TranscribeQueueDeps
  readonly #pending: Job[] = []
  #running = false
  /** Re-check for releasable background work after dictation finishes. */
  #wakeTimer: NodeJS.Timeout | null = null

  constructor(deps: TranscribeQueueDeps) {
    this.#deps = deps
  }

  get depth(): number {
    return this.#pending.length
  }

  /**
   * Queue a transcription.
   *
   * `interactive` jumps ahead of every `background` job already waiting.
   */
  submit(priority: JobPriority, run: () => Promise<Transcript>): Promise<Transcript> {
    return new Promise<Transcript>((resolve, reject) => {
      const job: Job = { priority, run, resolve, reject }
      if (priority === 'interactive') {
        const at = this.#pending.findIndex((queued) => queued.priority === 'background')
        if (at === -1) this.#pending.push(job)
        else this.#pending.splice(at, 0, job)
      } else {
        this.#pending.push(job)
      }
      void this.#drain()
    })
  }

  /** Fail every queued job. Called when the meeting or the app stops. */
  clear(reason: string): void {
    const queued = this.#pending.splice(0, this.#pending.length)
    for (const job of queued) job.reject(new Error(reason))
    if (this.#wakeTimer) {
      clearTimeout(this.#wakeTimer)
      this.#wakeTimer = null
    }
  }

  async #drain(): Promise<void> {
    if (this.#running) return
    const job = this.#next()
    if (!job) return

    this.#running = true
    try {
      job.resolve(await job.run())
    } catch (error) {
      job.reject(error)
    } finally {
      this.#running = false
      void this.#drain()
    }
  }

  #next(): Job | undefined {
    const head = this.#pending[0]
    if (!head) return undefined

    // Hold background work while the user is dictating, but never hold an
    // interactive job — that is the one thing someone is waiting on.
    if (head.priority === 'background' && this.#deps.isBusy()) {
      this.#scheduleWake()
      return undefined
    }
    return this.#pending.shift()
  }

  /**
   * Poll for the dictation loop going idle.
   *
   * A callback would be tidier, but the orchestrator does not currently emit
   * "went idle" and giving it one would mean touching the dictation path for
   * the sake of a feature it knows nothing about. A 250 ms poll costs nothing
   * and stops entirely once the queue drains.
   */
  #scheduleWake(): void {
    if (this.#wakeTimer) return
    this.#wakeTimer = setTimeout(() => {
      this.#wakeTimer = null
      if (this.#pending.length > 0) void this.#drain()
    }, 250)
    this.#wakeTimer.unref?.()
  }
}
