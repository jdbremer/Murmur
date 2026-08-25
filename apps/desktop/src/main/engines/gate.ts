/**
 * A one-slot scheduler with preemption, sitting in front of `llama-server`.
 *
 * The sidecar runs with `--parallel 1` — deliberately, because parallel slots
 * fragment the KV cache and Murmur's whole reason for keeping a model resident
 * is that the *next dictation* is fast. That was uncontroversial while polishing
 * was the only caller: requests are short and arrive one at a time.
 *
 * Ask breaks that assumption. A grounded answer takes seconds to generate, and
 * for all of those seconds the single slot is occupied. Queueing normally would
 * mean a user who holds their hotkey mid-conversation waits for a chat answer to
 * finish before their own words appear — which is precisely the latency Murmur
 * exists to avoid, traded away for a secondary feature.
 *
 * So dictation preempts. A high-priority acquire aborts whatever low-priority
 * work holds the slot, and the abort is a *signal*, not a kill: the chat stream
 * keeps the text it has already produced, marks itself paused, and reruns when
 * the slot comes back. Dictation waits on nothing but the abort round trip.
 *
 * Kept separate from the engine because "who gets the model next" is a policy
 * worth testing on its own — with fake tasks, deterministically — rather than
 * only through a running sidecar.
 */

export type GatePriority = 'high' | 'low'

/** Thrown into a low-priority task's abort signal when dictation needs the slot. */
export class PreemptedError extends Error {
  constructor() {
    super('Interrupted so a dictation could use the model')
    this.name = 'PreemptedError'
  }
}

export function isPreempted(error: unknown): boolean {
  return error instanceof PreemptedError || (error as { name?: string })?.name === 'PreemptedError'
}

export interface GateLease {
  /**
   * Fires when something more important wants the slot.
   *
   * Low-priority holders must watch this. Ignoring it does not make the task
   * safe — it makes dictation wait, which is the failure this class exists to
   * prevent.
   */
  readonly signal: AbortSignal
  release(): void
}

interface Waiter {
  priority: GatePriority
  resolve: (lease: GateLease) => void
}

export class PriorityGate {
  #active: { controller: AbortController; released: boolean; priority: GatePriority } | null = null
  #waiters: Waiter[] = []

  get busy(): boolean {
    return this.#active !== null
  }

  get waiting(): number {
    return this.#waiters.length
  }

  /**
   * Take the slot, waiting if it is held.
   *
   * A high-priority acquire against a low-priority holder aborts that holder
   * immediately, then waits for it to actually release — the holder still owns
   * an in-flight HTTP request, and starting a second one before its socket is
   * gone would put two requests into a server with one slot.
   */
  acquire(priority: GatePriority): Promise<GateLease> {
    if (!this.#active) return Promise.resolve(this.#start(priority))

    if (priority === 'high') this.#preemptLow()

    return new Promise<GateLease>((resolve) => {
      this.#waiters.push({ priority, resolve })
      // Stable sort, so `high` jumps ahead of every pending `low` while
      // same-priority waiters keep the order they arrived in. A high-priority
      // caller that queued behind three chat retries is the same bug as no
      // priority at all.
      this.#waiters.sort((a, b) => rank(a.priority) - rank(b.priority))
    })
  }

  /** Acquire, run, release — including when `task` throws. */
  async run<T>(priority: GatePriority, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const lease = await this.acquire(priority)
    try {
      return await task(lease.signal)
    } finally {
      lease.release()
    }
  }

  /**
   * Abort every holder and waiter — engine teardown, or a model swap.
   *
   * Waiters are rejected by resolving them with an already-aborted lease rather
   * than leaving them pending forever: a promise that never settles during
   * shutdown is a hang, and this runs on the quit path.
   */
  drain(): void {
    this.#preemptLow(true)
    const waiters = this.#waiters
    this.#waiters = []
    for (const waiter of waiters) {
      const controller = new AbortController()
      controller.abort(new PreemptedError())
      waiter.resolve({ signal: controller.signal, release: () => undefined })
    }
  }

  #preemptLow(includeHigh = false): void {
    const active = this.#active
    if (!active || active.released) return
    if (!includeHigh && active.priority !== 'low') return
    if (!active.controller.signal.aborted) active.controller.abort(new PreemptedError())
  }

  #start(priority: GatePriority = 'high'): GateLease {
    const controller = new AbortController()
    const active = { controller, released: false, priority }
    this.#active = active
    return {
      signal: controller.signal,
      release: () => {
        // Idempotent, and scoped to *this* lease: a task that releases twice,
        // or releases late after being preempted, must not free a slot that a
        // different task has since taken.
        if (active.released || this.#active !== active) return
        active.released = true
        this.#active = null
        this.#pump()
      },
    }
  }

  #pump(): void {
    const next = this.#waiters.shift()
    if (!next) return
    next.resolve(this.#start(next.priority))
  }
}

function rank(priority: GatePriority): number {
  return priority === 'high' ? 0 : 1
}
