import { useCallback, useEffect, useState } from 'react'

import type { Settings, SettingsPatch } from '@murmur/shared'
import { errorMessage } from '../lib/errors'

/**
 * Settings, read from the main-process store and kept in sync.
 *
 * Main is the single writer (PLAN §11 "one writer, many readers"): this hook
 * never mutates local state directly, it sends a patch and waits for the store
 * to hand back the authoritative result — which also arrives on every other
 * window via the `settings.changed` broadcast.
 */
export function useSettings(): {
  settings: Settings | null
  update: (patch: SettingsPatch) => Promise<void>
  error: string | null
} {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true

    window.murmur.settings
      .get()
      .then((value) => {
        if (active) setSettings(value)
      })
      .catch((cause: unknown) => {
        if (active) setError(errorMessage(cause))
      })

    const unsubscribe = window.murmur.settings.subscribe((value) => {
      if (active) setSettings(value)
    })

    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  const update = useCallback(async (patch: SettingsPatch) => {
    try {
      setSettings(await window.murmur.settings.set(patch))
      setError(null)
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }, [])

  return { settings, update, error }
}
