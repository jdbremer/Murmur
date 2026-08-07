import { CUE, cueNotes, renderEnvelope, type DictationCue } from './cues'

/**
 * Plays the dictation cue (PLAN §2.1). The imperative half of {@link ./cues},
 * which owns every number this file schedules.
 *
 * Synthesised rather than sampled — one `OscillatorNode` per note through its
 * own envelope. That is partly policy (PLAN §2 forbids lifting assets from the
 * reference product) and partly that a two-note sine figure is smaller as code
 * than as a `.wav`, needs no decode on the hot path, and sidesteps the
 * `script-src 'self'` rule that already keeps the capture worklet out of a
 * `data:` URL.
 *
 * It lives in the hidden capture window because that is the only renderer that
 * is created once and never torn down. The Bar would seem the obvious home, but
 * main hides that window between utterances and unmounts it entirely when the
 * Bar is set to Hidden — which is exactly the configuration where the cue is
 * the only feedback the user gets.
 */

/**
 * Scheduling lead. Everything is queued against the context clock rather than
 * fired from a timer, so the two notes keep their spacing no matter what the
 * main thread is doing; this is just enough slack to stay ahead of it.
 */
const LEAD_S = 0.005

export class CuePlayer {
  #context: AudioContext | null = null
  #disposed = false

  /**
   * Bring the context up before the first cue is needed.
   *
   * Worth doing eagerly: a context created on the first keypress starts
   * suspended and has to be resumed, and that resume is tens of milliseconds —
   * enough to put the cue audibly behind the key that caused it.
   */
  async warm(): Promise<void> {
    try {
      await this.#ready()
    } catch {
      // A machine with no output device is not a reason to fail the capture
      // page; the cue is the one part of this window that is decoration.
    }
  }

  async play(cue: DictationCue): Promise<void> {
    const context = await this.#ready()
    if (!context || this.#disposed) return

    const startAt = context.currentTime + LEAD_S
    for (const note of cueNotes(cue)) {
      const oscillator = context.createOscillator()
      const gain = context.createGain()

      oscillator.type = 'sine'
      oscillator.frequency.value = note.frequencyHz

      // The envelope's own first sample is zero, but the parameter has to be
      // silent before the curve takes over too, or the note leaks a DC step.
      gain.gain.value = 0

      const at = startAt + note.atMs / 1000
      const duration = CUE.noteDurationMs / 1000
      gain.gain.setValueCurveAtTime(renderEnvelope(note), at, duration)

      oscillator.connect(gain).connect(context.destination)
      oscillator.start(at)
      oscillator.stop(at + duration)
      oscillator.onended = () => {
        oscillator.disconnect()
        gain.disconnect()
      }
    }
  }

  dispose(): void {
    this.#disposed = true
    const context = this.#context
    this.#context = null
    if (context) void context.close().catch(() => {})
  }

  async #ready(): Promise<AudioContext | null> {
    if (this.#disposed) return null
    this.#context ??= new AudioContext()

    // This window is never shown, so Chromium's own reasons to suspend the
    // context are the normal case here rather than an edge case — the same
    // reason `capture.ts` re-checks this on every open.
    if (this.#context.state === 'suspended') await this.#context.resume()
    return this.#disposed ? null : this.#context
  }
}
