import { useEffect, useState } from 'react'

import { MicrophoneCapture } from './capture'
import type { CaptureError } from './errors'

/**
 * The hidden capture page (PLAN §3.1, §5).
 *
 * This window is never shown; it exists because `getUserMedia` lives in a
 * renderer. It owns no policy of its own — main decides when the microphone
 * opens and closes, over `audio.command` — so everything here is wiring:
 *
 *  1. subscribe to `audio.command` (`warm` / `start` / `stop` / `release`) and
 *     hand it to {@link MicrophoneCapture};
 *  2. forward ~100 ms frames of 16 kHz mono Float32 PCM on `audio.frame`, and
 *     the ~30 Hz level meter on `audio.meter`;
 *  3. report lifecycle on `audio.status` — an `error` there becomes the Bar's
 *     `mic-unavailable` state, so the message is written for the user;
 *  4. keep the microphone list current on `audio.devices`, which is what the
 *     Bar's and Settings' mic pickers render.
 *
 * It deliberately does **not** call `getUserMedia` on load: asking for the
 * microphone before the user has been told why would be the wrong first
 * impression, and the permission flow belongs to onboarding.
 *
 * The visible markup below is a developer convenience — unhide the window and
 * it says what the microphone is doing.
 */
export function AudioCapture(): React.JSX.Element {
  const [state, setState] = useState<'idle' | 'live' | 'error'>('idle')
  const [detail, setDetail] = useState<string>('Waiting for a command from the main process.')

  useEffect(() => {
    const bridge = window.murmur
    if (!bridge) return

    const capture = new MicrophoneCapture({
      workletUrl: new URL('./pcm-worklet.js', import.meta.url).href,
      callbacks: {
        onFrame: (frame) => bridge.audio.sendFrame({ ...frame, sampleRate: 16_000 }),
        onLevel: (level) => bridge.audio.reportLevel(level),
        onDevices: (devices) => bridge.audio.reportDevices({ devices }),
        onReady: ({ deviceId, sampleRate }) => {
          bridge.audio.reportStatus({ status: 'ready', deviceId, sampleRate })
          setState('live')
          setDetail(`${deviceId ?? 'system default input'} · ${sampleRate} Hz`)
        },
        onIdle: () => {
          bridge.audio.reportStatus({ status: 'idle' })
          setState('idle')
          setDetail('Microphone released.')
        },
        onError: (error: CaptureError) => {
          bridge.audio.reportStatus({ status: 'error', message: error.message })
          setState('error')
          setDetail(`${error.code}: ${error.message}`)
        },
      },
    })
    const unsubscribe = bridge.audio.onCommand((command) => {
      void capture.apply(command)
    })

    // Device hot-plug: AirPods connecting, a dock being attached. The list is
    // pushed to main, which serves it to every picker.
    const onDeviceChange = (): void => void capture.refreshDevices()
    navigator.mediaDevices?.addEventListener?.('devicechange', onDeviceChange)
    void capture.refreshDevices()

    bridge.audio.reportStatus({ status: 'idle' })

    return () => {
      unsubscribe()
      navigator.mediaDevices?.removeEventListener?.('devicechange', onDeviceChange)
      capture.dispose()
    }
  }, [])

  return (
    <main className="flex h-full flex-col justify-center gap-2 p-6">
      <h1 className="text-sm font-semibold text-ink">Audio capture</h1>
      <p className="text-[13px] leading-relaxed text-ink-muted">
        Hidden renderer that owns the microphone: <code className="font-mono">getUserMedia</code>{' '}
        plus an <code className="font-mono">AudioWorklet</code>, resampled to 16 kHz mono Float32
        and streamed to the main process as ~100 ms frames.
      </p>
      <p
        className={[
          'text-[12px]',
          state === 'error'
            ? 'text-warning'
            : state === 'live'
              ? 'text-positive'
              : 'text-ink-faint',
        ].join(' ')}
      >
        {state} — {detail}
      </p>
    </main>
  )
}
