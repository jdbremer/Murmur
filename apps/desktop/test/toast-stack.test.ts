import { describe, expect, it } from 'vitest'

import {
  createToast,
  dismissToast,
  expireToasts,
  nextExpiryMs,
  pauseToasts,
  pushToast,
  remainingMs,
  resumeToasts,
  TOAST_DURATION_MS,
  TOAST_LIMIT,
  TOAST_UNDO_MS,
  toastDuration,
  type Toast,
} from '../src/renderer/design/toast-stack'

const at = (now: number, ...messages: string[]): Toast[] =>
  messages.reduce<Toast[]>(
    (list, message, index) => pushToast(list, { message }, `id-${index}`, now),
    [],
  )

describe('toastDuration', () => {
  it('gives a failure longer than a confirmation', () => {
    expect(TOAST_DURATION_MS.danger).toBeGreaterThan(TOAST_DURATION_MS.positive)
  })

  it('gives an undoable toast longest of all — it has to be read and acted on', () => {
    expect(toastDuration({ message: 'Deleted', actionLabel: 'Undo' })).toBe(TOAST_UNDO_MS)
    expect(TOAST_UNDO_MS).toBeGreaterThan(TOAST_DURATION_MS.danger)
  })

  it('lets an explicit duration win, null included', () => {
    expect(toastDuration({ message: 'x', durationMs: 200 })).toBe(200)
    expect(toastDuration({ message: 'x', tone: 'danger', durationMs: null })).toBeNull()
  })
})

describe('pushToast', () => {
  it('appends oldest-first', () => {
    const list = at(0, 'first', 'second')
    expect(list.map((toast) => toast.message)).toEqual(['first', 'second'])
  })

  it('coalesces a repeat of the newest toast instead of stacking a duplicate', () => {
    const once = pushToast([], { message: 'No model' }, 'a', 0)
    const twice = pushToast(once, { message: 'No model' }, 'b', 300)

    expect(twice).toHaveLength(1)
    expect(twice[0]?.count).toBe(2)
    // Same id: the element stays mounted rather than re-animating in place.
    expect(twice[0]?.id).toBe('a')
    // New occurrence, new clock.
    expect(twice[0]?.startedAt).toBe(300)
  })

  it('never coalesces undoable toasts — two deletions are two different undos', () => {
    const first = pushToast([], { message: 'Deleted', actionLabel: 'Undo' }, 'a', 0)
    const second = pushToast(first, { message: 'Deleted', actionLabel: 'Undo' }, 'b', 10)
    expect(second).toHaveLength(2)
    expect(second.map((toast) => toast.id)).toEqual(['a', 'b'])
  })

  it('only merges into the newest, so an unrelated toast in between splits the run', () => {
    let list = pushToast([], { message: 'same' }, 'a', 0)
    list = pushToast(list, { message: 'other' }, 'b', 1)
    list = pushToast(list, { message: 'same' }, 'c', 2)
    expect(list.map((toast) => toast.message)).toEqual(['same', 'other', 'same'])
  })

  it('keeps tones apart even when the words match', () => {
    let list = pushToast([], { message: 'Saved', tone: 'positive' }, 'a', 0)
    list = pushToast(list, { message: 'Saved', tone: 'danger' }, 'b', 1)
    expect(list).toHaveLength(2)
  })

  it('caps the stack and drops the oldest, not the newest', () => {
    const list = at(0, 'one', 'two', 'three', 'four', 'five')
    expect(list).toHaveLength(TOAST_LIMIT)
    expect(list[list.length - 1]?.message).toBe('five')
    expect(list.map((toast) => toast.message)).not.toContain('one')
  })

  it('resets the merged toast to unpaused, so a repeat is never stuck', () => {
    const paused = pauseToasts(pushToast([], { message: 'x' }, 'a', 0), 100)
    const merged = pushToast(paused, { message: 'x' }, 'b', 200)
    expect(merged[0]?.pausedAt).toBeNull()
  })
})

describe('expiry', () => {
  it('reports time left, and zero once it is up', () => {
    const toast = createToast({ message: 'x', durationMs: 1_000 }, 'a', 0)
    expect(remainingMs(toast, 0)).toBe(1_000)
    expect(remainingMs(toast, 400)).toBe(600)
    expect(remainingMs(toast, 5_000)).toBe(0)
  })

  it('reports null for a sticky toast rather than a very large number', () => {
    const toast = createToast({ message: 'x', durationMs: null }, 'a', 0)
    expect(remainingMs(toast, 1e9)).toBeNull()
  })

  it('drops only what is due', () => {
    let list = pushToast([], { message: 'short', durationMs: 100 }, 'a', 0)
    list = pushToast(list, { message: 'long', durationMs: 10_000 }, 'b', 0)
    const left = expireToasts(list, 500)
    expect(left.map((toast) => toast.message)).toEqual(['long'])
  })

  it('never drops a sticky toast', () => {
    const list = pushToast([], { message: 'pinned', durationMs: null }, 'a', 0)
    expect(expireToasts(list, 1e9)).toHaveLength(1)
  })

  it('schedules one wake-up, at the soonest deadline', () => {
    let list = pushToast([], { message: 'a', durationMs: 5_000 }, 'a', 0)
    list = pushToast(list, { message: 'b', durationMs: 900 }, 'b', 0)
    expect(nextExpiryMs(list, 0)).toBe(900)
  })

  it('has nothing to wake up for when the stack is empty or all sticky', () => {
    expect(nextExpiryMs([], 0)).toBeNull()
    expect(nextExpiryMs(pushToast([], { message: 'x', durationMs: null }, 'a', 0), 0)).toBeNull()
  })
})

describe('pause and resume', () => {
  it('freezes the countdown while the pointer is over the stack', () => {
    const list = pauseToasts(pushToast([], { message: 'x', durationMs: 1_000 }, 'a', 0), 400)
    // 600ms left at the moment of pausing, and still 600ms a minute later.
    expect(remainingMs(list[0] as Toast, 400)).toBe(600)
    expect(remainingMs(list[0] as Toast, 60_000)).toBe(600)
    expect(expireToasts(list, 60_000)).toHaveLength(1)
  })

  it('resumes with what was left, not with a fresh countdown', () => {
    let list = pushToast([], { message: 'x', durationMs: 1_000 }, 'a', 0)
    list = pauseToasts(list, 400)
    list = resumeToasts(list, 10_400)
    expect(list[0]?.pausedAt).toBeNull()
    expect(remainingMs(list[0] as Toast, 10_400)).toBe(600)
    expect(remainingMs(list[0] as Toast, 11_100)).toBe(0)
  })

  it('is idempotent in both directions, so repeated pointer events cost nothing', () => {
    const list = pushToast([], { message: 'x' }, 'a', 0)
    expect(resumeToasts(list, 100)).toBe(list)
    const paused = pauseToasts(list, 100)
    expect(pauseToasts(paused, 900)).toBe(paused)
    expect(paused[0]?.pausedAt).toBe(100)
  })
})

describe('dismissToast', () => {
  it('removes exactly one, by id', () => {
    const list = at(0, 'one', 'two', 'three')
    const left = dismissToast(list, 'id-1')
    expect(left.map((toast) => toast.message)).toEqual(['one', 'three'])
  })

  it('is a no-op for an id that has already gone', () => {
    const list = at(0, 'one')
    expect(dismissToast(list, 'nope')).toHaveLength(1)
  })
})
