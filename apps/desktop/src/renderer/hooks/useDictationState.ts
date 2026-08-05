import { useEffect, useState } from 'react'

import type { DictationEvent } from '@murmur/shared'

/**
 * The live dictation state, for the windows that are not the Bar.
 *
 * The Hub uses it for the "try it" hint in Settings and for the onboarding
 * tutorial, where the whole point is that the user sees the app react to their
 * key in real time rather than being told it works.
 */
export function useDictationState(): DictationEvent {
  const [event, setEvent] = useState<DictationEvent>({ state: 'idle' })

  useEffect(() => {
    let active = true
    void window.murmur.dictation
      .getState()
      .then((value) => {
        if (active) setEvent(value)
      })
      .catch(() => undefined)

    const unsubscribe = window.murmur.dictation.subscribe((value) => {
      if (active) setEvent(value)
    })

    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  return event
}
