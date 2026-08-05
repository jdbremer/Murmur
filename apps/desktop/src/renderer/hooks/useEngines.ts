import { useEffect, useState } from 'react'

import type { EnginesStatus } from '@murmur/shared'

/**
 * Both engine slots, kept live (PLAN §6.1, §7.1).
 *
 * `engines.status` is the initial read and `engines.changed` the stream; a
 * sidecar dying, a model finishing its download, or the user switching models
 * all arrive the same way. `warnings` on either slot is where the
 * "that endpoint is not loopback" advisory shows up — a badge, never an error.
 */
export function useEngines(): EnginesStatus | null {
  const [status, setStatus] = useState<EnginesStatus | null>(null)

  useEffect(() => {
    let active = true
    void window.murmur.engines
      .status()
      .then((value) => {
        if (active) setStatus(value)
      })
      .catch(() => undefined)

    const unsubscribe = window.murmur.engines.subscribe((value) => {
      if (active) setStatus(value)
    })

    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  return status
}
