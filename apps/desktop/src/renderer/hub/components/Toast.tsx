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
      className="hub-toast pointer-events-auto fixed bottom-6 left-1/2 z-50 w-[min(420px,calc(100%-2rem))] -translate-x-1/2 rounded-xl border border-danger/30 bg-surface px-4 py-3 shadow-lg"
    >
      <div className="flex items-start gap-3">
        <svg
          viewBox="0 0 24 24"
          aria-hidden="true"
          className="mt-0.5 size-[15px] shrink-0 text-danger"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7.5v5.5M12 16.5h.01" />
        </svg>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium text-ink">{toast.message}</p>
          {toast.code === 'stt-failed' ? (
            <p className="mt-1 text-[12px] leading-relaxed text-ink-muted">
              Open <span className="font-medium text-ink">Models</span> to download and select a
              speech-to-text model.
            </p>
          ) : null}
        </div>
        <button
          type="button"
          className="grid size-6 shrink-0 place-items-center rounded-md text-ink-faint transition-colors hover:bg-canvas hover:text-ink"
          onClick={() => setToast(null)}
          aria-label="Dismiss"
        >
          <svg
            viewBox="0 0 24 24"
            aria-hidden="true"
            className="size-[12px]"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
          >
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>
    </div>
  )
}
