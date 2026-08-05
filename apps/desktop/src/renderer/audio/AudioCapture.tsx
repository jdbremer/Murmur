import { useEffect } from 'react'

/**
 * The hidden capture page (PLAN §3.1, §5).
 *
 * This window is never shown; it exists because `getUserMedia` lives in a
 * renderer. Stage 2 fills it in: open the mic lazily and keep it warm, run an
 * `AudioWorklet` that downsamples to 16 kHz mono Float32, maintain the ~300 ms
 * pre-roll ring buffer, and ship ~100 ms frames to main over `audio.frame`
 * while reporting amplitude for the Bar's waveform.
 *
 * Stage 1 deliberately does **not** call `getUserMedia` — asking for the
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
        Not capturing yet — no microphone is opened in this build.
      </p>
    </main>
  )
}
