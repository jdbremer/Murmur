import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { HotkeyConfig, MurmurNative } from '@murmur/shared'

import { HOTKEY } from '../src/main/config'
import { HotkeyBridge, type HotkeyIntents } from '../src/main/dictation/hotkey'

/**
 * The hotkey bridge (PLAN §2.1, §4) — the timing rules and, above all, the
 * physical-state watchdog.
 *
 * The watchdog exists because of a field bug: on long dictations the release
 * edge sometimes never arrived (a tap disabled for slowness, another app's
 * active tap in the chain), and a hold that never ends is a dictation that
 * never stops. These tests replay that exact failure.
 */

interface Recorded {
  begins: number
  ends: number
  /** Ends the bridge flagged as possibly the opening half of a double-tap. */
  endsFromTap: number
  toggles: number
}

function config(overrides: Partial<HotkeyConfig> = {}): HotkeyConfig {
  return {
    key: 'fn',
    customKeyCode: null,
    activation: 'hold',
    doubleTapHandsFree: true,
    ...overrides,
  }
}

let physicallyDown: { current: boolean }
let handsFree: { current: boolean }
let recorded: Recorded
let bridge: HotkeyBridge

function makeNative(): MurmurNative {
  return {
    available: true,
    startHotkeyListener: () => true,
    stopHotkeyListener: () => undefined,
    releaseHotkeyLatch: () => undefined,
    hotkeyPhysicallyDown: () => physicallyDown.current,
    sendPasteShortcut: () => ({ ok: false, error: 'test' }),
    getTextBeforeCursor: () => ({ ok: false, error: 'test' }),
    insertTextViaAccessibility: () => ({ ok: false, error: 'test' }),
    getSelectedText: () => ({ ok: true, text: '' }),
    getFrontmostApp: () => null,
    isSecureInputActive: () => false,
    permissions: {
      check: () => ({
        microphone: 'unavailable',
        accessibility: 'unavailable',
        inputMonitoring: 'unavailable',
      }),
      request: async () => 'unavailable',
      openSettings: () => undefined,
    },
    platformInfo: () => 'test',
  }
}

function makeBridge(
  hotkeyConfig: HotkeyConfig = config(),
  native: () => MurmurNative = makeNative,
): HotkeyBridge {
  const intents: HotkeyIntents = {
    begin: () => {
      recorded.begins += 1
    },
    end: (options) => {
      recorded.ends += 1
      recorded.endsFromTap += options?.fromTap === true ? 1 : 0
    },
    toggleHandsFree: () => {
      recorded.toggles += 1
      handsFree.current = !handsFree.current
    },
    isHandsFree: () => handsFree.current,
  }
  const silentLog = {
    debug() {},
    info() {},
    warn() {},
    error() {},
    child() {
      return silentLog
    },
  }
  const built = new HotkeyBridge({
    native,
    intents,
    log: silentLog,
  })
  built.start(hotkeyConfig)
  return built
}

beforeEach(() => {
  vi.useFakeTimers()
  physicallyDown = { current: false }
  handsFree = { current: false }
  recorded = { begins: 0, ends: 0, endsFromTap: 0, toggles: 0 }
  bridge = makeBridge()
})

afterEach(() => {
  bridge.stop()
  vi.useRealTimers()
})

function press(type: 'down' | 'up' | 'doubleTap', synthetic = false): void {
  bridge.handle({ type, timestamp: Date.now(), ...(synthetic ? { synthetic: true } : {}) })
}

describe('hold activation', () => {
  it('down begins, up ends', () => {
    physicallyDown.current = true
    press('down')
    expect(recorded.begins).toBe(1)

    vi.advanceTimersByTime(600)
    physicallyDown.current = false
    press('up')
    expect(recorded.ends).toBe(1)
  })

  it('ignores a repeated down while already held', () => {
    physicallyDown.current = true
    press('down')
    vi.advanceTimersByTime(50)
    press('down') // auto-repeat / delivery noise
    expect(recorded.begins).toBe(1)
    expect(recorded.toggles).toBe(0)
  })
})

describe('releaseLatch', () => {
  /**
   * The orchestrator calls this after a cancel or a failure. Clearing the
   * native latch alone would leave the bridge believing the press is still in
   * progress, and the repeated-down guard above would then swallow the user's
   * next press — a dictation that silently never starts again.
   */
  it('forgets the in-progress press, so the next down still begins', () => {
    physicallyDown.current = true
    press('down')
    expect(recorded.begins).toBe(1)

    // Mid-hold failure: orchestrator cancels and clears the latch. The
    // trailing physical `up` never arrives (it was swallowed or lost).
    bridge.releaseLatch()
    physicallyDown.current = false

    vi.advanceTimersByTime(50)
    physicallyDown.current = true
    press('down')
    expect(recorded.begins).toBe(2)
  })

  it('tells the native layer too', () => {
    let released = 0
    const counting = makeBridge(config(), () => ({
      ...makeNative(),
      releaseHotkeyLatch: () => {
        released += 1
      },
    }))
    counting.releaseLatch()
    expect(released).toBe(1)
    counting.stop()
  })

  it('survives a native module that throws', () => {
    // Older native builds predate releaseHotkeyLatch entirely.
    const throwing = makeBridge(config(), () => ({
      ...makeNative(),
      releaseHotkeyLatch: () => {
        throw new Error('older native build')
      },
    }))
    expect(() => throwing.releaseLatch()).not.toThrow()
    throwing.stop()
  })
})

describe('the physical-state watchdog', () => {
  it('reconciles a lost release: the HID says up, so the utterance ends', () => {
    physicallyDown.current = true
    press('down')
    expect(recorded.begins).toBe(1)

    // The user talks for a while, releases — and the up edge is lost.
    vi.advanceTimersByTime(5_000)
    physicallyDown.current = false

    // Two consecutive misses (one can race the release edge), then reconcile.
    vi.advanceTimersByTime(HOTKEY.physicalPollMs * 2 + 10)
    expect(recorded.ends).toBe(1)

    // The eventually-delivered real up (if any) is a harmless no-op shape:
    press('up')
    expect(recorded.ends).toBe(2) // orchestrator.end() while idle is a no-op
  })

  it('disables itself when the HID disagrees at arm time — the stale-binary tell', () => {
    // A murmur_native.node older than hotkeyPhysicallyDown answers through the
    // stub: always false. The tap just said "down", so an immediate false is
    // that stub, not the window server — and a watchdog fed by it would end
    // every real hold 250 ms in. It must stand down instead.
    physicallyDown.current = false
    press('down') // real (non-synthetic) edge, HID says "not held"
    vi.advanceTimersByTime(HOTKEY.physicalPollMs * 20)
    expect(recorded.ends).toBe(0)
    press('up')
    expect(recorded.ends).toBe(1)
  })

  it('does not fire while the key is genuinely held', () => {
    physicallyDown.current = true
    press('down')
    vi.advanceTimersByTime(HOTKEY.physicalPollMs * 40) // a 10 s hold
    expect(recorded.ends).toBe(0)
  })

  it('never arms for synthetic edges — simulate and SIGUSR2 have no key down', () => {
    physicallyDown.current = false // nobody is touching the keyboard
    press('down', true)
    vi.advanceTimersByTime(HOTKEY.physicalPollMs * 10)
    expect(recorded.ends).toBe(0) // a watchdog here would have killed the run
    press('up', true)
    expect(recorded.ends).toBe(1)
  })

  it('stands down when a double-tap latches hands-free', () => {
    physicallyDown.current = true
    press('doubleTap')
    expect(handsFree.current).toBe(true)
    physicallyDown.current = false
    vi.advanceTimersByTime(HOTKEY.physicalPollMs * 10)
    // Hands-free survives the release by design; no reconciliation may end it.
    expect(recorded.ends).toBe(0)
  })
})

describe('a tap that might open a double-tap', () => {
  it('flags the end, so an empty first tap stays quiet', () => {
    // The native tap reports the *second* press as `doubleTap`, not as another
    // `down`, so there is nothing pending here to wait for — the utterance has
    // to end now. Flagging it is what lets the orchestrator swallow the
    // "Didn't catch that" an empty first tap would otherwise flash a fraction
    // of a second before hands-free latches.
    press('down')
    vi.advanceTimersByTime(50)
    press('up')

    expect(recorded.ends).toBe(1)
    expect(recorded.endsFromTap).toBe(1)
  })

  it('does not flag a real hold, whose empty result is worth reporting', () => {
    press('down')
    vi.advanceTimersByTime(2_000)
    press('up')

    expect(recorded.ends).toBe(1)
    expect(recorded.endsFromTap).toBe(0)
  })

  it('does not flag a tap when double-tap-to-latch is switched off', () => {
    // With the gesture disabled a tap is unambiguous, so an empty one is a
    // genuine miss and the user should be told about it.
    bridge.stop()
    bridge = makeBridge(config({ doubleTapHandsFree: false }))

    press('down')
    vi.advanceTimersByTime(50)
    press('up')

    expect(recorded.ends).toBe(1)
    expect(recorded.endsFromTap).toBe(0)
  })
})

describe('double-tap', () => {
  it('latches on tap-then-tap and swallows the trailing up', () => {
    physicallyDown.current = true
    press('down')
    vi.advanceTimersByTime(100)
    press('up') // a 100 ms tap
    vi.advanceTimersByTime(100)
    press('down') // second tap, 200 ms after the first down
    expect(recorded.toggles).toBe(1)
    expect(handsFree.current).toBe(true)

    press('up')
    // Still exactly the one end() from the first tap: the latch's own trailing
    // up must not add another.
    expect(recorded.ends).toBe(1)
  })

  it('does NOT latch when a long hold is followed by a quick new press', () => {
    // The field bug: dictate (long hold), release, immediately press again.
    physicallyDown.current = true
    press('down')
    vi.advanceTimersByTime(HOTKEY.tapMaxMs + 40) // longer than a tap
    press('up')
    expect(recorded.ends).toBe(1)

    vi.advanceTimersByTime(HOTKEY.doubleTapMs - 60) // inside the double-tap window
    press('down')
    // A new dictation, not hands-free.
    expect(recorded.toggles).toBe(0)
    expect(recorded.begins).toBe(2)
  })

  it('a quick tap while hands-free is latched exits hands-free (PLAN §2.1)', () => {
    press('doubleTap')
    expect(handsFree.current).toBe(true)
    press('up') // the latch's own trailing up

    vi.advanceTimersByTime(2_000)
    physicallyDown.current = true
    press('down')
    vi.advanceTimersByTime(100)
    physicallyDown.current = false
    press('up') // a quick tap
    expect(handsFree.current).toBe(false)
    expect(recorded.toggles).toBe(2)
    expect(recorded.ends).toBe(0) // exited via toggle, not via end()
  })
})

describe('toggle activation', () => {
  it('down starts, next down stops, ups are ignored', () => {
    bridge.stop()
    bridge = makeBridge(config({ activation: 'toggle', doubleTapHandsFree: false }))

    press('down')
    expect(recorded.begins).toBe(1)
    press('up')
    expect(recorded.ends).toBe(0)
    vi.advanceTimersByTime(1_000)
    press('down')
    expect(recorded.ends).toBe(1)
  })
})

describe('start retry', () => {
  it('keeps retrying a refused tap and comes alive when the OS relents', () => {
    // The field case: booted before Input Monitoring was granted. The tap is
    // refused at start; the grant lands later. The key must recover without a
    // relaunch.
    let accepts = false
    const native = makeNative()
    native.startHotkeyListener = () => accepts

    bridge.stop()
    bridge = makeBridge(config(), () => native)
    expect(bridge.running).toBe(false)

    vi.advanceTimersByTime(HOTKEY.startRetryMs + 1)
    expect(bridge.running).toBe(false)

    accepts = true
    vi.advanceTimersByTime(HOTKEY.startRetryMs + 1)
    expect(bridge.running).toBe(true)
  })

  it('stop() cancels a pending retry', () => {
    let attempts = 0
    const native = makeNative()
    native.startHotkeyListener = () => {
      attempts += 1
      return false
    }

    bridge.stop()
    bridge = makeBridge(config(), () => native)
    const before = attempts
    bridge.stop()
    vi.advanceTimersByTime(HOTKEY.startRetryMs * 3)
    expect(attempts).toBe(before)
  })

  it('a rebind supersedes the retry of the older config', () => {
    let attempts: HotkeyConfig[] = []
    const native = makeNative()
    native.startHotkeyListener = (cfg: HotkeyConfig) => {
      attempts.push(cfg)
      return false
    }

    bridge.stop()
    attempts = []
    bridge = makeBridge(config(), () => native)
    bridge.rebind(config({ key: 'rightCmd' }))
    vi.advanceTimersByTime(HOTKEY.startRetryMs * 2 + 1)

    // Every attempt after the rebind must carry the new key.
    const afterRebind = attempts.slice(1)
    expect(afterRebind.length).toBeGreaterThan(0)
    expect(afterRebind.every((cfg) => cfg.key === 'rightCmd')).toBe(true)
  })
})
