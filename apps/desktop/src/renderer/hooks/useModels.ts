import { useCallback, useEffect, useRef, useState } from 'react'

import type { ModelDownloadProgress, ModelsList } from '@murmur/shared'

/**
 * The Models section's data: the catalog, what is on disk, and what is in
 * flight (PLAN §8).
 *
 * Downloads are tracked by *model* id rather than download id, because that is
 * what the UI renders — one card, one progress bar. The download id is kept
 * alongside so Cancel has something to send.
 */
export interface ActiveDownload extends ModelDownloadProgress {
  /** True once main reports the final state, so the row can stop pretending. */
  finished: boolean
}

export interface UseModels {
  models: ModelsList | null
  downloads: Record<string, ActiveDownload>
  error: string | null
  refresh: () => void
  start: (modelId: string) => void
  cancel: (modelId: string) => void
}

export function useModels(): UseModels {
  const [models, setModels] = useState<ModelsList | null>(null)
  const [downloads, setDownloads] = useState<Record<string, ActiveDownload>>({})
  const [error, setError] = useState<string | null>(null)
  const alive = useRef(true)

  const refresh = useCallback(() => {
    void window.murmur.models
      .list()
      .then((value) => {
        if (!alive.current) return
        setModels(value)
        setError(null)
      })
      .catch((cause: unknown) => {
        if (alive.current) setError(messageOf(cause))
      })
  }, [])

  useEffect(() => {
    alive.current = true
    refresh()

    const unsubscribe = window.murmur.models.onDownloadProgress((progress) => {
      const finished =
        progress.status === 'complete' ||
        progress.status === 'cancelled' ||
        progress.status === 'error'

      setDownloads((current) => ({ ...current, [progress.modelId]: { ...progress, finished } }))

      if (progress.status === 'complete' || progress.status === 'cancelled') {
        // The card's state comes from what is on disk, so re-read it.
        refresh()
      }
      if (progress.status === 'error' && progress.message) setError(progress.message)
    })

    return () => {
      alive.current = false
      unsubscribe()
    }
  }, [refresh])

  const start = useCallback((modelId: string) => {
    setError(null)
    void window.murmur.models
      .downloadStart({ modelId })
      .then(({ downloadId }) => {
        setDownloads((current) => ({
          ...current,
          [modelId]: {
            downloadId,
            modelId,
            receivedBytes: 0,
            totalBytes: 0,
            status: 'queued',
            message: null,
            finished: false,
          },
        }))
      })
      .catch((cause: unknown) => setError(messageOf(cause)))
  }, [])

  const cancel = useCallback(
    (modelId: string) => {
      const active = downloads[modelId]
      if (!active) return
      void window.murmur.models
        .downloadCancel({ downloadId: active.downloadId })
        .catch((cause: unknown) => setError(messageOf(cause)))
    },
    [downloads],
  )

  return { models, downloads, error, refresh, start, cancel }
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
