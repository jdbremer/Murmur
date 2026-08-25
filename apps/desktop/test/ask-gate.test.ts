import { describe, expect, it } from 'vitest'

import { PreemptedError, PriorityGate, isPreempted } from '../src/main/engines/gate'

/**
 * The one-slot scheduler in front of `llama-server` (PLAN §2.2.9).
 *
 * The property under test is Murmur's central latency promise: a dictation must
 * never wait for an Ask answer. `llama-server` runs with `--parallel 1`, so
 * ordinary queueing would put a hotkey press behind up to twenty seconds of
 * chat generation — which is exactly the wait the app exists to remove.
 */

/** A task that parks until the test releases it, or until it is aborted. */
function parked(signal: AbortSignal): { promise: Promise<string>; finish: () => void } {
  let finish = (): void => undefined
  const promise = new Promise<string>((resolve, reject) => {
    finish = () => resolve('finished')
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
  return { promise, finish }
}

/** Let the microtask queue drain, so pending acquires can settle. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

describe('PriorityGate', () => {
  it('hands the slot straight over when nothing holds it', async () => {
    const gate = new PriorityGate()
    const lease = await gate.acquire('low')
    expect(gate.busy).toBe(true)
    lease.release()
    expect(gate.busy).toBe(false)
  })

  it('aborts a low-priority holder as soon as a dictation asks', async () => {
    const gate = new PriorityGate()
    const chat = await gate.acquire('low')
    expect(chat.signal.aborted).toBe(false)

    void gate.acquire('high')
    await settle()

    expect(chat.signal.aborted).toBe(true)
    expect(isPreempted(chat.signal.reason)).toBe(true)
  })

  it('still waits for the preempted holder to release before running', async () => {
    // The abort is a request, not a seizure: the low-priority task still owns an
    // in-flight HTTP request, and starting a second one before its socket is
    // gone puts two requests into a server with exactly one slot.
    const gate = new PriorityGate()
    const chat = await gate.acquire('low')

    let dictating = false
    const dictation = gate.acquire('high').then((lease) => {
      dictating = true
      return lease
    })

    await settle()
    expect(dictating).toBe(false)

    chat.release()
    await dictation
    expect(dictating).toBe(true)
  })

  it('does not abort another dictation', async () => {
    const gate = new PriorityGate()
    const first = await gate.acquire('high')
    void gate.acquire('high')
    await settle()
    expect(first.signal.aborted).toBe(false)
  })

  it('puts a dictation ahead of chat requests already queued', async () => {
    const gate = new PriorityGate()
    const holder = await gate.acquire('high')

    const order: string[] = []
    const chatA = gate.acquire('low').then((l) => {
      order.push('chatA')
      return l
    })
    const chatB = gate.acquire('low').then((l) => {
      order.push('chatB')
      return l
    })
    const dictation = gate.acquire('high').then((l) => {
      order.push('dictation')
      return l
    })

    await settle()
    holder.release()
    ;(await dictation).release()
    await settle()
    ;(await chatA).release()
    await settle()
    ;(await chatB).release()

    // Dictation first despite queueing last; the two chats keep their own order.
    expect(order).toEqual(['dictation', 'chatA', 'chatB'])
  })

  it('treats release as idempotent', async () => {
    const gate = new PriorityGate()
    const lease = await gate.acquire('low')
    lease.release()
    lease.release()
    expect(gate.busy).toBe(false)
  })

  it('ignores a late release from a lease that already lost the slot', async () => {
    // The real sequence: chat is preempted, its `finally` runs and releases —
    // but by then a dictation may already hold the slot. Freeing it here would
    // let a third task start while the dictation is mid-request.
    const gate = new PriorityGate()
    const chat = await gate.acquire('low')
    const dictation = gate.acquire('high')
    await settle()

    chat.release()
    const held = await dictation
    chat.release()

    expect(gate.busy).toBe(true)
    held.release()
    expect(gate.busy).toBe(false)
  })

  it('runs and releases even when the task throws', async () => {
    const gate = new PriorityGate()
    await expect(
      gate.run('low', () => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom')
    expect(gate.busy).toBe(false)
  })

  it('propagates the preemption into a running task', async () => {
    const gate = new PriorityGate()
    const task = gate.run('low', (signal) => parked(signal).promise)
    await settle()

    const dictation = gate.acquire('high')
    await expect(task).rejects.toBeInstanceOf(PreemptedError)

    // And the slot really did come free for the dictation.
    ;(await dictation).release()
    expect(gate.busy).toBe(false)
  })

  it('settles every waiter on drain rather than leaving them pending', async () => {
    // `drain()` runs on the quit path. A promise that never settles there is a
    // hang, not a leak.
    const gate = new PriorityGate()
    const holder = await gate.acquire('low')
    const waiting = gate.acquire('low')

    gate.drain()
    expect(holder.signal.aborted).toBe(true)

    const lease = await waiting
    expect(lease.signal.aborted).toBe(true)
    expect(isPreempted(lease.signal.reason)).toBe(true)
  })

  it('reports a preemption regardless of how the error crossed a boundary', () => {
    // The reason travels through `AbortSignal.any` and a generator, and
    // structured-clone-style copies lose the prototype. Name-matching is the
    // fallback that keeps a dictation from looking like a user cancel.
    expect(isPreempted(new PreemptedError())).toBe(true)
    expect(isPreempted({ name: 'PreemptedError' })).toBe(true)
    expect(isPreempted(new Error('something else'))).toBe(false)
    expect(isPreempted(null)).toBe(false)
    expect(isPreempted(undefined)).toBe(false)
  })
})
