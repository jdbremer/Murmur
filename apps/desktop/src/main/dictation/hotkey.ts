import type { HotkeyConfig, HotkeyEvent, MurmurNative } from '@murmur/shared'

import { HOTKEY } from '../config'
import { createLogger, type Logger } from '../logging'

/**
 * Turns raw hotkey edges from the native event tap into dictation intents
 * (PLAN §2.1, §4).
 *
 * The native module reports `down`, `up` and `doubleTap`; this class decides
 * what each means given the user's activation mode, and it is where the timing
 * rules live so they can be tested without an event tap:
 *
 *  - **hold** (default) — down starts, up finishes. A down/up pair shorter than
 *    {@link HOTKEY.minHoldMs} is discarded as a stray tap, which is what stops
 *    a mis-brushed `fn` from firing an empty dictation.
 *  - **toggle** — down starts, the next down finishes. Ups are ignored.
 *  - **double-tap** — two downs inside {@link HOTKEY.doubleTapMs} latch
 *    hands-free. The native module detects this itself (it has the precise
 *    timestamps), but the same rule is implemented here as a fallback for
 *    builds whose tap only reports down/up, and so the behaviour is testable.
 *
 * Nothing here reads key *content*: the tap is listen-only for the configured
 * hotkey, and no other key event is seen, logged or buffered (PLAN §10.5).
 */

export interface HotkeyIntents {
  /** Start dictating (push-to-talk down, or toggle-on). */
  begin(): void
  /** Finish the current utterance (push-to-talk up, or toggle-off). */
  end(): void
  /** Latch hands-free mode. */
  toggleHandsFree(): void
}

export interface HotkeyBridgeOptions {
  native: () => MurmurNative
  intents: HotkeyIntents
  log?: Logger
  now?: () => number
}

export class HotkeyBridge {
  readonly #native: () => MurmurNative
  readonly #intents: HotkeyIntents
  readonly #log: Logger
  readonly #now: () => number

  #config: HotkeyConfig | null = null
  #running = false
  #downAt: number | null = null
  #lastDownAt: number | null = null
  /** Toggle mode only: whether a toggle-on is currently active. */
  #toggled = false
  /** Set when a double-tap latched, so the following `up` does not stop it. */
  #latched = false

  constructor(options: HotkeyBridgeOptions) {
    this.#native = options.native
    this.#intents = options.intents
    this.#log = options.log ?? createLogger('hotkey')
    this.#now = options.now ?? (() => Date.now())
  }

  get running(): boolean {
    return this.#running
  }

  /** Start (or restart) the listener with `config`. Safe to call repeatedly. Never throws. */
  start(config: HotkeyConfig): void {
    this.stop()
    this.#config = config

    const native = this.#native()
    if (!native.available) {
      this.#log.warn('native module unavailable — the global hotkey will not work')
      return
    }

    // Incomplete custom bindings would throw from the native addon — refuse here
    // so bootstrap never dies with UnhandledPromiseRejection.
    if (config.key === 'custom' && (config.customKeyCode === null || config.customKeyCode < 0)) {
      this.#running = false
      this.#log.warn('custom hotkey has no customKeyCode — listener not started')
      return
    }

    try {
      // Native may return `false` when the OS hook/tap could not be installed
      // (e.g. missing Input Monitoring on macOS, or WH_KEYBOARD_LL failure on Windows).
      const started = native.startHotkeyListener(config, (event) => this.handle(event)) as
        | boolean
        | void
      if (started === false) {
        this.#running = false
        this.#log.warn(
          `native hotkey listener failed to start for ${describeKey(config)} — use debug.simulateHotkey`,
        )
        return
      }
      this.#running = true
      this.#log.info(`listening for ${describeKey(config)}`)
    } catch (error) {
      this.#running = false
      this.#log.warn('native hotkey listener threw:', error)
    }
  }

  stop(): void {
    if (this.#running) {
      try {
        this.#native().stopHotkeyListener()
      } catch (error) {
        this.#log.warn('stopping the hotkey listener failed:', error)
      }
    }
    this.#running = false
    this.#downAt = null
    this.#lastDownAt = null
    this.#toggled = false
    this.#latched = false
  }

  /** Rebind without losing the current state (settings change). */
  rebind(config: HotkeyConfig): void {
    if (this.#config && sameConfig(this.#config, config)) return
    this.#log.info('rebinding the hotkey')
    this.start(config)
  }

  /**
   * Handle one edge. Public so `debug.simulateHotkey` can drive the real
   * pipeline on a machine with no event tap.
   */
  handle(event: HotkeyEvent): void {
    const config = this.#config
    const activation = config?.activation ?? 'hold'
    const now = this.#now()

    switch (event.type) {
      case 'doubleTap': {
        if (config?.doubleTapHandsFree === false) return
        this.#latched = true
        this.#downAt = null
        this.#intents.toggleHandsFree()
        return
      }

      case 'down': {
        // Fallback double-tap detection for taps the native layer did not
        // classify itself.
        const previous = this.#lastDownAt
        this.#lastDownAt = now
        if (
          config?.doubleTapHandsFree !== false &&
          previous !== null &&
          now - previous <= HOTKEY.doubleTapMs
        ) {
          this.#latched = true
          this.#downAt = null
          this.#intents.toggleHandsFree()
          return
        }

        if (activation === 'toggle') {
          this.#toggled = !this.#toggled
          if (this.#toggled) this.#intents.begin()
          else this.#intents.end()
          return
        }

        this.#latched = false
        this.#downAt = now
        this.#intents.begin()
        return
      }

      case 'up': {
        if (activation === 'toggle') return

        const downAt = this.#downAt
        this.#downAt = null

        // A double-tap latched hands-free; the trailing `up` must not end it.
        if (this.#latched) {
          this.#latched = false
          return
        }

        if (downAt !== null && now - downAt < HOTKEY.minHoldMs) {
          // Too short to be a deliberate hold. End the utterance anyway — the
          // orchestrator's min-duration guard turns it into "no speech", which
          // is a clearer outcome than silently swallowing the key.
          this.#log.debug(`tap shorter than ${HOTKEY.minHoldMs} ms`)
        }
        this.#intents.end()
        return
      }
    }
  }
}

function sameConfig(a: HotkeyConfig, b: HotkeyConfig): boolean {
  return (
    a.key === b.key &&
    a.customKeyCode === b.customKeyCode &&
    a.activation === b.activation &&
    a.doubleTapHandsFree === b.doubleTapHandsFree
  )
}

function describeKey(config: HotkeyConfig): string {
  switch (config.key) {
    case 'fn':
      return 'fn (hold)'
    case 'rightCmd':
      return 'right ⌘'
    case 'rightOpt':
      return 'right ⌥'
    case 'rightCtrl':
      return 'Right Ctrl'
    case 'ctrlSpace':
      return 'Ctrl+Space'
    case 'altSpace':
      return 'Alt+Space'
    case 'capsLock':
      return 'Caps Lock'
    case 'custom':
      return `key code ${config.customKeyCode ?? '?'}`
  }
}
