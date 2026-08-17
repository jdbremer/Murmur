import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createDefaultSettings } from '@murmur/shared'

import { SettingsStore } from '../src/main/store/settings-store'

let directory: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'murmur-settings-'))
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

const file = (): string => join(directory, 'settings.json')

describe('SettingsStore', () => {
  it('starts from the shipped defaults when there is no file', () => {
    expect(new SettingsStore(file()).get()).toEqual(createDefaultSettings())
  })

  it('persists a patch and reloads it', () => {
    const store = new SettingsStore(file())
    store.set({ polishingLevel: 'off', language: 'de' })

    const reloaded = new SettingsStore(file())
    expect(reloaded.get().polishingLevel).toBe('off')
    expect(reloaded.get().language).toBe('de')
    // Untouched keys keep their defaults.
    expect(reloaded.get().barVisibility).toBe('always')
  })

  it('writes readable JSON', () => {
    new SettingsStore(file()).set({ launchAtLogin: true })
    const raw = readFileSync(file(), 'utf8')
    expect(raw.endsWith('\n')).toBe(true)
    expect(JSON.parse(raw)).toMatchObject({ launchAtLogin: true })
  })

  it('notifies subscribers with the new state', () => {
    const store = new SettingsStore(file())
    const listener = vi.fn()
    store.on('changed', listener)

    store.set({ appearance: 'dark' })

    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener.mock.calls[0]?.[0]).toMatchObject({ appearance: 'dark' })
  })

  it('heals a settings file written by an older version', () => {
    writeFileSync(file(), JSON.stringify({ language: 'fr' }), 'utf8')
    const store = new SettingsStore(file())
    expect(store.get().language).toBe('fr')
    expect(store.get().hotkey.key).toBe('fn')
  })

  it('falls back to defaults on a corrupt file rather than crashing at boot', () => {
    writeFileSync(file(), '{ this is not json', 'utf8')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    expect(new SettingsStore(file()).get()).toEqual(createDefaultSettings())
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('rejects a patch that would produce invalid settings', () => {
    const store = new SettingsStore(file())
    expect(() => store.set({ appearance: 'neon' } as never)).toThrowError()
    // The in-memory state must survive the rejected write.
    expect(store.get().appearance).toBe('system')
  })

  it('does not hand out its internal object', () => {
    const store = new SettingsStore(file())
    const settings = store.get()
    settings.language = 'mutated'
    expect(store.get().language).toBe('en')
  })

  it('reset() goes back to defaults and persists that', () => {
    const store = new SettingsStore(file())
    store.set({ language: 'ja', launchAtLogin: true })
    store.reset()
    expect(store.get()).toEqual(createDefaultSettings())
    expect(new SettingsStore(file()).get()).toEqual(createDefaultSettings())
  })
})
