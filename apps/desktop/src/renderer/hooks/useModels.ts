import { useCallback, useEffect, useRef, useState } from 'react'

import type { EnginesStatus, ModelDownloadProgress, ModelsList } from '@murmur/shared'

/**
 * Everything the Models section reads and writes (PLAN §8).
 *
 * Downloads are keyed by **model id** rather than by download id, because that
 * is what the UI renders one row per. The `downloadId` still rides along in the
 * value — cancelling needs it, and the manager deliberately hands out an opaque
 * id so that cancelling a download cannot hit a *different* download of the same
 * model started a moment later.
 *
 * Terminal progress states are kept rather than cleared, so a failed checksum
 * stays on screen with its message instead of the row silently reverting to
 * "Download" as though nothing had happened.
 */

export interface UseModels {
  models: ModelsList | null
  engines: EnginesStatus | null
  downloads: Record<string, ModelDownloadProgress>
  error: string | null
  busyModelId: string | null
  refresh: () => Promise<void>
  download: (modelId: string) => Promise<void>
  cancel: (modelId: string) => Promise<void>
  select: (kind: 'stt' | 'polish', modelId: string | null) => Promise<void>
  remove: (modelId: string) => Promise<void>
  importFile: (request: {
    kind: 'stt' | 'polish'
    engine: 'whisper-cpp' | 'onnx-runtime' | 'llama-cpp'
    displayName: string
    path: string
  }) => Promise<void>
}

export function useModels(): UseModels {
  const [models, setModels] = useState<ModelsList | null>(null)
  const [engines, setEngines] = useState<EnginesStatus | null>(null)
  const [downloads, setDownloads] = useState<Record<string, ModelDownloadProgress>>({})
  const [error, setError] = useState<string | null>(null)
  const [busyModelId, setBusyModelId] = useState<string | null>(null)

  const active = useRef(true)

  const refresh = useCallback(async () => {
    try {
      const [nextModels, nextEngines] = await Promise.all([
        window.murmur.models.list(),
        window.murmur.engines.status(),
      ])
      if (!active.current) return
      setModels(nextModels)
      setEngines(nextEngines)
      setError(null)
    } catch (cause) {
      if (active.current) setError(messageOf(cause))
    }
  }, [])

  useEffect(() => {
    active.current = true

    // The initial read goes straight to IPC rather than through `refresh`:
    // starting an effect by synchronously calling something that sets state is
    // what `react-hooks/set-state-in-effect` exists to catch, and resolving the
    // promise first is both the lint-clean and the honest shape.
    void Promise.all([window.murmur.models.list(), window.murmur.engines.status()])
      .then(([nextModels, nextEngines]) => {
        if (!active.current) return
        setModels(nextModels)
        setEngines(nextEngines)
        setError(null)
      })
      .catch((cause: unknown) => {
        if (active.current) setError(messageOf(cause))
      })

    const unsubscribeProgress = window.murmur.models.onDownloadProgress((progress) => {
      if (!active.current) return
      setDownloads((current) => ({ ...current, [progress.modelId]: progress }))
      // A finished download changes what is on disk and therefore what every
      // engine can load, so the whole view is re-read rather than patched.
      if (progress.status === 'complete') void refresh()
    })

    const unsubscribeEngines = window.murmur.engines.subscribe((next) => {
      if (active.current) setEngines(next)
    })

    return () => {
      active.current = false
      unsubscribeProgress()
      unsubscribeEngines()
    }
  }, [refresh])

  /** Run a mutation with the row marked busy, then re-read. */
  const mutate = useCallback(
    async (modelId: string, action: () => Promise<unknown>) => {
      setBusyModelId(modelId)
      try {
        await action()
        setError(null)
        await refresh()
      } catch (cause) {
        if (active.current) setError(messageOf(cause))
      } finally {
        if (active.current) setBusyModelId(null)
      }
    },
    [refresh],
  )

  const download = useCallback(async (modelId: string) => {
    // Clear any previous failure for this row so a retry does not render the
    // old error next to a fresh progress bar.
    setDownloads((current) => {
      const { [modelId]: _removed, ...rest } = current
      return rest
    })
    try {
      await window.murmur.models.downloadStart({ modelId })
      setError(null)
    } catch (cause) {
      setError(messageOf(cause))
    }
  }, [])

  const cancel = useCallback(
    async (modelId: string) => {
      const progress = downloads[modelId]
      if (!progress) return
      try {
        await window.murmur.models.downloadCancel({ downloadId: progress.downloadId })
      } catch (cause) {
        setError(messageOf(cause))
      }
    },
    [downloads],
  )

  const select = useCallback(
    async (kind: 'stt' | 'polish', modelId: string | null) => {
      await mutate(modelId ?? `${kind}:none`, () => window.murmur.models.select({ kind, modelId }))
    },
    [mutate],
  )

  const remove = useCallback(
    async (modelId: string) => {
      await mutate(modelId, () => window.murmur.models.remove({ modelId }))
      setDownloads((current) => {
        const { [modelId]: _removed, ...rest } = current
        return rest
      })
    },
    [mutate],
  )

  const importFile = useCallback<UseModels['importFile']>(
    async (request) => {
      await mutate(request.path, () =>
        window.murmur.models.import({
          kind: request.kind,
          engine: request.engine,
          displayName: request.displayName,
          source: { type: 'file', path: request.path },
        }),
      )
    },
    [mutate],
  )

  return {
    models,
    engines,
    downloads,
    error,
    busyModelId,
    refresh,
    download,
    cancel,
    select,
    remove,
    importFile,
  }
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
