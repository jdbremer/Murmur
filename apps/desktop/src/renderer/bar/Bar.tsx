import { useEffect, useState } from 'react'

import type { DictationEvent } from '@murmur/shared'

/**
 * The floating dictation pill (PLAN §2.1) — **placeholder visuals**.
 *
 * What is real here: the window shape, the transparent click-through page, the
 * subscription to `dictation.state` and `audio.level`, and the state → visual
 * mapping. What is deliberately rough: the drawing itself. The 24–32 bar canvas
 * waveform at 60 fps, the ~150 ms spring between widths, the shimmer sweep and
 * the ✓ pulse are Stage 3's job; this renders a legible stand-in for each state
 * so the plumbing can be reviewed now.
 */
export function Bar(): React.JSX.Element {
  const [event, setEvent] = useState<DictationEvent>({ state: 'idle' })
  const [level, setLevel] = useState(0)

  useEffect(() => {
    void window.murmur.dictation
      .getState()
      .then(setEvent)
      .catch(() => undefined)

    const unsubscribeState = window.murmur.dictation.subscribe(setEvent)
    const unsubscribeLevel = window.murmur.dictation.onLevel(({ level: next }) => setLevel(next))

    // Esc cancels while listening (PLAN §2.1 "Interaction").
    const onKeyDown = (keyEvent: KeyboardEvent): void => {
      if (keyEvent.key === 'Escape') void window.murmur.dictation.cancel()
    }
    window.addEventListener('keydown', onKeyDown)

    return () => {
      unsubscribeState()
      unsubscribeLevel()
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [])

  const visual = describe(event)

  return (
    <div className="flex h-full w-full items-end justify-center pb-1">
      <div
        className="bar-pill flex items-center justify-center gap-2 rounded-full px-3.5 text-[11px] font-medium text-white/90 transition-[width,background-color] duration-150 ease-out"
        style={{
          width: visual.width,
          height: 22,
          background: visual.background,
          border: '1px solid rgba(255,255,255,0.08)',
          backdropFilter: 'blur(12px)',
          boxShadow: '0 6px 18px rgba(0,0,0,0.35)',
        }}
        onDoubleClick={() => void window.murmur.app.openHub()}
        title={visual.title}
      >
        {visual.kind === 'dots' ? <Dots level={level} active={visual.animated} /> : null}
        {visual.kind === 'text' ? <span className="truncate">{visual.label}</span> : null}
      </div>
    </div>
  )
}

/** Stand-in for the real waveform: eight ticks driven by the live level. */
function Dots({ level, active }: { level: number; active: boolean }): React.JSX.Element {
  const ticks = Array.from({ length: 8 }, (_, index) => {
    if (!active) return 2
    // A cheap fake envelope so the placeholder is not a flat line.
    const weight = 0.4 + 0.6 * Math.sin(((index + 1) / 9) * Math.PI)
    return Math.max(2, Math.round(2 + level * weight * 12))
  })

  return (
    <div className="flex items-center gap-[2px]">
      {ticks.map((height, index) => (
        <span
          key={index}
          className="w-[2px] rounded-full bg-white/80 transition-[height] duration-75"
          style={{ height }}
        />
      ))}
    </div>
  )
}

interface Visual {
  kind: 'dots' | 'text'
  width: number
  background: string
  animated: boolean
  label: string
  title: string
}

const IDLE_BACKGROUND = 'rgba(20,20,24,0.92)'

function describe(event: DictationEvent): Visual {
  switch (event.state) {
    case 'idle':
      return {
        kind: 'dots',
        width: 64,
        background: IDLE_BACKGROUND,
        animated: false,
        label: '',
        title: 'Murmur — hold your dictation key to speak',
      }
    case 'listening':
      return {
        kind: 'dots',
        width: 160,
        background: IDLE_BACKGROUND,
        animated: true,
        label: '',
        title: event.handsFree ? 'Listening (hands-free)' : 'Listening',
      }
    case 'processing':
      return {
        kind: 'text',
        width: 132,
        background: IDLE_BACKGROUND,
        animated: false,
        label: event.stage === 'polishing' ? 'Polishing…' : 'Transcribing…',
        title: 'Working',
      }
    case 'inserting':
      return {
        kind: 'text',
        width: 112,
        background: IDLE_BACKGROUND,
        animated: false,
        label: 'Inserting…',
        title: 'Inserting',
      }
    case 'inserted':
      return {
        kind: 'text',
        width: 96,
        background: IDLE_BACKGROUND,
        animated: false,
        label: `✓ ${event.charCount}`,
        title: `Inserted ${event.charCount} characters via ${event.method}`,
      }
    case 'error':
      return {
        kind: 'text',
        width: 240,
        background: 'rgba(76,26,26,0.94)',
        animated: false,
        label: event.message,
        title: `${event.code}: ${event.message}`,
      }
  }
}
