import { useCallback, useEffect, useRef, useState } from 'react'

import type { Note } from '@murmur/shared'

/**
 * The note list, kept in step across windows.
 *
 * The Scratchpad and the Hub's Notes section can both be open over the same
 * rows, so both subscribe to `notes.changed` — two views of one document that
 * silently disagree is the failure mode this exists to prevent.
 *
 * `null` while the first load is in flight, so callers can tell "loading" from
 * "you have no notes", which look identical and mean opposite things.
 */
export function useNotes(search: string): {
  notes: Note[] | null
  total: number
  error: string | null
  refresh: () => Promise<void>
} {
  const [notes, setNotes] = useState<Note[] | null>(null)
  const [total, setTotal] = useState(0)
  const [error, setError] = useState<string | null>(null)

  const active = useRef(true)
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
    }
  }, [])

  // Read through a ref so the subscription below is established once, rather
  // than being torn down and rebuilt on every keystroke in the search box.
  const latestSearch = useRef(search)
  useEffect(() => {
    latestSearch.current = search
  }, [search])

  const load = useCallback(async () => {
    try {
      const page = await window.murmur.notes.list({ search: latestSearch.current, limit: 200 })
      if (!active.current) return
      setNotes(page.notes)
      setTotal(page.total)
      setError(null)
    } catch (cause) {
      if (!active.current) return
      setError(cause instanceof Error ? cause.message : String(cause))
      setNotes([])
    }
  }, [])

  // Debounced while searching, immediate otherwise — the same shape the history
  // feed uses, and for the same reason: one FTS query per keystroke is waste.
  useEffect(() => {
    const timer = setTimeout(() => void load(), search ? 180 : 0)
    return () => clearTimeout(timer)
  }, [search, load])

  useEffect(() => window.murmur.notes.subscribe(() => void load()), [load])

  return { notes, total, error, refresh: load }
}
