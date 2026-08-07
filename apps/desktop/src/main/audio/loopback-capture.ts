import type { MainIpc, SystemAudioAccess, SystemAudioMode, WebContentsLike } from '@murmur/shared'

import { createLogger, type Logger } from '../logging'
import type { SystemAudioListener, SystemAudioSource } from './system-capture'

/**
 * Windows system audio, via Chromium's loopback capture (PLAN §18.2).
 *
 * The counterpart to the macOS tap helper, and much simpler: Electron can hand
 * a renderer a `getDisplayMedia` stream whose audio is the machine's output
 * mix, so the capture runs in the same hidden window that already owns the
 * microphone and arrives over the same IPC path.
 *
 * Two things are deliberately *not* here, and both matter:
 *
 *  - **No video, ever.** `setDisplayMediaRequestHandler` in `security.ts`
 *    answers with audio only, so no screen content is captured or enumerated.
 *  - **No permission prompt.** Windows has no consent gate for loopback, which
 *    is why `access()` reports `granted` outright rather than pretending to
 *    probe something.
 */
export class LoopbackSystemAudio implements SystemAudioSource {
  readonly mode: SystemAudioMode = 'loopback'
  readonly #ipc: MainIpc
  readonly #target: () => WebContentsLike | null
  readonly #log: Logger
  #listener: SystemAudioListener | null = null

  constructor(options: {
    ipc: MainIpc
    /** The hidden capture window, which owns the media stream. */
    target: () => WebContentsLike | null
    log?: Logger
  }) {
    this.#ipc = options.ipc
    this.#target = options.target
    this.#log = options.log ?? createLogger('meeting')
  }

  capability(): { supported: boolean; reason: string } {
    if (process.platform !== 'win32') {
      return { supported: false, reason: 'Loopback capture is Windows-only.' }
    }
    return { supported: true, reason: '' }
  }

  access(): SystemAudioAccess {
    const capability = this.capability()
    return capability.supported
      ? { mode: 'loopback', status: 'granted', detail: '' }
      : { mode: 'unsupported', status: 'unavailable', detail: capability.reason }
  }

  async probe(): Promise<SystemAudioAccess> {
    return this.access()
  }

  async start(listener: SystemAudioListener): Promise<boolean> {
    if (!this.capability().supported) return false
    const target = this.#target()
    if (!target) {
      this.#log.warn('capture renderer is gone; meeting will be microphone-only')
      return false
    }
    this.#listener = listener
    this.#ipc.emit(target, 'audio.command', { action: 'systemStart', deviceId: null })
    return true
  }

  stop(): void {
    this.#listener = null
    const target = this.#target()
    if (target) {
      this.#ipc.emit(target, 'audio.command', { action: 'systemStop', deviceId: null })
    }
  }

  /** Called by the IPC layer for each `audio.systemFrame` from the renderer. */
  push(frame: Float32Array): void {
    this.#listener?.(frame)
  }
}
