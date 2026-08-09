import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type {
  AudioDevice,
  BarCorner,
  BarStyle,
  BarVisibility,
  DictationEvent,
} from '@murmur/shared'

import { useReducedMotion } from '../hooks/useReducedMotion'
import { BarCanvas, CheckPulse } from './BarCanvas'
import { barHeights } from './level'
import { Nub } from './Nub'
import { Controls, MicMenu, StatusDot } from './parts'
import {
  BAR,
  BAR_FLOURISH_BORDER,
  BAR_FLOURISH_GLOW,
  BAR_SHADOW,
  BarPresenter,
  describeBar,
  describeNub,
  flourishFor,
  isBarVisible,
  NUB,
  type BarVisual,
  type Flourish,
} from './visual'

/**
 * How long the exit animation gets before the indicator unmounts. Must stay
 * inside the ~250 ms grace main leaves between a momentary hold expiring and
 * the window being hidden (see applyBarVisibility in main/index.ts).
 */
const EXIT_MS = 170

/** How long a start / stop ring lives before it is taken out of the DOM. */
const FLOURISH_MS = 620

/**
 * The floating dictation indicator (PLAN §2.1).
 *
 * A faithful recreation of the reference product's bar, built from our own code
 * and artwork: a near-black capsule that morphs — never jumps — between five
 * states, with a canvas waveform fed by the microphone at 30 Hz and
 * interpolated to 60. Since the corner style landed there are two drawings of
 * that one machine — the bottom-centre pill and a quarter-disc orb peeking out
 * of a bottom corner — and everything above the drawing is shared: this
 * component owns the state, the settings, the hover hit-testing and the
 * flourish, and hands the result to whichever shape the user chose.
 *
 * Three properties of this window shape the code more than anything else:
 *
 *  1. **It never takes focus.** The window is `focusable: false`, so this
 *     renderer receives no key events. Esc-to-cancel is registered in main for
 *     exactly as long as the machine is listening; the listener below is only a
 *     fallback for the case where the Bar somehow does have focus.
 *  2. **It is click-through.** Main sets `setIgnoreMouseEvents(true, forward)`,
 *     mouse *moves* still arrive, and this component hit-tests them against the
 *     capsule to decide when the window should accept clicks. Get that wrong
 *     and a strip of the user's screen stops working.
 *  3. **Momentary states are held here.** Main emits `inserted` and `error` and
 *     immediately settles to `idle`; {@link BarPresenter} keeps them on screen
 *     for the durations PLAN §2.1 gives them.
 */
export function Bar(): React.JSX.Element | null {
  const presenter = useRef(new BarPresenter())
  const [event, setEvent] = useState<DictationEvent>({ state: 'idle' })
  /** When the held `inserted` / `error` visual expires, if one is showing. */
  const [deadline, setDeadline] = useState<number | null>(null)
  const [visibility, setVisibility] = useState<BarVisibility>('showWhileDictating')
  const visibilityRef = useRef<BarVisibility>('showWhileDictating')
  const [style, setStyle] = useState<BarStyle>('pill')
  const [corner, setCorner] = useState<BarCorner>('bottomLeft')
  const [flourishEnabled, setFlourishEnabled] = useState(true)
  const [hovered, setHovered] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [devices, setDevices] = useState<AudioDevice[]>([])
  /** A meeting is recording — shown alongside whatever dictation is doing. */
  const [recording, setRecording] = useState(false)
  const [micDeviceId, setMicDeviceId] = useState<string | null>(null)
  const levelRef = useRef(0)
  const reducedMotion = useReducedMotion()

  // -- state, held through the momentary events ----------------------------

  /** Publish whatever the presenter says is on screen at `now`. */
  const settle = useCallback((now: number) => {
    const next = presenter.current.present(now)
    setEvent(next)
    setDeadline(presenter.current.expiresAt())
    // An indicator that is about to disappear must not take an open menu with it.
    if (!isBarVisible(visibilityRef.current, next)) setMenuOpen(false)
  }, [])

  // Meeting state rides its own channel: it is long-lived and can be true at
  // the same time as any dictation state, so it cannot share the presenter.
  useEffect(() => {
    const apply = (event: { state: string }): void => {
      setRecording(event.state === 'recording' || event.state === 'finishing')
    }
    void window.murmur.meetings.getState().then(apply).catch(noop)
    return window.murmur.meetings.subscribe(apply)
  }, [])

  useEffect(() => {
    const receive = (next: DictationEvent): void => {
      presenter.current.receive(next, Date.now())
      if (next.state === 'listening') levelRef.current = next.level
      if (next.state === 'idle') levelRef.current = 0
      settle(Date.now())
    }

    void window.murmur.dictation.getState().then(receive).catch(noop)
    const unsubscribeState = window.murmur.dictation.subscribe(receive)
    const unsubscribeLevel = window.murmur.dictation.onLevel(({ level }) => {
      levelRef.current = level
    })

    return () => {
      unsubscribeState()
      unsubscribeLevel()
    }
  }, [settle])

  // The held ✓ / error visual expiring is the one state change that no event
  // drives, so it gets a timer of its own.
  useEffect(() => {
    if (deadline === null) return
    const timer = setTimeout(() => settle(Date.now()), Math.max(16, deadline - Date.now()))
    return () => clearTimeout(timer)
  }, [deadline, settle])

  // -- settings + devices ---------------------------------------------------
  useEffect(() => {
    const apply = (settings: {
      barVisibility: BarVisibility
      barStyle: BarStyle
      barCorner: BarCorner
      barFlourish: boolean
      micDeviceId: string | null
    }): void => {
      visibilityRef.current = settings.barVisibility
      setVisibility(settings.barVisibility)
      setStyle(settings.barStyle)
      setCorner(settings.barCorner)
      setFlourishEnabled(settings.barFlourish)
      setMicDeviceId(settings.micDeviceId)
    }
    void window.murmur.settings.get().then(apply).catch(noop)
    const unsubscribeSettings = window.murmur.settings.subscribe(apply)

    void window.murmur.audio
      .listDevices()
      .then(({ devices: list }) => setDevices(list))
      .catch(noop)
    const unsubscribeDevices = window.murmur.audio.onDevicesChanged(({ devices: list }) =>
      setDevices(list),
    )

    return () => {
      unsubscribeSettings()
      unsubscribeDevices()
    }
  }, [])

  // -- Esc, for the rare case this window has focus --------------------------
  useEffect(() => {
    const onKeyDown = (keyEvent: KeyboardEvent): void => {
      if (keyEvent.key !== 'Escape') return
      if (menuOpen) {
        setMenuOpen(false)
        return
      }
      void window.murmur.dictation.cancel().catch(noop)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [menuOpen])

  const visible = isBarVisible(visibility, event, recording)

  // -- the start / stop flourish --------------------------------------------
  // Keyed rather than toggled: two utterances in quick succession must each get
  // their own ring, and only remounting the element restarts a CSS animation.
  const previousState = useRef<DictationEvent['state']>('idle')
  const [flourish, setFlourish] = useState<{ kind: Flourish; key: number } | null>(null)
  useEffect(() => {
    const kind = flourishFor(previousState.current, event.state)
    previousState.current = event.state
    // Reduce Motion suppresses it outright: a ring that travels and scales is
    // precisely what that preference is asking not to see (PLAN §15.5).
    if (!kind || !flourishEnabled || reducedMotion) return
    setFlourish((current) => ({ kind, key: (current?.key ?? 0) + 1 }))
  }, [event.state, flourishEnabled, reducedMotion])
  useEffect(() => {
    if (!flourish) return
    const timer = setTimeout(() => setFlourish(null), FLOURISH_MS)
    return () => clearTimeout(timer)
  }, [flourish])

  // -- entrance / exit -------------------------------------------------------
  // `visible` flips instantly; `present` lingers for EXIT_MS so the shape can
  // sink away instead of vanishing. Main keeps the window up long enough.
  const [present, setPresent] = useState(visible)
  // Becoming visible again is adopted during render, not in an effect, so a new
  // utterance interrupting the exit never paints a dead frame.
  if (visible && !present) setPresent(true)
  useEffect(() => {
    if (visible) return
    const timer = setTimeout(() => setPresent(false), reducedMotion ? 120 : EXIT_MS)
    return () => clearTimeout(timer)
  }, [visible, reducedMotion])

  // -- click-through hit-testing --------------------------------------------
  const pillRef = useRef<HTMLDivElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const interactiveRef = useRef(false)

  const setInteractive = useCallback((next: boolean) => {
    if (interactiveRef.current === next) return
    interactiveRef.current = next
    window.murmur.bar.setPointerRegion({ interactive: next })
  }, [])

  useEffect(() => {
    const onMove = (moveEvent: MouseEvent): void => {
      const { clientX, clientY } = moveEvent
      const onShape =
        style === 'corner'
          ? hitsOrb(pillRef.current, corner, clientX, clientY)
          : hits(pillRef.current, clientX, clientY)
      const inside = visible && (onShape || hits(panelRef.current, clientX, clientY))
      setHovered(inside)
      // Moving off the indicator+menu closes the menu — there is no other way
      // out: this window is focusable:false, so it never gets a blur or an
      // outside click, and holding the whole window interactive while a menu
      // sits open would swallow clicks meant for the app underneath.
      if (menuOpen && !inside) setMenuOpen(false)
      setInteractive(inside)
    }

    const onLeave = (): void => {
      setHovered(false)
      setMenuOpen(false)
      setInteractive(false)
    }

    window.addEventListener('mousemove', onMove)
    document.addEventListener('mouseleave', onLeave)
    return () => {
      window.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseleave', onLeave)
    }
  }, [corner, menuOpen, setInteractive, style, visible])

  // An indicator that goes away must not leave the window swallowing clicks.
  useEffect(() => {
    if (!visible) setInteractive(false)
  }, [setInteractive, visible])

  const showControls = hovered || menuOpen
  const pillVisual = useMemo(
    () => describeBar(event, showControls, recording),
    [event, showControls, recording],
  )
  const nubVisual = useMemo(
    () => describeNub(event, showControls, recording),
    [event, showControls, recording],
  )

  if (!visible && !present) return null

  const onCancel = (): void => {
    setMenuOpen(false)
    void window.murmur.dictation.cancel().catch(noop)
  }
  const onHub = (): void => {
    setMenuOpen(false)
    void window.murmur.app.openHub().catch(noop)
  }
  const onSelectDevice = (deviceId: string | null): void => {
    setMenuOpen(false)
    void window.murmur.settings.set({ micDeviceId: deviceId }).catch(noop)
  }

  if (style === 'corner') {
    return (
      <div
        className="nub-stage relative h-full w-full"
        data-corner={corner}
        data-leaving={visible ? undefined : 'true'}
      >
        {/* The page is taller than the screen: the window deliberately hangs
            below it so macOS's window-corner rounding falls off the panel (see
            NUB.overhang). This box trims that overhang away, so everything
            inside can be positioned against the *screen's* bottom edge —
            including the entrance animation, which has to grow out of the
            screen's corner and not out of a point below it. */}
        <div className="nub-anchor absolute inset-x-0 top-0" style={{ bottom: NUB.overhang }}>
          <Nub
            visual={nubVisual}
            corner={corner}
            levelRef={levelRef}
            reducedMotion={reducedMotion}
            showControls={showControls}
            menuOpen={menuOpen}
            devices={devices}
            micDeviceId={micDeviceId}
            orbRef={pillRef}
            panelRef={panelRef}
            flourish={flourish}
            onCancel={onCancel}
            onMic={() => setMenuOpen((open) => !open)}
            onHub={onHub}
            onSelectDevice={onSelectDevice}
          />
        </div>
      </div>
    )
  }

  return (
    <div
      className="bar-stage flex h-full w-full flex-col items-center justify-end"
      data-leaving={visible ? undefined : 'true'}
    >
      {menuOpen ? (
        <MicMenu
          className="mb-2"
          panelRef={panelRef}
          devices={devices}
          selected={micDeviceId}
          onSelect={onSelectDevice}
        />
      ) : null}

      <div className="relative">
        {/* The start / stop ring. A sibling of the capsule rather than a child:
            the capsule clips its own overflow, and the whole point of the ring
            is that it leaves. */}
        {flourish ? (
          <span
            key={flourish.key}
            aria-hidden="true"
            className="bar-flourish pointer-events-none absolute inset-0 rounded-full"
            data-kind={flourish.kind}
            style={{
              border: `1.5px solid ${BAR_FLOURISH_BORDER}`,
              boxShadow: BAR_FLOURISH_GLOW,
            }}
          />
        ) : null}

        <div
          ref={pillRef}
          data-testid="bar-pill"
          data-state={event.state}
          data-shape={pillVisual.shape}
          role="status"
          aria-live={pillVisual.announce ? 'polite' : 'off'}
          aria-label={pillVisual.ariaLabel}
          className="bar-pill relative flex items-center justify-center overflow-hidden rounded-full"
          style={{
            width: pillVisual.width,
            height: pillVisual.height,
            background: pillVisual.background,
            border: `1px solid ${pillVisual.border}`,
            boxShadow: pillVisual.glow ? `${BAR_SHADOW}, ${pillVisual.glow}` : BAR_SHADOW,
            backdropFilter: 'blur(14px)',
            color: 'rgba(255,255,255,0.94)',
            transition: reducedMotion
              ? 'opacity 120ms linear, background-color 120ms linear'
              : [
                  `width ${BAR.morphMs}ms cubic-bezier(0.3,1.33,0.4,1)`,
                  `height ${BAR.morphMs}ms cubic-bezier(0.3,1.33,0.4,1)`,
                  `background-color ${BAR.morphMs}ms ease-out`,
                  `border-color ${BAR.morphMs}ms ease-out`,
                  // The glow blooms and fades slower than the morph, so a state
                  // change reads as a wash of colour rather than a switch.
                  `box-shadow ${BAR.morphMs * 2}ms ease-out`,
                  `opacity ${BAR.morphMs}ms ease-out`,
                ].join(', '),
          }}
        >
          {/* Glass: a top-lit sheen over the capsule, under everything else. */}
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 rounded-full"
            style={{
              background:
                'linear-gradient(to bottom, rgba(255,255,255,0.085), rgba(255,255,255,0.015) 55%, rgba(0,0,0,0.06))',
            }}
          />
          {/* The interior slides left to make room for the hover controls rather
              than being overlapped by them. min-w-0 keeps a long error message
              truncating inside the capsule instead of overflowing it.
              Half the controls' footprint is exactly the shift that re-centres
              the interior in what is left of the capsule. */}
          <div
            className="relative flex min-w-0 max-w-full items-center justify-center"
            style={{
              transform: showControls ? `translateX(-${BAR.controlsWidth / 2}px)` : 'none',
              transition: reducedMotion ? 'none' : `transform ${BAR.morphMs}ms ease-out`,
            }}
          >
            <BarInterior visual={pillVisual} levelRef={levelRef} reducedMotion={reducedMotion} />
          </div>
          {pillVisual.recording ? (
            <StatusDot kind="recording" className="right-[7px] top-1/2 -translate-y-1/2" />
          ) : null}
          {pillVisual.handsFree ? (
            <StatusDot kind="handsFree" className="left-[7px] top-1/2 -translate-y-1/2" />
          ) : null}
          {pillVisual.command ? (
            <StatusDot kind="command" className="left-[7px] top-1/2 -translate-y-1/2" />
          ) : null}
          {showControls ? (
            <Controls
              className="absolute right-[6px] top-1/2 -translate-y-1/2"
              menuOpen={menuOpen}
              onCancel={onCancel}
              onMic={() => setMenuOpen((open) => !open)}
              onHub={onHub}
            />
          ) : null}
        </div>
      </div>
    </div>
  )
}

/** What is drawn inside the capsule for the current state. */
function BarInterior({
  visual,
  levelRef,
  reducedMotion,
}: {
  visual: BarVisual
  levelRef: React.RefObject<number>
  reducedMotion: boolean
}): React.JSX.Element {
  if (visual.shape === 'message') {
    return (
      <span className="flex min-w-0 items-center gap-1.5 px-3">
        <svg
          viewBox="0 0 24 24"
          aria-hidden="true"
          className="size-[11px] shrink-0"
          fill="none"
          stroke="rgba(255,178,160,0.95)"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M12 8v5M12 16.5h.01" />
          <circle cx="12" cy="12" r="9" />
        </svg>
        <span className="truncate text-[11px] font-medium leading-none">{visual.label}</span>
      </span>
    )
  }
  if (visual.shape === 'check') {
    return <CheckPulse reducedMotion={reducedMotion} />
  }
  if (reducedMotion) {
    return <StaticLevel shape={visual.shape} levelRef={levelRef} />
  }
  return (
    <BarCanvas
      shape={visual.shape}
      levelRef={levelRef}
      epoch={visual.shape === 'waveform' ? 1 : 0}
    />
  )
}

/**
 * Reduce Motion: static level dots instead of dancing bars (PLAN §15.5).
 *
 * They still show *something* — a dictation tool that gives no sign it can hear
 * you is worse than one that animates — but they repaint a few times a second,
 * not sixty, and nothing scrolls.
 */
function StaticLevel({
  shape,
  levelRef,
}: {
  shape: 'dots' | 'waveform' | 'shimmer'
  levelRef: React.RefObject<number>
}): React.JSX.Element {
  const [level, setLevel] = useState(0)

  useEffect(() => {
    if (shape !== 'waveform') return
    const timer = setInterval(() => setLevel(levelRef.current ?? 0), 200)
    return () => clearInterval(timer)
  }, [shape, levelRef])

  const count = shape === 'waveform' ? 7 : 5
  const heights = barHeights(
    Array.from({ length: count }, () => (shape === 'waveform' ? level : 0)),
  )

  return (
    <div className="flex items-center gap-[3px]" aria-hidden="true">
      {heights.map((height, index) => (
        <span
          key={index}
          className="w-[2px] rounded-full bg-white"
          style={{
            height: shape === 'shimmer' ? 2 : height,
            opacity: shape === 'dots' ? 0.34 : 0.9,
          }}
        />
      ))}
    </div>
  )
}

function hits(element: HTMLElement | null, x: number, y: number): boolean {
  if (!element) return false
  const rect = element.getBoundingClientRect()
  // A few pixels of slack so the pointer cannot fall through the seam between
  // the indicator and the menu sitting above it.
  const slack = 4
  return (
    x >= rect.left - slack &&
    x <= rect.right + slack &&
    y >= rect.top - slack &&
    y <= rect.bottom + slack
  )
}

/**
 * The corner orb is a quarter-disc, so its bounding box over-claims by a fifth
 * — and every pixel over-claimed is a pixel of the user's screen that stops
 * accepting clicks while the orb is out. Measure the radius instead.
 */
function hitsOrb(element: HTMLElement | null, corner: BarCorner, x: number, y: number): boolean {
  if (!element) return false
  const rect = element.getBoundingClientRect()
  const originX = corner === 'bottomLeft' ? rect.left : rect.right
  const slack = 4
  return Math.hypot(x - originX, y - rect.bottom) <= Math.max(rect.width, rect.height) + slack
}

function noop(): void {
  /* a fire-and-forget IPC failure is not actionable inside the Bar */
}
