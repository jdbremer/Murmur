import { useEffect, useState } from 'react'

/**
 * `prefers-reduced-motion`, live (PLAN §15.5).
 *
 * macOS's "Reduce motion" is a real accessibility need, not a preference to
 * approximate: the Bar answers it by crossfading instead of morphing and by
 * showing a static level readout instead of dancing bars, and the Hub drops its
 * transitions. Read through a hook so a mid-session change to the setting takes
 * effect without a relaunch.
 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(matches)

  useEffect(() => {
    const query = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    if (!query) return
    const onChange = (): void => setReduced(query.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])

  return reduced
}

function matches(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}
