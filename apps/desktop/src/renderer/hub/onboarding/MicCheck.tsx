import { useEffect, useRef, useState } from 'react'

import { Button } from '../../components/Section'
import { normaliseLevel } from '../../audio/meter'
import { errorMessage } from '../../lib/errors'

/**
 * "Say something" — the live microphone test (PLAN §2.4).
 *
 * Granting a permission and *knowing it worked* are different things, and the
 * gap between them is where first-run confidence is lost. Until now the
 * microphone step ended with a green pill saying `granted`, which is a claim
 * about a system setting rather than evidence that Murmur can hear anything:
 * the wrong input device, a hardware mute switch and a permission granted to
 * the wrong copy of the app all look identical from there.
 *
 * Watching a bar move while you talk settles it in two seconds.
 *
 * The stream is opened here in the Hub rather than through the hidden capture
 * renderer on purpose. It is the shortest path to the same answer, it releases
 * the device the moment the test ends, and on macOS it triggers the very
 * permission prompt this step is asking for — so a user who skipped the Allow
 * button still gets asked, by the control that is about to prove it worked.
 */

/** Long enough to say a sentence, short enough that nobody has to press stop. */
const TEST_DURATION_MS = 8_000
/** The level that counts as "we heard that" rather than room noise. */
const HEARD_THRESHOLD = 0.18
/** How many bars the meter is drawn as. */
const SEGMENTS = 24

type State = 'idle' | 'listening' | 'heard' | 'failed'

export function MicCheck(): React.JSX.Element {
  const [state, setState] = useState<State>('idle')
  const [error, setError] = useState<string | null>(null)
  const meterRef = useRef<HTMLDivElement | null>(null)

  /** Everything the running test owns, so one call can tear all of it down. */
  const session = useRef<{
    stream: MediaStream
    context: AudioContext
    frame: number
    timer: number
  } | null>(null)

  const stop = (): void => {
    const current = session.current
    if (!current) return
    session.current = null
    cancelAnimationFrame(current.frame)
    window.clearTimeout(current.timer)
    // Release the device rather than leaving it warm: an onboarding screen
    // holding the microphone open is exactly the behaviour this app promises
    // not to have.
    for (const track of current.stream.getTracks()) track.stop()
    void current.context.close().catch(() => undefined)
  }

  // A user who clicks Back mid-test must not leave the mic running.
  useEffect(() => stop, [])

  const start = async (): Promise<void> => {
    stop()
    setError(null)
    setState('listening')

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const context = new AudioContext()
      const source = context.createMediaStreamSource(stream)
      const analyser = context.createAnalyser()
      analyser.fftSize = 1024
      source.connect(analyser)

      const samples = new Float32Array(analyser.fftSize)
      let peak = 0

      const tick = (): void => {
        const current = session.current
        if (!current) return
        current.frame = requestAnimationFrame(tick)

        analyser.getFloatTimeDomainData(samples)
        let sum = 0
        for (const sample of samples) sum += sample * sample
        // The same dB curve the pill uses, so what the user sees here is what
        // the pill will show them a minute later.
        const level = normaliseLevel(Math.sqrt(sum / samples.length))

        peak = Math.max(peak, level)
        paint(meterRef.current, level)
        if (peak >= HEARD_THRESHOLD) setState('heard')
      }

      session.current = {
        stream,
        context,
        frame: requestAnimationFrame(tick),
        timer: window.setTimeout(() => {
          stop()
          paint(meterRef.current, 0)
          // Only demote to a failure if nothing was ever heard — a successful
          // test that has since timed out should keep saying it worked.
          setState((value) => (value === 'heard' ? 'heard' : 'failed'))
        }, TEST_DURATION_MS),
      }
    } catch (cause) {
      setState('failed')
      setError(errorMessage(cause))
    }
  }

  return (
    <div className="mt-5 rounded-xl border border-line bg-surface-sunken p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[13px] font-medium text-ink">
            {state === 'heard'
              ? 'Murmur can hear you'
              : state === 'listening'
                ? 'Say something…'
                : 'Check that it can actually hear you'}
          </p>
          <p className="mt-0.5 text-[12px] leading-relaxed text-ink-muted">
            {state === 'heard'
              ? 'That is the same meter the pill uses while you dictate.'
              : state === 'failed'
                ? (error ?? 'Nothing came through. Check the input device in Settings.')
                : 'Nothing is recorded — the meter reads the level and the stream closes straight after.'}
          </p>
        </div>
        <Button onClick={() => void start()} disabled={state === 'listening'}>
          {state === 'listening'
            ? 'Listening…'
            : state === 'idle'
              ? 'Test microphone'
              : 'Try again'}
        </Button>
      </div>

      <div
        ref={meterRef}
        aria-hidden="true"
        className="mt-3.5 flex h-6 items-end gap-[3px]"
        data-state={state}
      >
        {Array.from({ length: SEGMENTS }, (_, index) => (
          <span
            key={index}
            className="mic-check-bar h-1.5 flex-1 rounded-full bg-line transition-[height,background-color] duration-75"
          />
        ))}
      </div>
    </div>
  )
}

/**
 * Drive the meter through the DOM rather than through React state.
 *
 * At 60 fps a `setState` per frame is 60 renders a second of a component that
 * also owns a media stream — and every one of them would recreate the callback
 * the animation loop is holding.
 */
function paint(element: HTMLDivElement | null, level: number): void {
  if (!element) return
  const bars = element.children
  const lit = Math.round(level * SEGMENTS)
  for (let index = 0; index < bars.length; index += 1) {
    const bar = bars[index] as HTMLElement
    const on = index < lit
    // Heights ramp along the row so the meter reads as a level, not a switch.
    bar.style.height = on ? `${6 + (index / SEGMENTS) * 18}px` : '6px'
    bar.style.backgroundColor = on
      ? index > SEGMENTS * 0.85
        ? 'var(--color-warning)'
        : 'var(--color-positive)'
      : ''
  }
}
