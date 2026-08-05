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
    startHotkeyListener: () => undefined,
    stopHotkeyListener: () => undefined,
    hotkeyPhysicallyDown: () => physicallyDown.current,
    sendPasteShortcut: () => ({ ok: false, error: 'test' }),
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

function makeBridge(hotkeyConfig: HotkeyConfig = config()): HotkeyBridge {
  const intents: HotkeyIntents = {
    begin: () => {
      recorded.begins += 1
    },
    end: () => {
      recorded.ends += 1
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
    native: makeNative,
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
  recorded = { begins: 0, ends: 0, toggles: 0 }
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

describe('the physical-state watchdog', () => {
  it('reconciles a lost release: the HID says up, so the utterance ends', () => {
    physicallyDown.current = true
    press('down')
    expect(recorded.begins).toBe(1)

    // The user talks for a while, releases — and the up edge is lost.
    vi.advanceTimersByTime(5_000)
    physicallyDown.current = false

    // Within one poll interval the bridge notices and ends the utterance.
    vi.advanceTimersByTime(HOTKEY.physicalPollMs + 5)
    expect(recorded.ends).toBe(1)

    // The eventually-delivered real up (if any) is a harmless no-op shape:
    press('up')
    expect(recorded.ends).toBe(2) // orchestrator.end() while idle is a no-op
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
