import { describe, expect, it } from 'vitest'

import {
  applySettingsPatch,
  createDefaultSettings,
  sanitizeHotkeyForPlatform,
  SettingsPatchSchema,
  SettingsSchema,
  WINDOWS_DEFAULT_HOTKEY_KEY,
  type Settings,
} from '../src/domain/settings'
import { createDefaultStyleProfiles, StyleProfileSchema } from '../src/domain/style'

describe('SettingsSchema', () => {
  it('fills every field from an empty object', () => {
    const settings = SettingsSchema.parse({})

    expect(settings).toEqual({
      hotkey: { key: 'fn', customKeyCode: null, activation: 'hold', doubleTapHandsFree: true },
      micDeviceId: null,
      language: 'en',
      polishingLevel: 'clean',
      audioRetention: { mode: 'off' },
      historyRetention: { mode: 'days', days: 90 },
      launchAtLogin: false,
      barVisibility: 'showWhileDictating',
      sttModelId: null,
      polishModelId: null,
      externalEndpoint: null,
      appearance: 'system',
      onboardingCompleted: false,
      commandModeEnabled: true,
    } satisfies Settings)
  })

  it('audio retention defaults to off — audio is never written to disk unasked', () => {
    expect(createDefaultSettings().audioRetention).toEqual({ mode: 'off' })
  })

  it('round-trips: parse(defaults) is a fixed point', () => {
    const once = createDefaultSettings()
    const twice = SettingsSchema.parse(structuredClone(once))
    expect(twice).toEqual(once)
    expect(JSON.parse(JSON.stringify(once))).toEqual(once)
  })

  it('hands back a fresh object each time (defaults are not shared by reference)', () => {
    const a = createDefaultSettings()
    const b = createDefaultSettings()
    expect(a).not.toBe(b)
    expect(a.hotkey).not.toBe(b.hotkey)

    a.hotkey.key = 'rightCmd'
    expect(createDefaultSettings().hotkey.key).toBe('fn')
  })

  it('heals a partial settings.json by filling the missing keys', () => {
    const fromDisk = { language: 'de', polishingLevel: 'rewrite' }
    const settings = SettingsSchema.parse(fromDisk)
    expect(settings.language).toBe('de')
    expect(settings.polishingLevel).toBe('rewrite')
    expect(settings.barVisibility).toBe('showWhileDictating')
  })

  it('accepts Windows hotkey presets alongside macOS ones', () => {
    for (const key of ['rightCtrl', 'ctrlSpace', 'altSpace', 'capsLock'] as const) {
      const parsed = SettingsSchema.parse({ hotkey: { key } })
      expect(parsed.hotkey.key).toBe(key)
    }
  })

  it('sanitizes incomplete custom hotkeys and Mac-only keys on Windows', () => {
    const broken = SettingsSchema.parse({ hotkey: { key: 'custom', customKeyCode: null } }).hotkey
    expect(sanitizeHotkeyForPlatform(broken, 'win32').key).toBe(WINDOWS_DEFAULT_HOTKEY_KEY)
    expect(sanitizeHotkeyForPlatform(broken, 'darwin').key).toBe('fn')

    const macOnly = SettingsSchema.parse({ hotkey: { key: 'fn' } }).hotkey
    expect(sanitizeHotkeyForPlatform(macOnly, 'win32').key).toBe(WINDOWS_DEFAULT_HOTKEY_KEY)
    expect(sanitizeHotkeyForPlatform(macOnly, 'darwin').key).toBe('fn')

    const chord = SettingsSchema.parse({ hotkey: { key: 'ctrlSpace' } }).hotkey
    expect(sanitizeHotkeyForPlatform(chord, 'win32').key).toBe(WINDOWS_DEFAULT_HOTKEY_KEY)
  })

  it('rejects out-of-domain values', () => {
    expect(SettingsSchema.safeParse({ polishingLevel: 'sparkle' }).success).toBe(false)
    expect(SettingsSchema.safeParse({ hotkey: { key: 'leftPinky' } }).success).toBe(false)
    expect(SettingsSchema.safeParse({ historyRetention: { mode: 'days', days: 0 } }).success).toBe(
      false,
    )
    expect(SettingsSchema.safeParse({ externalEndpoint: { model: 'x' } }).success).toBe(false)
    expect(
      SettingsSchema.safeParse({ externalEndpoint: { baseUrl: 'not a url', model: 'x' } }).success,
    ).toBe(false)
  })

  it('accepts a valid external endpoint and defaults its apiKey to null', () => {
    const settings = SettingsSchema.parse({
      externalEndpoint: { baseUrl: 'http://127.0.0.1:1234/v1', model: 'gemma-3-4b-it' },
    })
    expect(settings.externalEndpoint).toEqual({
      baseUrl: 'http://127.0.0.1:1234/v1',
      apiKey: null,
      model: 'gemma-3-4b-it',
    })
  })
})

describe('SettingsPatchSchema', () => {
  it('leaves omitted keys omitted — a patch must never resurrect defaults', () => {
    // Regression guard: zod's `.partial()` does *not* strip `.default()`s, so
    // the patch schema is built from a defaults-free shape. If that ever
    // regresses, an empty patch would silently reset every setting.
    expect(SettingsPatchSchema.parse({})).toEqual({})
    expect(Object.keys(SettingsPatchSchema.parse({ launchAtLogin: true }))).toEqual([
      'launchAtLogin',
    ])
  })

  it('still validates the fields it is given', () => {
    expect(SettingsPatchSchema.safeParse({ appearance: 'neon' }).success).toBe(false)
    expect(SettingsPatchSchema.safeParse({ appearance: 'dark' }).success).toBe(true)
  })
})

describe('applySettingsPatch', () => {
  it('changes only the patched keys', () => {
    const before = createDefaultSettings()
    const after = applySettingsPatch(before, { polishingLevel: 'off', launchAtLogin: true })

    expect(after.polishingLevel).toBe('off')
    expect(after.launchAtLogin).toBe(true)
    expect(after.language).toBe(before.language)
    expect(after.hotkey).toEqual(before.hotkey)
    expect(before.polishingLevel).toBe('clean') // input untouched
  })

  it('replaces nested objects wholesale', () => {
    const after = applySettingsPatch(createDefaultSettings(), {
      hotkey: {
        key: 'rightOpt',
        customKeyCode: null,
        activation: 'toggle',
        doubleTapHandsFree: false,
      },
    })
    expect(after.hotkey).toEqual({
      key: 'rightOpt',
      customKeyCode: null,
      activation: 'toggle',
      doubleTapHandsFree: false,
    })
  })

  it('re-validates the merged result', () => {
    expect(() =>
      applySettingsPatch(createDefaultSettings(), { language: 'x' } as never),
    ).toThrowError()
  })
})

describe('style profiles', () => {
  it('ships one complete profile per app category', () => {
    const profiles = createDefaultStyleProfiles()
    expect(profiles.map((p) => p.category)).toEqual(['personal', 'work', 'email', 'other'])
    for (const profile of profiles) {
      expect(StyleProfileSchema.safeParse(profile).success).toBe(true)
      expect(profile.customInstructions).toBe('')
    }
  })
})
