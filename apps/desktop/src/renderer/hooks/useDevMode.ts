import { useEffect, useState } from 'react'

/**
 * Whether this is an unpackaged build.
 *
 * The three Simulate widgets front `debug.*` channels that are registered in
 * dev builds only — rendering their buttons in a packaged app would ship
 * controls that silently do nothing. Defaults to false so the packaged UI is
 * right even before the invoke resolves.
 */
export function useDevMode(): boolean {
  const [dev, setDev] = useState(false)

  useEffect(() => {
    let active = true
    void window.murmur.app
      .devMode()
      .then((value) => {
        if (active) setDev(value)
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [])

  return dev
}
