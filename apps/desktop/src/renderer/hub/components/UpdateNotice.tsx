import { useEffect, useState } from 'react'

import type { UpdateState } from '@murmur/shared'

/**
 * "A new version is ready" — top-right of the Hub (PLAN §10.2).
 *
 * The visible half of automatic updates. Everything else about the flow
 * already existed; what was missing was any way to find out without opening
 * Help and pressing a button, which is precisely what the people furthest
 * behind never do.
 *
 * It reports rather than nags: no modal, no interruption of what the user came
 * to the Hub for, and dismissing it is permanent for that state. It reappears
 * when the state genuinely moves on — `downloading` → `downloaded` is worth
 * one more line, because that transition is the one that turns "later" into
 * "one click".
 *
 * Deliberately silent about the states nobody asked to hear: `checking`,
 * `current`, `none` and `error` all render nothing here. A background check
 * that found nothing, or failed, is not news — Help's Updates row is where
 * someone who went looking gets the full story.
 */
export function UpdateNotice(): React.JSX.Element | null {
  const [state, setState] = useState<UpdateState | null>(null)
  /** The status the user dismissed, so a real change can still speak up. */
  const [dismissed, setDismissed] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    void window.murmur.app
      .updateState()
      .then((next) => {
        if (active) setState(next)
      })
      .catch(() => undefined)
    const unsubscribe = window.murmur.app.onUpdateChanged((next) => {
      if (active) setState(next)
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  const status = state?.status
  const shown = status === 'available' || status === 'downloading' || status === 'downloaded'
  if (!state || !shown || dismissed === status) return null

  const version = state.latestVersion ?? ''

  return (
    <div
      role="status"
      aria-live="polite"
      className="hub-toast pointer-events-auto fixed right-6 top-6 z-50 w-[min(340px,calc(100%-2rem))] rounded-xl border border-accent/30 bg-surface px-4 py-3 shadow-lg"
    >
      <div className="flex items-start gap-3">
        {/* An arrow into a tray: the download glyph everyone already reads. */}
        <svg
          viewBox="0 0 24 24"
          aria-hidden="true"
          className="mt-0.5 size-[15px] shrink-0 text-accent"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M12 4v10m0 0 4-4m-4 4-4-4M5 18h14" />
        </svg>

        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium text-ink">
            {status === 'downloaded'
              ? `Murmur ${version} is ready to install`
              : status === 'downloading'
                ? `Downloading Murmur ${version}`
                : `Murmur ${version} is available`}
          </p>
          <p className="mt-1 text-[12px] leading-relaxed text-ink-muted">
            {status === 'downloaded'
              ? 'Restart to finish. Your models, history and settings are untouched.'
              : status === 'downloading'
                ? `Downloading in the background… ${state.percent ?? 0}%`
                : 'Ready to download.'}
          </p>

          {status === 'downloading' ? (
            <div
              role="progressbar"
              aria-valuenow={state.percent ?? 0}
              aria-valuemin={0}
              aria-valuemax={100}
              className="mt-2 h-1 w-full overflow-hidden rounded-full bg-line"
            >
              <div
                className="h-full rounded-full bg-accent transition-[width] duration-200"
                style={{ width: `${state.percent ?? 0}%` }}
              />
            </div>
          ) : null}

          {status === 'downloaded' ? (
            <button
              type="button"
              onClick={() => void window.murmur.app.installUpdate().catch(() => undefined)}
              className="mt-2 rounded-lg border border-accent/40 bg-accent/10 px-3 py-1.5 text-[12px] font-medium text-accent transition-colors hover:bg-accent/15"
            >
              Restart to update
            </button>
          ) : null}

          {/* Only when the automatic fetch is switched off; otherwise the
              download is already under way and a button would be a lie. */}
          {status === 'available' ? (
            <button
              type="button"
              onClick={() => void window.murmur.app.downloadUpdate().catch(() => undefined)}
              className="mt-2 rounded-lg border border-accent/40 bg-accent/10 px-3 py-1.5 text-[12px] font-medium text-accent transition-colors hover:bg-accent/15"
            >
              Download
            </button>
          ) : null}
        </div>

        <button
          type="button"
          className="grid size-6 shrink-0 place-items-center rounded-md text-ink-faint transition-colors hover:bg-canvas hover:text-ink"
          onClick={() => setDismissed(status ?? null)}
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
