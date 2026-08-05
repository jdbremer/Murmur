import { EventEmitter } from 'node:events'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import {
  applySettingsPatch,
  createDefaultSettings,
  SettingsSchema,
  type Settings,
  type SettingsPatch,
} from '@murmur/shared'

/**
 * Settings persistence.
 *
 * Stage 1 keeps this in a single JSON file under `userData`, which is enough to
 * prove the get/set/subscribe IPC flow end to end. PLAN §9 moves settings into
 * SQLite alongside history and the dictionary in Stage 2 — when that happens,
 * only this class needs replacing: everything upstream talks to the
 * `SettingsStore` interface, not to the file.
 *
 * The class takes an explicit path rather than calling `app.getPath()` itself so
 * it can be unit-tested without Electron.
 */

export const SETTINGS_FILE_NAME = 'settings.json'

export interface SettingsStoreEvents {
  changed: [Settings]
}

export class SettingsStore extends EventEmitter<SettingsStoreEvents> {
  readonly filePath: string
  #settings: Settings

  constructor(filePath: string) {
    super()
    this.filePath = filePath
    this.#settings = this.#read()
  }

  /** Convenience constructor for the app: `<userData>/settings.json`. */
  static inUserData(userDataPath: string): SettingsStore {
    return new SettingsStore(join(userDataPath, SETTINGS_FILE_NAME))
  }

  get(): Settings {
    return structuredClone(this.#settings)
  }

  /** Merge a sparse patch, persist, and notify subscribers. */
  set(patch: SettingsPatch): Settings {
    const next = applySettingsPatch(this.#settings, patch)
    this.#settings = next
    this.#write(next)
    this.emit('changed', structuredClone(next))
    return structuredClone(next)
  }

  /** Discard everything and go back to the shipped defaults. */
  reset(): Settings {
    this.#settings = createDefaultSettings()
    this.#write(this.#settings)
    this.emit('changed', structuredClone(this.#settings))
    return this.get()
  }

  #read(): Settings {
    let raw: string
    try {
      raw = readFileSync(this.filePath, 'utf8')
    } catch {
      // No file yet — first run.
      return createDefaultSettings()
    }

    try {
      // `parse` fills in any key this version added since the file was written.
      return SettingsSchema.parse(JSON.parse(raw))
    } catch (error) {
      console.warn(
        `[settings] ${this.filePath} is unreadable, falling back to defaults:`,
        error instanceof Error ? error.message : error,
      )
      return createDefaultSettings()
    }
  }

  #write(settings: Settings): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
      // Write-then-rename so a crash mid-write cannot truncate the real file.
      const temporary = `${this.filePath}.tmp`
      writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
      renameSync(temporary, this.filePath)
    } catch (error) {
      console.error(
        `[settings] failed to persist ${this.filePath}:`,
        error instanceof Error ? error.message : error,
      )
    }
  }
}
