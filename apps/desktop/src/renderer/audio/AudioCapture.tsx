import { useEffect, useRef, useState } from 'react'

import type { AudioCaptureStatus, DictationState } from '@murmur/shared'

import { MicrophoneCapture } from './capture'
import { CuePlayer } from './cue-player'
import { decideCue, restingStateOf } from './cues'

/**
 * The hidden capture page (PLAN §3.1, §5).
 *
 * This window is never shown; it exists because `getUserMedia` lives in a
 * renderer. All of the interesting logic is in {@link MicrophoneCapture} — the
 * component is the IPC seam and nothing else:
 *
 *  - `audio.command` in  → {@link MicrophoneCapture.apply};
 *  - PCM frames out      → `audio.frame`;
 *  - lifecycle out       → `audio.status`, which the orchestrator turns into a
 *                          `mic-unavailable` dictation error when it is `error`.
 *
 * It deliberately does **not** open the microphone on load. Main sends `warm`
 * once settings are known (PLAN §5), so the mic opens because the app decided
 * to, not because a page happened to render.
 *
 * The visible markup only ever shows up in devtools, so it is a status readout
 * rather than a design: when capture misbehaves, the first question is always
 * "did the worklet actually start, and at what rate".
 */
export function AudioCapture(): React.JSX.Element {
  const [status, setStatus] = useState<AudioCaptureStatus>({ status: 'idle' })
  const [frames, setFrames] = useState(0)
  const frameCount = useRef(0)

  useEffect(() => {
    const capture = new MicrophoneCapture({
      onFrame: (pcm, sampleCount) => {
        window.murmur.audio.sendFrame({ pcm, sampleCount, sampleRate: 16_000, ts: Date.now() })
        frameCount.current += 1
        // Throttled to ~1 Hz: this is a debug readout, not a meter, and
        // re-rendering on every 100 ms frame would be pure waste.
        if (frameCount.current % 10 === 0) setFrames(frameCount.current)
      },
      onStatus: (next) => {
        setStatus(next)
        window.murmur.audio.reportStatus(next)
        // A grant (or a device change under the hood) is exactly when labels
        // appear, so the list is refreshed on every lifecycle edge.
        void capture.refreshDevices()
      },
      onMeter: (level, peak) => {
        window.murmur.audio.reportLevel({ level, peak })
      },
      onDevices: (devices) => {
        window.murmur.audio.reportDevices({ devices })
      },
    })

    const unsubscribe = window.murmur.audio.onCommand((command) => {
      void capture.apply(command)
    })

    // The list is enumerated up front (labels may be empty until the first
    // grant) and re-pushed to main whenever the hardware changes.
    const onDeviceChange = (): void => void capture.refreshDevices()
    navigator.mediaDevices?.addEventListener?.('devicechange', onDeviceChange)
    void capture.refreshDevices()

    // Tell main the page is alive but idle, so the status channel is exercised
    // end to end from the very first build.
    window.murmur.audio.reportStatus({ status: 'idle' })

    return () => {
      unsubscribe()
      navigator.mediaDevices?.removeEventListener?.('devicechange', onDeviceChange)
      capture.dispose()
    }
  }, [])

  // The start/stop cue (PLAN §2.1). Kept in its own effect because it shares
  // nothing with capture but the window it runs in — see `cue-player.ts` for
  // why that window is this one.
  useEffect(() => {
    const player = new CuePlayer()
    void player.warm()

    let enabled = true
    let previous: DictationState = 'idle'
    let seeded = false

    void window.murmur.settings
      .get()
      .then((settings) => {
        enabled = settings.soundCuesEnabled
      })
      .catch(() => {})
    const unsubscribeSettings = window.murmur.settings.subscribe((settings) => {
      enabled = settings.soundCuesEnabled
    })

    // Adopt the live state, so reloading this page mid-utterance does not make
    // the next transition look like the first one. A broadcast that beats the
    // reply is the fresher answer, hence the guard rather than a plain assign.
    void window.murmur.dictation
      .getState()
      .then((event) => {
        if (!seeded) previous = restingStateOf(event)
      })
      .catch(() => {})

    const unsubscribeState = window.murmur.dictation.subscribe((event) => {
      seeded = true
      const cue = decideCue(previous, event)
      previous = restingStateOf(event)
      // Checked at the edge rather than in the player: a cue suppressed by the
      // setting still has to move the state forward, or the next transition
      // would be measured from a stale one.
      if (cue !== null && enabled) void player.play(cue)
    })

    return () => {
      unsubscribeSettings()
      unsubscribeState()
      player.dispose()
    }
  }, [])

  return (
    <main className="flex h-full flex-col justify-center gap-2 p-6">
      <h1 className="text-sm font-semibold text-ink">Audio capture</h1>
      <p className="text-[13px] leading-relaxed text-ink-muted">
        Hidden renderer that owns the microphone: <code className="font-mono">getUserMedia</code>{' '}
        plus an <code className="font-mono">AudioWorklet</code> downsampling to 16 kHz mono Float32,
        streamed to the main process as 100 ms frames.
      </p>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12px] text-ink-faint">
        <dt>State</dt>
        <dd className="font-mono text-ink-muted">{status.status}</dd>
        {status.status === 'ready' ? (
          <>
            <dt>Rate</dt>
            <dd className="font-mono text-ink-muted">{status.sampleRate} Hz</dd>
            <dt>Device</dt>
            <dd className="truncate font-mono text-ink-muted">{status.deviceId ?? 'default'}</dd>
          </>
        ) : null}
        {status.status === 'error' ? (
          <>
            <dt>Error</dt>
            <dd className="text-warning">{status.message}</dd>
          </>
        ) : null}
        <dt>Frames</dt>
        <dd className="font-mono tabular-nums text-ink-muted">{frames}</dd>
      </dl>
    </main>
  )
}
