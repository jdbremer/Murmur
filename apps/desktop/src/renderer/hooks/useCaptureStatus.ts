import { useEffect, useState } from 'react'

import type { AudioCaptureStatus } from '@murmur/shared'

/**
 * The capture renderer's lifecycle, kept live (HANDOFF item #4).
 *
 * This is the only place a mic failure that happened while nothing was
 * listening is visible: the orchestrator ignores errors while idle — there is
 * no dictation to fail — but a user whose permission was denied at the startup
 * warm, or whose device is held by another app, needs to see that *before*
 * they hold the key and get silence.
 */
export function useCaptureStatus(): AudioCaptureStatus | null {
  const [status, setStatus] = useState<AudioCaptureStatus | null>(null)

  useEffect(() => {
    let active = true
    void window.murmur.audio
      .captureStatus()
      .then((value) => {
        if (active) setStatus(value)
      })
      .catch(() => undefined)

    const unsubscribe = window.murmur.audio.onCaptureChanged((value) => {
      if (active) setStatus(value)
    })

    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  return status
}
