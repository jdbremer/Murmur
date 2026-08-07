import type { MainIpc, WebContentsLike } from '@murmur/shared'

import { AUDIO } from '../config'
import { createLogger, type Logger } from '../logging'
import type { AudioController } from '../dictation/orchestrator'

/**
 * Drives the hidden capture renderer over IPC (PLAN §3.1, §5).
 *
 * Two consumers now want the microphone: the dictation orchestrator, which
 * needs it for a few seconds at a time, and the meeting recorder, which needs
 * it for an hour. So the mic is held by **leases** rather than by whoever
 * called `start()` last — the stream stays open while any lease is held, and
 * the warm window only begins once the last one is released.
 *
 * ### The warm window
 *
 * After an utterance the stream is left open for {@link AUDIO.warmIdleMs} so
 * the next hotkey-down does not pay `getUserMedia`'s cold-start cost (~200–400
 * ms, a third of the latency budget in PLAN §7.3). After that it is released,
 * because holding a mic stream open forever lights the macOS recording
 * indicator and is exactly the kind of thing that makes a privacy-first app
 * look dishonest.
 *
 * That timer is why leases exist rather than a plain counter. `setDevice` used
 * to send `release` then `warm`, and `warm` arms the timer — so changing the
 * microphone five minutes into a forty-minute meeting would have released the
 * stream mid-recording, silently, with no error anywhere.
 */

export interface CaptureLease {
  /** Re-open on a different device without disturbing other holders. */
  setDevice(deviceId: string | null): void
  release(): void
}

export class CaptureController implements AudioController {
  readonly #ipc: MainIpc
  readonly #target: () => WebContentsLike | null
  readonly #log: Logger
  #warmTimer: NodeJS.Timeout | null = null
  #deviceId: string | null = null
  /** Held by anything that needs frames right now. */
  readonly #leases = new Set<symbol>()
  /** True while the dictation path has the mic open, via the legacy calls. */
  #dictating = false

  constructor(options: {
    ipc: MainIpc
    /** The capture window's web contents, or `null` if it is gone. */
    target: () => WebContentsLike | null
    log?: Logger
  }) {
    this.#ipc = options.ipc
    this.#target = options.target
    this.#log = options.log ?? createLogger('audio')
  }

  /** True while any consumer wants frames. */
  get streaming(): boolean {
    return this.#dictating || this.#leases.size > 0
  }

  // -- AudioController: the dictation orchestrator's view -------------------
  //
  // Unchanged in shape on purpose. The orchestrator holds this interface and
  // its tests stub it; teaching it about leases would have meant touching the
  // one part of the app with the least room for error.

  start(deviceId: string | null): void {
    this.#clearWarmTimer()
    this.#deviceId = deviceId
    this.#dictating = true
    this.#send('start', deviceId)
  }

  stop(): void {
    if (!this.#dictating) return
    this.#dictating = false
    // A meeting may still be recording; only step down to `warm` when nothing
    // else is listening, and only arm the release timer if nothing is.
    if (this.#leases.size > 0) return
    this.#send('stop', this.#deviceId)
    this.#armWarmTimer()
  }

  warm(deviceId: string | null): void {
    this.#deviceId = deviceId
    this.#send('warm', deviceId)
    this.#armWarmTimer()
  }

  release(): void {
    this.#clearWarmTimer()
    this.#dictating = false
    if (this.#leases.size > 0) {
      this.#log.debug('release ignored — a meeting still holds the mic')
      return
    }
    this.#send('release', this.#deviceId)
  }

  /** Re-open on the new device — called when the mic setting changes. */
  setDevice(deviceId: string | null): void {
    if (deviceId === this.#deviceId) return
    this.#deviceId = deviceId
    this.#log.info('microphone changed; re-opening the stream')
    this.#send('release', null)
    // Re-open at the level the current holders need. Sending `warm` while a
    // meeting is recording would drop its frames on the floor, and arming the
    // idle timer would then close the stream out from under it.
    if (this.streaming) {
      this.#send('start', deviceId)
      this.#clearWarmTimer()
    } else {
      this.#send('warm', deviceId)
      this.#armWarmTimer()
    }
  }

  // -- Leases: long-lived consumers ----------------------------------------

  /**
   * Claim the microphone until the returned lease is released.
   *
   * @param owner a label, for logs when a lease outlives what created it
   */
  acquire(owner: string): CaptureLease {
    const key = Symbol(owner)
    this.#leases.add(key)
    this.#clearWarmTimer()
    this.#log.debug(`mic leased by ${owner} (${this.#leases.size} held)`)
    this.#send('start', this.#deviceId)

    let released = false
    return {
      setDevice: (deviceId) => {
        if (released) return
        this.setDevice(deviceId)
      },
      release: () => {
        if (released) return
        released = true
        this.#leases.delete(key)
        this.#log.debug(`mic lease released by ${owner} (${this.#leases.size} held)`)
        if (this.streaming) return
        this.#send('stop', this.#deviceId)
        this.#armWarmTimer()
      },
    }
  }

  dispose(): void {
    this.#clearWarmTimer()
    this.#leases.clear()
  }

  #armWarmTimer(): void {
    this.#clearWarmTimer()
    if (AUDIO.warmIdleMs <= 0) return
    this.#warmTimer = setTimeout(() => {
      this.#warmTimer = null
      // Re-check: a lease taken while the timer was pending must win.
      if (this.streaming) return
      this.#log.debug('mic idle — releasing the stream')
      this.#send('release', this.#deviceId)
    }, AUDIO.warmIdleMs)
    this.#warmTimer.unref?.()
  }

  #clearWarmTimer(): void {
    if (this.#warmTimer) clearTimeout(this.#warmTimer)
    this.#warmTimer = null
  }

  #send(action: 'warm' | 'start' | 'stop' | 'release', deviceId: string | null): void {
    const target = this.#target()
    if (!target) {
      this.#log.warn(`capture renderer is not available; dropped "${action}"`)
      return
    }
    this.#ipc.emit(target, 'audio.command', { action, deviceId })
  }
}
