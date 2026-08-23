import { useCallback, useEffect, useState } from 'react'

import type { Insights } from '@murmur/shared'
import { errorMessage } from '../lib/errors'

/**
 * The Insights payload, refreshed whenever a dictation lands.
 *
 * Subscribed to `history.changed` rather than to a channel of its own: that
 * event already fires after every dictation and is the only thing that can move
 * these numbers. Its payload is ignored — one round trip for the whole section
 * keeps the figures agreeing with each other, which several partial updates
 * would not.
 */
export function useInsights(): {
  insights: Insights | null
  error: string | null
  reset: () => Promise<void>
  reload: () => Promise<void>
} {
  const [insights, setInsights] = useState<Insights | null>(null)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    try {
      setInsights(await window.murmur.insights.get())
      setError(null)
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }, [])

  useEffect(() => {
    let active = true

    const load = (): void => {
      window.murmur.insights
        .get()
        .then((value) => {
          if (active) setInsights(value)
        })
        .catch((cause: unknown) => {
          if (active) setError(errorMessage(cause))
        })
    }

    load()
    const unsubscribe = window.murmur.history.subscribe(load)

    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  const reset = useCallback(async () => {
    try {
      setInsights(await window.murmur.insights.reset())
      setError(null)
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }, [])

  return { insights, error, reset, reload }
}
