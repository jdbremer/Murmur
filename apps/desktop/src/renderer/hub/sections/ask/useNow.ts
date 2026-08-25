import { useEffect, useState } from 'react'

/**
 * A clock that is safe to read during render.
 *
 * `Date.now()` called inline in a component is impure: two renders of the same
 * props produce different output, which under concurrent rendering means a
 * timestamp can change without anything having happened. Reading it from state
 * makes the render a pure function of that state.
 *
 * The slow tick is the other half. Every reader here formats to day
 * granularity — "today", "yesterday", "3 days ago" — so a fast interval would
 * re-render the pane for nothing. Five minutes is enough that a Hub left open
 * across midnight stops calling yesterday "today", and rare enough to cost
 * nothing.
 */
export function useNow(intervalMs = 300_000): number {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])

  return now
}
