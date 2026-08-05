import { useEffect, useState } from 'react'

import type { DictationEvent } from '@murmur/shared'

/**
 * Lightweight Hub toast for dictation failures (no model, secure field, etc.).
 * Subscribes to the same `dictation.state` stream as the Bar.
 */
export function DictationToast(): React.JSX.Element | null {
  const [toast, setToast] = useState<{ message: string; code: string } | null>(null)

  useEffect(() => {
    const unsub = window.murmur.dictation.subscribe((event: DictationEvent) => {
      if (event.state === 'error') {
        setToast({ message: event.message, code: event.code })
      }
    })
    return unsub
  }, [])

  useEffect(() => {
    if (!toast) return
    const id = window.setTimeout(() => setToast(null), 5000)
    return () => window.clearTimeout(id)
  }, [toast])

  if (!toast) return null

  return (
    <div
      role="status"
      className="pointer-events-auto fixed bottom-6 left-1/2 z-50 w-[min(420px,calc(100%-2rem))] -translate-x-1/2 rounded-xl border border-warning/40 bg-surface px-4 py-3 shadow-lg"
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium text-warning">{toast.message}</p>
          {toast.code === 'stt-failed' ? (
            <p className="mt-1 text-[12px] text-ink-muted">
              Open <span className="font-medium text-ink">Models</span> to download and select a
              speech-to-text model.
            </p>
          ) : null}
        </div>
        <button
          type="button"
          className="shrink-0 rounded-md px-2 py-1 text-[12px] text-ink-muted hover:bg-canvas hover:text-ink"
          onClick={() => setToast(null)}
          aria-label="Dismiss"
        >
          ✕
        </button>
      </div>
    </div>
  )
}
