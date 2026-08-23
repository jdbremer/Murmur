import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'

import type { DictationErrorCode, DictationEvent } from '@murmur/shared'

import {
  dismissToast,
  expireToasts,
  nextExpiryMs,
  pauseToasts,
  pushToast,
  resumeToasts,
  type Toast,
  type ToastInput,
} from '../../design/toast-stack'

/**
 * Toasts for the Hub (PLAN §2.2.6).
 *
 * This replaces a component that could show exactly one message, only ever
 * about a dictation failure, with no way for the rest of the app to say
 * anything. Two things follow from that, and both are the point:
 *
 *  - **Anything can post one.** `useToast()` is available to every section, so
 *    "Copied", "Saved", "Model removed" stop being invisible.
 *  - **Some of them can be taken back.** A toast carrying an action is how
 *    destructive-but-ordinary operations get to be one click instead of a
 *    confirmation dialog. Deleting a dictation used to be instant and final;
 *    now it is instant and reversible, which is both faster and safer.
 *
 * The stack's rules — coalescing, capping, pausing — live in
 * `design/toast-stack.ts` as pure functions. What is left here is the parts
 * that genuinely need a renderer: one timer, the leave animation, and the map
 * from a toast to the callback its button runs.
 */

interface ToastApi {
  show: (input: ToastInput & { onAction?: () => void }) => string
  dismiss: (id: string) => void
}

const ToastContext = createContext<ToastApi | null>(null)

/**
 * Post a toast from anywhere inside the Hub.
 *
 * Returns a no-op API outside a provider rather than throwing: a missing toast
 * is not worth taking a section down over, and the Notes window renders some of
 * the same components without one.
 */
export function useToast(): ToastApi {
  return useContext(ToastContext) ?? NO_TOASTS
}

const NO_TOASTS: ToastApi = { show: () => '', dismiss: () => undefined }

/** How long the leave animation runs — kept in step with `.toast-leave`. */
const LEAVE_MS = 160

export function ToastProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [toasts, setToasts] = useState<Toast[]>([])
  const [leaving, setLeaving] = useState<readonly string[]>([])
  const actions = useRef(new Map<string, () => void>())
  const counter = useRef(0)

  const forget = useCallback((id: string): void => {
    actions.current.delete(id)
    setLeaving((current) => current.filter((value) => value !== id))
  }, [])

  /** Animate out, then drop. Called by expiry, the ✕, and the action itself. */
  const retire = useCallback(
    (id: string): void => {
      setLeaving((current) => (current.includes(id) ? current : [...current, id]))
      window.setTimeout(() => {
        setToasts((current) => dismissToast(current, id))
        forget(id)
      }, LEAVE_MS)
    },
    [forget],
  )

  const show = useCallback((input: ToastInput & { onAction?: () => void }): string => {
    counter.current += 1
    const id = `toast-${counter.current}`
    if (input.onAction) actions.current.set(id, input.onAction)
    setToasts((current) => {
      const next = pushToast(current, input, id, Date.now())
      // Coalescing and capping can both drop ids; anything no longer in the
      // stack must not keep a callback alive behind it.
      const live = new Set(next.map((toast) => toast.id))
      for (const key of actions.current.keys()) if (!live.has(key)) actions.current.delete(key)
      return next
    })
    return id
  }, [])

  const api = useMemo<ToastApi>(() => ({ show, dismiss: retire }), [show, retire])

  // One timer for the whole stack, re-armed whenever the stack changes. N
  // timers would mean N re-renders and N chances to leak one on unmount.
  useEffect(() => {
    const due = nextExpiryMs(toasts, Date.now())
    if (due === null) return
    const timer = window.setTimeout(
      () => {
        // `expireToasts` is the authority on what is still due; anything it
        // drops is retired here so it leaves through the animation rather than
        // vanishing mid-frame.
        const surviving = new Set(expireToasts(toasts, Date.now()).map((toast) => toast.id))
        for (const toast of toasts) if (!surviving.has(toast.id)) retire(toast.id)
      },
      // A floor, so a zero-length remainder cannot spin.
      Math.max(16, due),
    )
    return () => window.clearTimeout(timer)
  }, [toasts, retire])

  // Escape dismisses the newest toast — the fastest way out of a stack that
  // has appeared over what you were reading.
  useEffect(() => {
    if (toasts.length === 0) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      const newest = toasts[toasts.length - 1]
      if (newest) retire(newest.id)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toasts, retire])

  // Dictation failures post themselves. The pill says two or three words
  // because that is what fits on the pill; the sentence explaining it belongs
  // here, where there is room and nothing is on a 2.5s timer.
  useEffect(() => {
    return window.murmur.dictation.subscribe((event: DictationEvent) => {
      if (event.state !== 'error') return
      show({
        message: event.message,
        detail: TOAST_HINT[event.code],
        tone: 'danger',
      })
    })
  }, [show])

  const runAction = (toast: Toast): void => {
    actions.current.get(toast.id)?.()
    retire(toast.id)
  }

  return (
    <ToastContext.Provider value={api}>
      {children}
      {toasts.length > 0 ? (
        <div
          // Bottom-centre, opposite the update notice in the top-right corner,
          // so a failure and a pending update never stack on each other.
          className="toast-stack pointer-events-none fixed inset-x-0 bottom-6 z-50 flex flex-col items-center gap-2"
          onMouseEnter={() => setToasts((current) => pauseToasts(current, Date.now()))}
          onMouseLeave={() => setToasts((current) => resumeToasts(current, Date.now()))}
        >
          {toasts.map((toast) => (
            <ToastRow
              key={toast.id}
              toast={toast}
              leaving={leaving.includes(toast.id)}
              onAction={() => runAction(toast)}
              onDismiss={() => retire(toast.id)}
            />
          ))}
        </div>
      ) : null}
    </ToastContext.Provider>
  )
}

const TONE_BORDER: Record<Toast['tone'], string> = {
  neutral: 'border-line',
  positive: 'border-positive/35',
  warning: 'border-warning/35',
  danger: 'border-danger/35',
}

const TONE_TEXT: Record<Toast['tone'], string> = {
  neutral: 'text-ink-faint',
  positive: 'text-positive',
  warning: 'text-warning',
  danger: 'text-danger',
}

function ToastRow({
  toast,
  leaving,
  onAction,
  onDismiss,
}: {
  toast: Toast
  leaving: boolean
  onAction: () => void
  onDismiss: () => void
}): React.JSX.Element {
  return (
    <div
      // `alert` interrupts; `status` waits for a pause. A failure is worth
      // interrupting for and a confirmation is not.
      role={toast.tone === 'danger' ? 'alert' : 'status'}
      className={[
        'pointer-events-auto relative w-[min(440px,calc(100vw-3rem))] overflow-hidden rounded-xl border bg-surface-raised px-4 pb-3.5 pt-3 elev-3',
        TONE_BORDER[toast.tone],
        leaving ? 'toast-leave' : 'toast-enter',
      ].join(' ')}
    >
      <div className="flex items-start gap-3">
        <ToastIcon tone={toast.tone} />

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">
              {toast.message}
            </p>
            {/* Two identical failures are one failure that happened twice. */}
            {toast.count > 1 ? (
              <span className="shrink-0 rounded-full bg-surface-sunken px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-ink-muted">
                ×{toast.count}
              </span>
            ) : null}
          </div>
          {toast.detail ? (
            <p className="mt-1 text-[12px] leading-relaxed text-ink-muted">{toast.detail}</p>
          ) : null}
        </div>

        {toast.actionLabel ? (
          <button
            type="button"
            onClick={onAction}
            className="shrink-0 rounded-lg border border-line bg-surface px-2.5 py-1 text-[12px] font-medium text-ink transition-colors duration-150 hover:border-ink-faint hover:bg-canvas"
          >
            {toast.actionLabel}
          </button>
        ) : null}

        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="grid size-6 shrink-0 place-items-center rounded-md text-ink-faint transition-colors hover:bg-canvas hover:text-ink"
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

      {/*
        The countdown, and only on toasts that carry an action.
        A confirmation does not need one — it says its piece and goes, and a
        draining bar under every "Copied" is noise. An *undoable* toast is the
        case where the remaining time is real information: it is the difference
        between reaching for Undo and finding it already gone.

        Inset and rounded rather than full-bleed: run it to the edges and the
        left end disappears into the corner radius while the right end stops in
        a hard vertical cut, which reads as a chipped card rather than a
        progress bar.

        Keyed on `startedAt` so a coalesced repeat gets a fresh element and
        therefore a fresh animation — without the key React reuses the node and
        the bar keeps draining from wherever it had got to.
      */}
      {toast.actionLabel && toast.durationMs !== null ? (
        <span
          key={toast.startedAt}
          aria-hidden="true"
          className={`toast-timer absolute inset-x-3 bottom-[3px] h-[2px] origin-left rounded-full ${
            toast.tone === 'neutral' ? 'bg-ink/20' : 'bg-current'
          } ${TONE_TEXT[toast.tone]}`}
          style={{ ['--toast-duration' as string]: `${toast.durationMs}ms` }}
        />
      ) : null}
    </div>
  )
}

function ToastIcon({ tone }: { tone: Toast['tone'] }): React.JSX.Element {
  const path =
    tone === 'positive'
      ? 'M20 6 9 17l-5-5'
      : tone === 'neutral'
        ? 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5M12 7.5h.01'
        : 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7.5v5.5M12 16.5h.01'
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className={`mt-0.5 size-[15px] shrink-0 ${TONE_TEXT[tone]}`}
      fill="none"
      stroke="currentColor"
      strokeWidth={tone === 'positive' ? '2.4' : '1.8'}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={path} />
    </svg>
  )
}

/**
 * What to do about it, for the failures where that is not obvious.
 *
 * The long half of the split described in `DICTATION_ERROR_LABEL`: the pill
 * shows two or three words because it has room for two or three words.
 */
const TOAST_HINT: Partial<Record<DictationErrorCode, string>> = {
  'stt-failed': 'Open Models to download and select a speech-to-text model.',
  'polish-failed': 'The transcript was inserted unpolished. Check the polishing model in Models.',
  'secure-input':
    'macOS blocks typing into password fields. Dictate somewhere else, or paste it yourself.',
  'mic-unavailable':
    'Check the microphone in Settings, and that no other app is holding the device.',
  'insert-failed': 'Murmur needs Accessibility permission to type. Check Help.',
}
