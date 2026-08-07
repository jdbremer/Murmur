/**
 * Fans microphone frames out to everything that wants them.
 *
 * Until meetings existed there was exactly one consumer, so `audio.frame` went
 * straight to `orchestrator.pushFrame`. Now dictation and a meeting recording
 * can both be live at once.
 *
 * The fan-out sits **upstream of the orchestrator**, at the IPC boundary, so
 * one `framePcm()` copy is made per frame and every subscriber shares the same
 * `Float32Array`. That is safe because nothing downstream mutates a frame in
 * place: `UtteranceBuffer` and `PreRollBuffer` store the reference and
 * `slice()`/`subarray()` when they read. If that ever stops being true this is
 * the comment that will be wrong first.
 */
export type FrameListener = (frame: Float32Array) => void

export class FrameBus {
  readonly #listeners = new Set<FrameListener>()

  subscribe(listener: FrameListener): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  publish(frame: Float32Array): void {
    // Iterate a copy: a listener that unsubscribes itself mid-publish (the
    // recorder does exactly this when a write fails) must not disturb the walk.
    for (const listener of [...this.#listeners]) {
      listener(frame)
    }
  }

  get size(): number {
    return this.#listeners.size
  }
}
