/**
 * The toast stack (PLAN §2.2.6).
 *
 * Everything here is a pure function over a list so the rules can be tested
 * without a renderer — and these rules are where toasts usually go wrong:
 *
 *  - **Two identical messages coalesce; two undoable ones never do.** Failing
 *    to dictate twice for the same reason should say "×2", not stack two
 *    boxes. But two deletions are two different undos, and merging them would
 *    silently discard one — so anything carrying an action is exempt.
 *  - **Hovering pauses the clock.** A toast that vanishes while you are
 *    reaching for its Undo is worse than no undo at all.
 *  - **The stack is capped and drops the oldest.** Not the newest: the newest
 *    is the one that describes what just happened.
 */

export type ToastTone = 'neutral' | 'positive' | 'warning' | 'danger'

export interface ToastInput {
  message: string
  /** The sentence that explains it. The message is the headline. */
  detail?: string | undefined
  tone?: ToastTone
  /** Presence of a label is what makes a toast undoable. */
  actionLabel?: string | undefined
  /** Overrides the per-tone default. `null` pins the toast until dismissed. */
  durationMs?: number | null | undefined
}

export interface Toast {
  id: string
  message: string
  detail: string | null
  tone: ToastTone
  actionLabel: string | null
  /** null = stays until dismissed. */
  durationMs: number | null
  /** When the current countdown started; moves forward on resume. */
  startedAt: number
  /** Non-null while the pointer is over the stack. */
  pausedAt: number | null
  /** How many identical toasts have merged into this one. */
  count: number
}

/** Three is the point where a stack stops being readable at a glance. */
export const TOAST_LIMIT = 3

/**
 * How long each tone lingers. A failure needs re-reading and often names a fix,
 * so it gets longest; a confirmation is glanceable and gets least. An undoable
 * toast overrides all of these — see `toastDuration`.
 */
export const TOAST_DURATION_MS: Record<ToastTone, number> = {
  neutral: 5_000,
  positive: 4_000,
  warning: 7_000,
  danger: 8_000,
}

/** Long enough to notice the toast, read it, and decide. */
export const TOAST_UNDO_MS = 9_000

export function toastDuration(input: ToastInput): number | null {
  if (input.durationMs !== undefined) return input.durationMs
  if (input.actionLabel) return TOAST_UNDO_MS
  return TOAST_DURATION_MS[input.tone ?? 'neutral']
}

export function createToast(input: ToastInput, id: string, now: number): Toast {
  return {
    id,
    message: input.message,
    detail: input.detail ?? null,
    tone: input.tone ?? 'neutral',
    actionLabel: input.actionLabel ?? null,
    durationMs: toastDuration(input),
    startedAt: now,
    pausedAt: null,
    count: 1,
  }
}

/**
 * Add a toast, coalescing and capping.
 *
 * The stack is ordered oldest-first; the host renders it bottom-anchored, so
 * the newest ends up nearest the edge where the user's attention already is.
 */
export function pushToast(
  toasts: readonly Toast[],
  input: ToastInput,
  id: string,
  now: number,
): Toast[] {
  const incoming = createToast(input, id, now)

  const newest = toasts[toasts.length - 1]
  if (
    newest &&
    !newest.actionLabel &&
    !incoming.actionLabel &&
    newest.message === incoming.message &&
    newest.tone === incoming.tone
  ) {
    // Merge: keep the original id so the element is not torn down and
    // re-animated, but restart its clock — this *is* a new occurrence.
    const merged: Toast = {
      ...newest,
      count: newest.count + 1,
      startedAt: now,
      pausedAt: null,
      detail: incoming.detail,
    }
    return [...toasts.slice(0, -1), merged]
  }

  const next = [...toasts, incoming]
  return next.length > TOAST_LIMIT ? next.slice(next.length - TOAST_LIMIT) : next
}

export function dismissToast(toasts: readonly Toast[], id: string): Toast[] {
  return toasts.filter((toast) => toast.id !== id)
}

/** Drop every toast whose time is up. Paused toasts have no time. */
export function expireToasts(toasts: readonly Toast[], now: number): Toast[] {
  return toasts.filter((toast) => remainingMs(toast, now) !== 0)
}

/**
 * Milliseconds left on a toast: `null` when it never expires, `0` when it is
 * due. Paused toasts report what they had left when the pointer arrived.
 */
export function remainingMs(toast: Toast, now: number): number | null {
  if (toast.durationMs === null) return null
  const reference = toast.pausedAt ?? now
  return Math.max(0, toast.durationMs - (reference - toast.startedAt))
}

/**
 * When the host should next wake up, in ms — or `null` when nothing is on a
 * clock. One timer for the whole stack rather than one per toast: N timers
 * means N re-renders and N chances to leak one on unmount.
 */
export function nextExpiryMs(toasts: readonly Toast[], now: number): number | null {
  let soonest: number | null = null
  for (const toast of toasts) {
    const left = remainingMs(toast, now)
    if (left === null) continue
    if (soonest === null || left < soonest) soonest = left
  }
  return soonest
}

export function pauseToasts(toasts: readonly Toast[], now: number): Toast[] {
  if (toasts.every((toast) => toast.pausedAt !== null)) return toasts as Toast[]
  return toasts.map((toast) => (toast.pausedAt === null ? { ...toast, pausedAt: now } : toast))
}

/**
 * Resume, preserving what was left rather than restarting the countdown —
 * sliding `startedAt` forward by the paused interval does both at once.
 */
export function resumeToasts(toasts: readonly Toast[], now: number): Toast[] {
  if (toasts.every((toast) => toast.pausedAt === null)) return toasts as Toast[]
  return toasts.map((toast) =>
    toast.pausedAt === null
      ? toast
      : { ...toast, startedAt: toast.startedAt + (now - toast.pausedAt), pausedAt: null },
  )
}
