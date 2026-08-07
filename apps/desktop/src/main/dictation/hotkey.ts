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
  /**
   * Finish the current utterance (push-to-talk up, or toggle-off).
   *
   * `fromTap` means the press was short enough to be the opening half of a
   * double-tap, so an empty result is expected rather than worth reporting.
   */
  end(options?: { fromTap?: boolean }): void
  /** Latch hands-free mode (or unlatch it — the intent is a toggle). */
  toggleHandsFree(): void
  /**
   * Is hands-free currently latched? PLAN §2.1's exit gesture is "tap again":
   * a quick tap while latched must stop hands-free rather than fire an empty
   * begin/end pair.
   */
  isHandsFree?(): boolean
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
  /** Whether the previous press ended as a quick tap (for tap-then-tap). */
  #lastPressWasTap = false
  /** Toggle mode only: whether a toggle-on is currently active. */
  #toggled = false
  /** Set when a double-tap latched, so the following `up` does not stop it. */
  #latched = false
  /**
   * While a *physical* hold is live, polls the HID system for the key's true
   * state. Event delivery can lose the up edge — the OS disables a slow tap,
   * another app's active tap swallows the event — and a lost up used to mean
   * the dictation never stopped. Never armed for synthetic edges: the HID
   * system rightly says "not held" for a key nobody pressed.
   */
  #watchdog: NodeJS.Timeout | null = null
  /**
   * Pending re-attempt after the OS refused to install the tap/hook. Booting
   * before Input Monitoring is granted must leave a key that comes alive when
   * the grant lands, not one that is dead until the next relaunch.
   */
  #startRetry: NodeJS.Timeout | null = null
  /** Log the refusal once per outage, not once per retry. */
  #startRetryLogged = false

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
      // Native returns `false` when the OS hook/tap could not be installed
      // (e.g. missing Input Monitoring on macOS, or WH_KEYBOARD_LL failure on Windows).
      const started = native.startHotkeyListener(config, (event) => this.handle(event))
      if (started === false) {
        this.#running = false
        if (!this.#startRetryLogged) {
          this.#startRetryLogged = true
          this.#log.warn(
            `native hotkey listener failed to start for ${describeKey(config)} — ` +
              `retrying every ${HOTKEY.startRetryMs} ms until the OS accepts it`,
          )
        }
        this.#scheduleStartRetry(config)
        return
      }
      this.#running = true
      if (this.#startRetryLogged) this.#log.info('hotkey listener recovered')
      this.#startRetryLogged = false
      this.#log.info(`listening for ${describeKey(config)}`)
    } catch (error) {
      this.#running = false
      this.#log.warn('native hotkey listener threw:', error)
      this.#scheduleStartRetry(config)
    }
  }

  #scheduleStartRetry(config: HotkeyConfig): void {
    if (this.#startRetry !== null) return
    this.#startRetry = setTimeout(() => {
      this.#startRetry = null
      // Settings may have moved on while we waited; the newest config wins.
      if (this.#config === config) this.start(config)
    }, HOTKEY.startRetryMs)
    this.#startRetry.unref?.()
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
    if (this.#startRetry !== null) {
      clearTimeout(this.#startRetry)
      this.#startRetry = null
    }
    this.#stopWatchdog()
    this.#downAt = null
    this.#lastDownAt = null
    this.#lastPressWasTap = false
    this.#toggled = false
    this.#latched = false
  }

  /**
   * Clear a stuck press, in the native layer *and* here.
   *
   * The orchestrator calls this after a cancel or a failure. Clearing only the
   * native side leaves this bridge believing a hold is still in progress:
   * `#downAt` stays set, and the guard in `handle('down')` then swallows the
   * user's next press as auto-repeat. The watchdog recovers a real hold after
   * two misses, but it is never armed for synthetic edges — so in the dev and
   * agent paths the hotkey would simply stop responding.
   */
  releaseLatch(): void {
    try {
      this.#native().releaseHotkeyLatch()
    } catch (error) {
      this.#log.warn('releasing the hotkey latch failed:', error)
    }
    this.#stopWatchdog()
    this.#downAt = null
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
        this.#stopWatchdog()
        if (config?.doubleTapHandsFree === false) return
        this.#latched = true
        this.#downAt = null
        this.#intents.toggleHandsFree()
        return
      }

      case 'down': {
        // A repeated down while already held is auto-repeat or delivery noise,
        // never a new press — counting it as one is how a single long hold
        // used to read as a double-tap.
        if (activation === 'hold' && this.#downAt !== null) return

        // Fallback double-tap detection for taps the native layer did not
        // classify itself. Tap-then-tap only: the previous press must have
        // *ended*, quickly — a long dictation hold followed by a fast new
        // press is two intents, not one gesture.
        const previous = this.#lastDownAt
        const previousWasTap = this.#lastPressWasTap
        this.#lastDownAt = now
        if (
          config?.doubleTapHandsFree !== false &&
          previous !== null &&
          previousWasTap &&
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
        if (event.synthetic !== true) this.#armWatchdog()
        return
      }

      case 'up': {
        this.#stopWatchdog()
        if (activation === 'toggle') return

        const downAt = this.#downAt
        this.#downAt = null
        const heldMs = downAt !== null ? now - downAt : null
        this.#lastPressWasTap = heldMs !== null && heldMs <= HOTKEY.tapMaxMs

        // A double-tap latched hands-free; the trailing `up` must not end it.
        if (this.#latched) {
          this.#latched = false
          return
        }

        // PLAN §2.1: while hands-free is latched, "tap again" exits it.
        if (this.#lastPressWasTap && this.#intents.isHandsFree?.() === true) {
          this.#intents.toggleHandsFree()
          return
        }

        if (heldMs !== null && heldMs < HOTKEY.minHoldMs) {
          // Too short to be a deliberate hold. End the utterance anyway — the
          // orchestrator's min-duration guard turns it into "no speech", which
          // is a clearer outcome than silently swallowing the key.
          this.#log.debug(`tap shorter than ${HOTKEY.minHoldMs} ms`)
        }

        // A tap while double-tap-to-latch is on is ambiguous *at this moment*:
        // the second press has up to `doubleTapMs` still to arrive, and the
        // native tap reports it as `doubleTap` rather than a second `down`, so
        // there is nothing here to wait on. Ending is still right — the audio
        // may hold a real word, since a 300 ms press carries 300 ms of pre-roll
        // — but an *empty* one must not flash "Didn't catch that" a moment
        // before hands-free latches. Telling the orchestrator the press was a
        // tap lets it stay quiet in exactly that case and nowhere else.
        const mightOpenADoubleTap = this.#lastPressWasTap && config?.doubleTapHandsFree !== false
        this.#intents.end({ fromTap: mightOpenADoubleTap })
        return
      }
    }
  }

  #armWatchdog(): void {
    this.#stopWatchdog()
    const native = this.#native()
    if (!native.available) return

    // Trust probe. The tap just delivered a physical down, so the HID system
    // must agree the key is held *right now*. If it says "not held" at this
    // instant, the answer is not coming from the window server — it is the
    // stub behind a stale native binary that predates hotkeyPhysicallyDown —
    // and a watchdog fed by that stub would end every real hold 250 ms in.
    // Disable reconciliation rather than become the bug it exists to fix.
    if (!native.hotkeyPhysicallyDown()) {
      this.#log.warn(
        'HID state disagrees immediately after a physical down — stale native build? ' +
          'Release reconciliation is disabled; run `npm run native:build`.',
      )
      return
    }

    let misses = 0
    this.#watchdog = setInterval(() => {
      if (this.#downAt === null) {
        this.#stopWatchdog()
        return
      }
      if (native.hotkeyPhysicallyDown()) {
        misses = 0
        return
      }
      // Two consecutive misses before reconciling: one read can race the
      // window server's own flag update on the release edge.
      misses += 1
      if (misses < 2) return
      this.#log.warn('hotkey release was lost in delivery; reconciling from HID state')
      this.#stopWatchdog()
      this.handle({ type: 'up', timestamp: this.#now(), synthetic: true })
    }, HOTKEY.physicalPollMs)
    this.#watchdog.unref?.()
  }

  #stopWatchdog(): void {
    if (this.#watchdog !== null) clearInterval(this.#watchdog)
    this.#watchdog = null
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
