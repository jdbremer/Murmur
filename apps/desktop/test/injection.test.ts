import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createNativeStub, type MurmurNative } from '@murmur/shared'

import { categoryForBundleId } from '../src/main/dictation/app-category'
import { HotkeyBridge } from '../src/main/dictation/hotkey'
import { CLIPBOARD_RESTORE_MS, TextInjector } from '../src/main/dictation/injector'
import { createNullLogger } from '../src/main/logging'
import { resetClipboard, clipboard } from './helpers/electron'

/**
 * Text insertion (PLAN §3.2.5, §4) and the hotkey bridge (PLAN §2.1).
 *
 * The clipboard here is a real in-memory implementation, not a mock, so the
 * save → write → paste → restore sequence is asserted end to end. Restoring the
 * wrong thing — or not restoring at all — silently destroys whatever the user
 * had copied, which is the kind of bug people notice a week later and cannot
 * reproduce.
 */

const log = createNullLogger()

/** A native double with controllable outcomes. */
function fakeNative(overrides: Partial<MurmurNative> = {}): MurmurNative {
  const base = createNativeStub('test stub')
  return {
    ...base,
    available: true,
    isSecureInputActive: () => false,
    sendPasteShortcut: () => ({ ok: true }),
    insertTextViaAccessibility: () => ({ ok: true }),
    ...overrides,
  }
}

beforeEach(() => {
  resetClipboard()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('TextInjector.precheck', () => {
  it('refuses when the native module is unavailable (non-macOS)', () => {
    const injector = new TextInjector({ native: () => createNativeStub('linux'), log })
    expect(injector.precheck()).toMatchObject({ ok: false, reason: 'unsupported-platform' })
  })

  it('refuses when secure input is active', () => {
    const injector = new TextInjector({
      native: () => fakeNative({ isSecureInputActive: () => true }),
      log,
    })
    const result = injector.precheck()
    expect(result).toMatchObject({ ok: false, reason: 'secure-input' })
    // The message is what the Bar shows, so it must name the situation.
    expect(result.ok === false && result.message).toContain('Secure field')
  })

  it('refuses when the frontmost app is elevated (Windows UIPI / G9)', () => {
    const injector = new TextInjector({
      native: () =>
        fakeNative({
          isForegroundElevated: () => true,
        }),
      log,
    })
    const result = injector.precheck()
    expect(result).toMatchObject({ ok: false, reason: 'elevated-target' })
    expect(result.ok === false && result.message).toMatch(/administrator/i)
  })

  it('passes when everything is in order', () => {
    const injector = new TextInjector({ native: () => fakeNative(), log })
    expect(injector.precheck()).toEqual({ ok: true })
  })
})

describe('TextInjector.insert', () => {
  it('saves, writes, pastes, then restores the clipboard', () => {
    vi.useFakeTimers()
    clipboard.write({ text: 'something the user copied' })

    const paste = vi.fn(() => ({ ok: true }))
    const injector = new TextInjector({
      native: () => fakeNative({ sendPasteShortcut: paste }),
      log,
    })

    const result = injector.insert('We should ship it on Wednesday.')

    expect(result).toEqual({ ok: true, method: 'paste' })
    expect(paste).toHaveBeenCalledOnce()
    // The transcript is on the clipboard for the target app to read…
    expect(clipboard.readText()).toBe('We should ship it on Wednesday.')

    // …and put back after the delay.
    vi.advanceTimersByTime(CLIPBOARD_RESTORE_MS + 1)
    expect(clipboard.readText()).toBe('something the user copied')
  })

  it('restores HTML as well as plain text', () => {
    vi.useFakeTimers()
    clipboard.write({ text: 'plain', html: '<b>rich</b>' })

    const injector = new TextInjector({ native: () => fakeNative(), log })
    injector.insert('inserted text')
    vi.advanceTimersByTime(CLIPBOARD_RESTORE_MS + 1)

    expect(clipboard.readText()).toBe('plain')
    expect(clipboard.readHTML()).toBe('<b>rich</b>')
  })

  it('leaves the clipboard empty when it started empty, rather than parking the transcript', () => {
    vi.useFakeTimers()
    const injector = new TextInjector({ native: () => fakeNative(), log })

    injector.insert('a private transcript')
    vi.advanceTimersByTime(CLIPBOARD_RESTORE_MS + 1)

    expect(clipboard.readText()).toBe('')
  })

  it('falls back to accessibility insertion when the paste reports failure', () => {
    clipboard.write({ text: 'original' })
    const accessibility = vi.fn(() => ({ ok: true }))

    const injector = new TextInjector({
      native: () =>
        fakeNative({
          sendPasteShortcut: () => ({ ok: false, error: 'app ignored the keystroke' }),
          insertTextViaAccessibility: accessibility,
        }),
      log,
    })

    expect(injector.insert('hello')).toEqual({ ok: true, method: 'accessibility' })
    expect(accessibility).toHaveBeenCalledWith('hello')
    // The clipboard is restored immediately on the fallback path: the AX route
    // does not need it, and leaving a transcript there is a small leak.
    expect(clipboard.readText()).toBe('original')
  })

  it('reports failure when both paths fail, quoting the AX error', () => {
    const injector = new TextInjector({
      native: () =>
        fakeNative({
          sendPasteShortcut: () => ({ ok: false, error: 'paste blocked' }),
          insertTextViaAccessibility: () => ({ ok: false, error: 'no focused text field' }),
        }),
      log,
    })

    expect(injector.insert('hello')).toMatchObject({
      ok: false,
      method: 'none',
      reason: 'paste-failed',
      error: 'no focused text field',
    })
  })

  it('refuses to insert into a secure field', () => {
    const paste = vi.fn(() => ({ ok: true }))
    const injector = new TextInjector({
      native: () => fakeNative({ isSecureInputActive: () => true, sendPasteShortcut: paste }),
      log,
    })

    expect(injector.insert('password?')).toMatchObject({ ok: false, reason: 'secure-input' })
    expect(paste).not.toHaveBeenCalled()
    // Nothing must reach the clipboard either.
    expect(clipboard.readText()).toBe('')
  })

  it('refuses empty text without touching the clipboard', () => {
    clipboard.write({ text: 'untouched' })
    const injector = new TextInjector({ native: () => fakeNative(), log })

    expect(injector.insert('   ')).toMatchObject({ ok: false, reason: 'empty-text' })
    expect(clipboard.readText()).toBe('untouched')
  })

  it('returns unsupported-platform on a machine with no native module', () => {
    const injector = new TextInjector({ native: () => createNativeStub('linux'), log })
    expect(injector.insert('hello')).toMatchObject({
      ok: false,
      method: 'none',
      reason: 'unsupported-platform',
    })
  })

  it('dispose() cancels a pending restore', () => {
    vi.useFakeTimers()
    clipboard.write({ text: 'original' })
    const injector = new TextInjector({ native: () => fakeNative(), log })

    injector.insert('inserted')
    injector.dispose()
    vi.advanceTimersByTime(CLIPBOARD_RESTORE_MS * 5)

    // No restore ran, so the transcript is still there — which is why quitting
    // mid-insert is the only case where dispose() is the right call.
    expect(clipboard.readText()).toBe('inserted')
  })
})

describe('categoryForBundleId (PLAN §2.2.3)', () => {
  it('maps known apps to their tone category', () => {
    expect(categoryForBundleId('com.apple.mail')).toBe('email')
    expect(categoryForBundleId('com.microsoft.Outlook')).toBe('email')
    expect(categoryForBundleId('com.tinyspeck.slackmacgap')).toBe('work')
    expect(categoryForBundleId('com.apple.MobileSMS')).toBe('personal')
  })

  it('is case-insensitive and matches on substrings', () => {
    expect(categoryForBundleId('COM.TINYSPECK.SLACKMACGAP')).toBe('work')
  })

  it('falls back to other for anything unknown or absent', () => {
    expect(categoryForBundleId('com.unknown.app')).toBe('other')
    expect(categoryForBundleId(null)).toBe('other')
    expect(categoryForBundleId('')).toBe('other')
  })
})

describe('HotkeyBridge (PLAN §2.1, §4)', () => {
  interface Recorded {
    intents: string[]
    bridge: HotkeyBridge
    now: { current: number }
  }

  function setup(config: Parameters<HotkeyBridge['start']>[0]): Recorded {
    const intents: string[] = []
    const now = { current: 1_000 }
    const native = fakeNative({
      startHotkeyListener: () => undefined,
      stopHotkeyListener: () => undefined,
    })

    const bridge = new HotkeyBridge({
      native: () => native,
      intents: {
        begin: () => intents.push('begin'),
        end: () => intents.push('end'),
        toggleHandsFree: () => intents.push('handsFree'),
      },
      log,
      now: () => now.current,
    })
    bridge.start(config)
    return { intents, bridge, now }
  }

  const holdConfig = {
    key: 'fn' as const,
    customKeyCode: null,
    activation: 'hold' as const,
    doubleTapHandsFree: true,
  }

  it('maps hold down/up to begin/end', () => {
    const { intents, bridge, now } = setup(holdConfig)

    bridge.handle({ type: 'down', timestamp: now.current })
    now.current += 800
    bridge.handle({ type: 'up', timestamp: now.current })

    expect(intents).toEqual(['begin', 'end'])
  })

  it('latches hands-free on a native double-tap and ignores the trailing up', () => {
    const { intents, bridge, now } = setup(holdConfig)

    bridge.handle({ type: 'doubleTap', timestamp: now.current })
    now.current += 50
    bridge.handle({ type: 'up', timestamp: now.current })

    expect(intents).toEqual(['handsFree'])
  })

  it('detects a double-tap itself when the tap only reports down/up', () => {
    const { intents, bridge, now } = setup(holdConfig)

    bridge.handle({ type: 'down', timestamp: now.current })
    now.current += 60
    bridge.handle({ type: 'up', timestamp: now.current })
    now.current += 100 // well inside the 350 ms window
    bridge.handle({ type: 'down', timestamp: now.current })

    expect(intents).toEqual(['begin', 'end', 'handsFree'])
  })

  it('does not treat two slow presses as a double-tap', () => {
    const { intents, bridge, now } = setup(holdConfig)

    bridge.handle({ type: 'down', timestamp: now.current })
    now.current += 500
    bridge.handle({ type: 'up', timestamp: now.current })
    now.current += 2_000
    bridge.handle({ type: 'down', timestamp: now.current })

    expect(intents).toEqual(['begin', 'end', 'begin'])
  })

  it('respects doubleTapHandsFree: false', () => {
    const { intents, bridge, now } = setup({ ...holdConfig, doubleTapHandsFree: false })

    bridge.handle({ type: 'doubleTap', timestamp: now.current })
    // A real tap-then-tap sequence — the gesture that would latch when the
    // setting is on — must read as two ordinary presses when it is off.
    bridge.handle({ type: 'down', timestamp: now.current })
    now.current += 50
    bridge.handle({ type: 'up', timestamp: now.current })
    now.current += 50
    bridge.handle({ type: 'down', timestamp: now.current })

    expect(intents).toEqual(['begin', 'end', 'begin'])
    expect(intents).not.toContain('handsFree')
  })

  it('toggles on alternate downs in toggle mode, ignoring ups', () => {
    const { intents, bridge, now } = setup({
      ...holdConfig,
      activation: 'toggle',
      doubleTapHandsFree: false,
    })

    bridge.handle({ type: 'down', timestamp: now.current })
    bridge.handle({ type: 'up', timestamp: now.current })
    now.current += 3_000
    bridge.handle({ type: 'down', timestamp: now.current })
    bridge.handle({ type: 'up', timestamp: now.current })

    expect(intents).toEqual(['begin', 'end'])
  })

  it('still ends the utterance after a very short tap', () => {
    // The orchestrator's min-duration guard turns it into "no speech", which is
    // clearer than swallowing the key and leaving the Bar open.
    const { intents, bridge, now } = setup(holdConfig)

    bridge.handle({ type: 'down', timestamp: now.current })
    now.current += 10
    bridge.handle({ type: 'up', timestamp: now.current })

    expect(intents).toEqual(['begin', 'end'])
  })

  it('does not start when the native module is unavailable', () => {
    const bridge = new HotkeyBridge({
      native: () => createNativeStub('linux'),
      intents: { begin: () => undefined, end: () => undefined, toggleHandsFree: () => undefined },
      log,
    })
    bridge.start(holdConfig)
    expect(bridge.running).toBe(false)
  })

  it('rebinds only when the config actually changed', () => {
    const starts: number[] = []
    const native = fakeNative({ startHotkeyListener: () => starts.push(1) })
    const bridge = new HotkeyBridge({
      native: () => native,
      intents: { begin: () => undefined, end: () => undefined, toggleHandsFree: () => undefined },
      log,
    })

    bridge.start(holdConfig)
    expect(starts).toHaveLength(1)

    bridge.rebind({ ...holdConfig })
    expect(starts).toHaveLength(1) // identical config: no restart

    bridge.rebind({ ...holdConfig, key: 'rightCmd' })
    expect(starts).toHaveLength(2)
  })

  it('stop() clears the running flag and is safe to repeat', () => {
    const { bridge } = setup(holdConfig)
    expect(bridge.running).toBe(true)
    bridge.stop()
    bridge.stop()
    expect(bridge.running).toBe(false)
  })
})
