import type { MainIpc, WebContentsLike } from '@murmur/shared'

import { AUDIO } from '../config'
import { createLogger, type Logger } from '../logging'
import type { AudioController } from '../dictation/orchestrator'

/**
 * Drives the hidden capture renderer over IPC (PLAN §3.1, §5).
 *
 * The orchestrator says *when* the mic is open; this translates that into
 * `audio.command` events and owns one extra policy of its own: the **warm
 * window**. After an utterance the stream is left open for
 * {@link AUDIO.warmIdleMs} so the next hotkey-down does not pay `getUserMedia`'s
 * cold-start cost (~200–400 ms, which is a third of the entire latency budget
 * in PLAN §7.3). After that it is released, because holding a mic stream open
 * forever lights the macOS recording indicator and is exactly the kind of thing
 * that makes a privacy-first app look dishonest.
 */
export class CaptureController implements AudioController {
  readonly #ipc: MainIpc
  readonly #target: () => WebContentsLike | null
  readonly #log: Logger
  #warmTimer: NodeJS.Timeout | null = null
  #deviceId: string | null = null
  #open = false

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

  start(deviceId: string | null): void {
    this.#clearWarmTimer()
    this.#deviceId = deviceId
    this.#open = true
    this.#send('start', deviceId)
  }

  stop(): void {
    if (!this.#open) return
    this.#open = false
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
    this.#open = false
    this.#send('release', this.#deviceId)
  }

  /** Re-open on the new device — called when the mic setting changes. */
  setDevice(deviceId: string | null): void {
    if (deviceId === this.#deviceId) return
    this.#deviceId = deviceId
    this.#log.info('microphone changed; re-opening the stream')
    this.#send('release', null)
    this.#send('warm', deviceId)
    this.#armWarmTimer()
  }

  dispose(): void {
    this.#clearWarmTimer()
  }

  #armWarmTimer(): void {
    this.#clearWarmTimer()
    if (AUDIO.warmIdleMs <= 0) return
    this.#warmTimer = setTimeout(() => {
      this.#warmTimer = null
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
