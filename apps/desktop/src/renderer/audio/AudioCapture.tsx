import { useEffect } from 'react'

/**
 * The hidden capture page (PLAN §3.1, §5).
 *
 * This window is never shown; it exists because `getUserMedia` lives in a
 * renderer. The main-process half is finished — the orchestrator drives capture
 * over the `audio.command` event and consumes `audio.frame` — so what remains
 * for the renderer stage is:
 *
 *  1. subscribe with `window.murmur.audio.onCommand`; the payload is
 *     `{ action: 'warm' | 'start' | 'stop' | 'release', deviceId: string | null }`.
 *     `warm` opens the stream but drops frames, `start` begins streaming,
 *     `stop` pauses without closing, `release` closes it;
 *  2. run an `AudioWorklet` that downsamples to 16 kHz mono Float32 and emit
 *     ~100 ms frames via `sendFrame({ pcm, sampleCount, sampleRate: 16000, ts })`
 *     — `pcm` is the raw `ArrayBuffer`, and main copies it on arrival;
 *  3. report lifecycle with `reportStatus`; an `error` status is turned into a
 *     `mic-unavailable` dictation error by the orchestrator.
 *
 * It deliberately does **not** call `getUserMedia` on load: asking for the
 * microphone before the user has been told why would be the wrong first
 * impression, and the permission flow belongs to onboarding.
 */
export function AudioCapture(): React.JSX.Element {
  useEffect(() => {
    // Tell main the page is alive but idle, so the status channel is exercised
    // end to end from the very first build.
    window.murmur?.audio.reportStatus({ status: 'idle' })
  }, [])

  return (
    <main className="flex h-full flex-col justify-center gap-2 p-6">
      <h1 className="text-sm font-semibold text-ink">Audio capture</h1>
      <p className="text-[13px] leading-relaxed text-ink-muted">
        Hidden renderer that will own the microphone:{' '}
        <code className="font-mono">getUserMedia</code> plus an{' '}
        <code className="font-mono">AudioWorklet</code> downsampling to 16 kHz mono Float32,
        streamed to the main process as ~100 ms frames.
      </p>
      <p className="text-[12px] text-ink-faint">
        Not capturing yet — the main process drives this page over{' '}
        <code className="font-mono">audio.command</code>.
      </p>
    </main>
  )
}
