import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { SystemAudioAccess, SystemAudioMode } from '@murmur/shared'

import { AUDIO, MEETING } from '../config'
import { createLogger, type Logger } from '../logging'
import { Downsampler } from './resample'

/**
 * Capturing the far side of a call (PLAN §18.2).
 *
 * ## Why this is an interface
 *
 * Two reasons, and the second is the one that pays every day.
 *
 * 1. macOS system audio has more than one plausible backend. CoreAudio process
 *    taps are the right choice today — narrower than ScreenCaptureKit, no
 *    purple recording indicator, no "your screen is being observed" — but the
 *    permission story around them is unusual enough that being able to swap
 *    backends without touching the recorder is worth the indirection.
 * 2. **It makes the whole meeting pipeline testable with no microphone, no
 *    CoreAudio and no permission.** `FakeSystemAudio` replays a WAV; nothing
 *    above this interface can tell the difference.
 *
 * ## Why a subprocess rather than the native addon
 *
 * A CoreAudio IOProc runs on a realtime thread where an allocation, a lock or
 * an N-API call does not just break our capture — it glitches the audio of the
 * call the user is actually in. Keeping that code in a separate process means
 * the realtime constraints live in a few hundred lines of Swift with no
 * JavaScript runtime anywhere near them, a crash dies with the subprocess
 * instead of taking down Murmur, and a leaked aggregate device is reaped by
 * the OS rather than lingering in Audio MIDI Setup.
 */

export type SystemAudioListener = (frame: Float32Array) => void

export interface SystemAudioSource {
  readonly mode: SystemAudioMode
  /** Whether this platform and OS version can do it at all. */
  capability(): { supported: boolean; reason: string }
  /** Cached permission verdict; probing is a separate, explicit act. */
  access(): SystemAudioAccess
  /**
   * Attempt a capture purely to trigger (and learn) the OS consent decision.
   *
   * macOS exposes no way to query `kTCCServiceAudioCapture`, so the attempt
   * *is* the request.
   */
  probe(): Promise<SystemAudioAccess>
  start(listener: SystemAudioListener): Promise<boolean>
  stop(): void
}

/** The helper's stderr protocol: one JSON object per line. */
interface TapEvent {
  type: 'start' | 'error' | 'format'
  code?: string
  message?: string
  sampleRate?: number
  channels?: number
}

/**
 * macOS 14.2+ CoreAudio process tap, via the bundled Swift helper.
 *
 * Reads raw float32 PCM from the helper's stdout and line-delimited JSON
 * control events from its stderr.
 */
export class NativeSystemAudio implements SystemAudioSource {
  readonly mode: SystemAudioMode = 'native'
  readonly #binary: string
  readonly #statusPath: string
  readonly #log: Logger
  #child: ChildProcessByStdio<null, Readable, Readable> | null = null
  #status: SystemAudioAccess['status'] = 'unknown'
  #detail = ''
  #resampler: Downsampler | null = null
  #carry: Float32Array = new Float32Array(0)

  constructor(options: { binary: string; statusPath: string; log?: Logger }) {
    this.#binary = options.binary
    this.#statusPath = options.statusPath
    this.#log = options.log ?? createLogger('meeting')
    this.#status = readStatus(options.statusPath)
  }

  capability(): { supported: boolean; reason: string } {
    if (process.platform !== 'darwin') {
      return { supported: false, reason: 'System audio capture is macOS-only for now.' }
    }
    if (!atLeastMacOS(14, 2)) {
      return {
        supported: false,
        reason:
          'Capturing other participants needs macOS 14.2 or later. Meetings will record your microphone only.',
      }
    }
    if (!existsSync(this.#binary)) {
      return { supported: false, reason: 'The system-audio helper is missing from this build.' }
    }
    return { supported: true, reason: '' }
  }

  access(): SystemAudioAccess {
    const capability = this.capability()
    if (!capability.supported) {
      return { mode: 'unsupported', status: 'unavailable', detail: capability.reason }
    }
    return { mode: 'native', status: this.#status, detail: this.#detail }
  }

  /**
   * Run the helper briefly and see whether real audio comes back.
   *
   * Two failure signatures, and we check both because they are not the same:
   * the helper reports `permission_denied` when CoreAudio refuses outright,
   * but a tap can also be created successfully and then deliver nothing but
   * digital silence. The second case is indistinguishable from success by
   * return code, so silence over the probe window is treated as a denial too.
   */
  async probe(): Promise<SystemAudioAccess> {
    const capability = this.capability()
    if (!capability.supported) {
      return { mode: 'unsupported', status: 'unavailable', detail: capability.reason }
    }

    let sawAudio = false
    const started = await this.start((frame) => {
      if (!sawAudio && frame.some((s) => s !== 0)) sawAudio = true
    })

    if (!started) {
      this.#remember('denied')
      return this.access()
    }

    // A modal TCC dialog blocks the helper, which is why the probe budget is
    // minutes rather than the seconds a normal start gets.
    await settle(Math.min(MEETING.systemAudioProbeMs, 4_000), () => sawAudio)
    this.stop()

    this.#remember(sawAudio ? 'granted' : 'denied')
    if (!sawAudio) {
      this.#detail =
        'macOS delivered silence instead of system audio, which is what a declined permission looks like.'
    }
    return this.access()
  }

  start(listener: SystemAudioListener): Promise<boolean> {
    if (this.#child) return Promise.resolve(true)
    const capability = this.capability()
    if (!capability.supported) return Promise.resolve(false)

    return new Promise<boolean>((resolve) => {
      let settled = false
      const done = (ok: boolean): void => {
        if (settled) return
        settled = true
        resolve(ok)
      }

      const child = spawn(this.#binary, [], { stdio: ['ignore', 'pipe', 'pipe'] })
      this.#child = child
      this.#resampler = null
      this.#carry = new Float32Array(0)

      child.stdout.on('data', (chunk: Buffer) => this.#onPcm(chunk, listener))
      child.stderr.on('data', (chunk: Buffer) => {
        for (const line of chunk.toString('utf8').split('\n')) {
          const event = parseEvent(line)
          if (!event) continue
          if (event.type === 'format') {
            this.#resampler = new Downsampler(event.sampleRate ?? 48_000, AUDIO.sampleRate)
            this.#log.info(`system audio: ${event.sampleRate} Hz -> ${AUDIO.sampleRate} Hz`)
          } else if (event.type === 'start') {
            this.#remember('granted')
            done(true)
          } else if (event.type === 'error') {
            this.#detail = event.message ?? 'System audio capture failed.'
            if (event.code === 'permission_denied') this.#remember('denied')
            this.#log.warn(`system audio helper: ${event.code} — ${this.#detail}`)
            done(false)
          }
        }
      })

      child.on('error', (error) => {
        this.#detail = error.message
        this.#log.error(`could not launch the system-audio helper: ${error.message}`)
        this.#child = null
        done(false)
      })
      child.on('exit', (code) => {
        this.#child = null
        if (code !== 0) this.#log.warn(`system-audio helper exited with code ${code}`)
        done(false)
      })

      setTimeout(() => done(Boolean(this.#child)), MEETING.systemAudioStartMs).unref?.()
    })
  }

  stop(): void {
    const child = this.#child
    if (!child) return
    this.#child = null
    child.kill('SIGTERM')
  }

  /**
   * Float32 samples arrive as a byte stream, so a chunk boundary can land
   * mid-sample. Carry the remainder rather than misaligning the whole stream.
   */
  #onPcm(chunk: Buffer, listener: SystemAudioListener): void {
    const bytes = Buffer.concat([
      Buffer.from(this.#carry.buffer, this.#carry.byteOffset, this.#carry.byteLength),
      chunk,
    ])
    const usable = bytes.byteLength - (bytes.byteLength % 4)
    if (usable <= 0) {
      this.#carry = new Float32Array(
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      )
      return
    }

    const samples = new Float32Array(usable / 4)
    for (let i = 0; i < samples.length; i += 1) samples[i] = bytes.readFloatLE(i * 4)

    const rest = bytes.subarray(usable)
    this.#carry = new Float32Array(
      rest.buffer.slice(rest.byteOffset, rest.byteOffset + rest.byteLength),
    )

    const resampler = this.#resampler
    const out = resampler ? resampler.process(samples) : samples
    if (out.length > 0) listener(out)
  }

  #remember(status: SystemAudioAccess['status']): void {
    if (this.#status === status) return
    this.#status = status
    writeStatus(this.#statusPath, status)
  }
}

/** Replays a WAV as the far side. Used by tests and the agent harness. */
export class FakeSystemAudio implements SystemAudioSource {
  readonly mode: SystemAudioMode = 'native'
  readonly #pcm: Float32Array
  #timer: NodeJS.Timeout | null = null
  #at = 0

  constructor(pcm: Float32Array) {
    this.#pcm = pcm
  }

  capability(): { supported: boolean; reason: string } {
    return { supported: true, reason: '' }
  }

  access(): SystemAudioAccess {
    return { mode: 'native', status: 'granted', detail: 'fake source' }
  }

  async probe(): Promise<SystemAudioAccess> {
    return this.access()
  }

  start(listener: SystemAudioListener): Promise<boolean> {
    const frame = Math.round((AUDIO.sampleRate * AUDIO.frameMs) / 1000)
    this.#timer = setInterval(() => {
      const chunk = this.#pcm.slice(this.#at, this.#at + frame)
      this.#at += frame
      if (chunk.length === 0) {
        this.#at = 0
        return
      }
      listener(chunk)
    }, AUDIO.frameMs)
    this.#timer.unref?.()
    return Promise.resolve(true)
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = null
  }
}

/** Meetings run mic-only: the platform cannot capture the far side. */
export class UnsupportedSystemAudio implements SystemAudioSource {
  readonly mode: SystemAudioMode = 'unsupported'
  readonly #reason: string

  constructor(reason: string) {
    this.#reason = reason
  }

  capability(): { supported: boolean; reason: string } {
    return { supported: false, reason: this.#reason }
  }

  access(): SystemAudioAccess {
    return { mode: 'unsupported', status: 'unavailable', detail: this.#reason }
  }

  async probe(): Promise<SystemAudioAccess> {
    return this.access()
  }

  async start(): Promise<boolean> {
    return false
  }

  stop(): void {}
}

// ---------------------------------------------------------------------------

export function systemAudioBinary(resourcesPath: string): string {
  return join(resourcesPath, 'macos-audio-tap')
}

function parseEvent(line: string): TapEvent | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith('{')) return null
  try {
    return JSON.parse(trimmed) as TapEvent
  } catch {
    return null
  }
}

function atLeastMacOS(major: number, minor: number): boolean {
  const [maj = 0, min = 0] = process
    .getSystemVersion?.()
    .split('.')
    .map((part) => Number.parseInt(part, 10)) ?? [0, 0]
  return maj > major || (maj === major && min >= minor)
}

/**
 * The verdict is persisted because there is no way to ask the OS for it, and
 * re-probing would re-prompt. Re-checked when the Hub regains focus, which is
 * when a user who just changed it in System Settings comes back.
 */
function readStatus(path: string): SystemAudioAccess['status'] {
  try {
    const raw = readFileSync(path, 'utf8').trim()
    if (raw === 'granted' || raw === 'denied') return raw
  } catch {
    /* first run */
  }
  return 'unknown'
}

function writeStatus(path: string, status: SystemAudioAccess['status']): void {
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, status, 'utf8')
  } catch {
    /* a lost cache costs one extra prompt, not correctness */
  }
}

function settle(budgetMs: number, done: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const started = Date.now()
    const tick = setInterval(() => {
      if (done() || Date.now() - started >= budgetMs) {
        clearInterval(tick)
        resolve()
      }
    }, 100)
    tick.unref?.()
  })
}
