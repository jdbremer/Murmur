import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { AudioDevice, BarVisibility, DictationEvent } from '@murmur/shared'

import { useReducedMotion } from '../hooks/useReducedMotion'
import { BarCanvas, CheckPulse } from './BarCanvas'
import { barHeights } from './level'
import { BAR, BAR_SHADOW, BarPresenter, describeBar, isBarVisible, type BarVisual } from './visual'

/**
 * How long the exit animation gets before the pill unmounts. Must stay inside
 * the ~250 ms grace main leaves between a momentary hold expiring and the
 * window being hidden (see applyBarVisibility in main/index.ts).
 */
const EXIT_MS = 170

/**
 * The floating dictation pill (PLAN §2.1).
 *
 * A faithful recreation of the reference product's bar, built from our own code
 * and artwork: a near-black capsule that morphs — never jumps — between five
 * states, with a canvas waveform fed by the microphone at 30 Hz and
 * interpolated to 60.
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
 *     and a 360 px strip of the user's screen stops working.
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
    // A pill that is about to disappear must not take an open menu with it.
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
      micDeviceId: string | null
    }): void => {
      visibilityRef.current = settings.barVisibility
      setVisibility(settings.barVisibility)
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

  const visual = useMemo(
    () => describeBar(event, hovered || menuOpen, recording),
    [event, hovered, menuOpen, recording],
  )
  const visible = isBarVisible(visibility, event, recording)

  // -- entrance / exit -------------------------------------------------------
  // `visible` flips instantly; `present` lingers for EXIT_MS so the capsule can
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
      const inside =
        visible &&
        (hits(pillRef.current, moveEvent.clientX, moveEvent.clientY) ||
          hits(panelRef.current, moveEvent.clientX, moveEvent.clientY))
      setHovered(inside)
      // Moving off the pill+menu closes the menu — there is no other way out:
      // this window is focusable:false, so it never gets a blur or an outside
      // click, and holding the whole 360×200 window interactive while a menu
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
  }, [menuOpen, setInteractive, visible])

  // A pill that goes away must not leave the window swallowing clicks.
  useEffect(() => {
    if (!visible) setInteractive(false)
  }, [setInteractive, visible])

  if (!visible && !present) return null

  const showControls = hovered || menuOpen

  return (
    <div
      className="bar-stage flex h-full w-full flex-col items-center justify-end"
      data-leaving={visible ? undefined : 'true'}
    >
      {menuOpen ? (
        <MicMenu
          panelRef={panelRef}
          devices={devices}
          selected={micDeviceId}
          onSelect={(deviceId) => {
            setMenuOpen(false)
            void window.murmur.settings.set({ micDeviceId: deviceId }).catch(noop)
          }}
        />
      ) : null}

      <div
        ref={pillRef}
        data-testid="bar-pill"
        data-state={event.state}
        data-shape={visual.shape}
        role="status"
        aria-live={visual.announce ? 'polite' : 'off'}
        aria-label={visual.ariaLabel}
        className="bar-pill relative flex items-center justify-center overflow-hidden rounded-full"
        style={{
          width: visual.width,
          height: visual.height,
          background: visual.background,
          border: `1px solid ${visual.border}`,
          boxShadow: visual.glow ? `${BAR_SHADOW}, ${visual.glow}` : BAR_SHADOW,
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
          <BarInterior visual={visual} levelRef={levelRef} reducedMotion={reducedMotion} />
        </div>
        {visual.recording ? <RecordingDot /> : null}
        {visual.handsFree ? <HandsFreeDot /> : null}
        {visual.command ? <CommandDot /> : null}
        {showControls ? (
          <Controls
            menuOpen={menuOpen}
            onCancel={() => {
              setMenuOpen(false)
              void window.murmur.dictation.cancel().catch(noop)
            }}
            onMic={() => setMenuOpen((open) => !open)}
            onHub={() => {
              setMenuOpen(false)
              void window.murmur.app.openHub().catch(noop)
            }}
          />
        ) : null}
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

/** Command mode: this utterance edits the selection, not types over it. */
function CommandDot(): React.JSX.Element {
  return (
    <span
      title="Editing your selection — speak the instruction"
      className="bar-dot-pulse absolute left-[7px] top-1/2 size-[5px] -translate-y-1/2 rounded-full"
      style={{ background: '#7aa2ff', boxShadow: '0 0 6px rgba(122,162,255,0.85)' }}
    />
  )
}

/** The latched hands-free indicator (PLAN §2.1). */
/**
 * The meeting-recording indicator.
 *
 * On the right, opposite the hands-free dot, so both can show at once — you
 * can dictate hands-free in the middle of a call. Red and steady rather than
 * pulsing: this is the universal "recording" signal, and a blinking light is
 * easier to mistake for an animation than for a state.
 *
 * It is the only always-visible sign that other people are being recorded, so
 * `isBarVisible` forces the pill on screen whenever it is lit — including when
 * the user has set the Bar to Hidden.
 */
function RecordingDot(): React.JSX.Element {
  return (
    <span
      title="Recording this meeting"
      className="absolute right-[7px] top-1/2 size-[5px] -translate-y-1/2 rounded-full"
      style={{ background: '#f87171', boxShadow: '0 0 6px rgba(248,113,113,0.85)' }}
    />
  )
}

function HandsFreeDot(): React.JSX.Element {
  return (
    <span
      title="Hands-free — tap your key again or press Esc to stop"
      className="bar-dot-pulse absolute left-[7px] top-1/2 size-[5px] -translate-y-1/2 rounded-full"
      style={{ background: '#6ee7a8', boxShadow: '0 0 6px rgba(110,231,168,0.8)' }}
    />
  )
}

/** Hover controls: cancel · mic picker · open Hub (PLAN §2.1). */
function Controls({
  onCancel,
  onMic,
  onHub,
  menuOpen,
}: {
  onCancel: () => void
  onMic: () => void
  onHub: () => void
  menuOpen: boolean
}): React.JSX.Element {
  return (
    <div className="bar-controls absolute right-[6px] top-1/2 flex -translate-y-1/2 items-center gap-[3px]">
      <ControlButton label="Cancel dictation" onClick={onCancel}>
        <path d="M6 6l12 12M18 6L6 18" />
      </ControlButton>
      <ControlButton label="Choose microphone" onClick={onMic} pressed={menuOpen}>
        <path d="M12 4a2.5 2.5 0 0 1 2.5 2.5v5a2.5 2.5 0 0 1-5 0v-5A2.5 2.5 0 0 1 12 4zM6 11a6 6 0 0 0 12 0M12 17v3" />
      </ControlButton>
      <ControlButton label="Open the Murmur hub" onClick={onHub}>
        <path d="M5 5h6M5 5v6M5 5l7 7M19 19h-6M19 19v-6M19 19l-7-7" />
      </ControlButton>
    </div>
  )
}

function ControlButton({
  label,
  onClick,
  pressed,
  children,
}: {
  label: string
  onClick: () => void
  pressed?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      onClick={onClick}
      className={[
        'grid size-[18px] cursor-pointer place-items-center rounded-full transition-all duration-150',
        'hover:bg-white/15 hover:text-white active:scale-90 active:bg-white/20',
        pressed ? 'bg-white/15 text-white' : 'text-white/70',
      ].join(' ')}
    >
      <svg
        viewBox="0 0 24 24"
        aria-hidden="true"
        className="size-[11px]"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {children}
      </svg>
    </button>
  )
}

/**
 * The mic picker, opening upward into the transparent space above the pill —
 * which is why the Bar window is taller than the capsule (see windows/bar.ts).
 */
function MicMenu({
  panelRef,
  devices,
  selected,
  onSelect,
}: {
  panelRef: React.RefObject<HTMLDivElement | null>
  devices: AudioDevice[]
  selected: string | null
  onSelect: (deviceId: string | null) => void
}): React.JSX.Element {
  return (
    <div
      ref={panelRef}
      role="menu"
      aria-label="Microphone"
      className="bar-pill bar-menu mb-2 max-h-[150px] w-[240px] overflow-y-auto rounded-xl p-1 text-[11px] text-white/90"
      style={{
        background: 'rgba(19,19,24,0.96)',
        border: '1px solid rgba(255,255,255,0.10)',
        boxShadow: BAR_SHADOW,
        backdropFilter: 'blur(14px)',
      }}
    >
      <p className="px-2 pb-1 pt-1.5 text-[9px] font-semibold uppercase tracking-[0.08em] text-white/40">
        Microphone
      </p>
      <MicOption label="System default" active={selected === null} onClick={() => onSelect(null)} />
      {devices.map((device, index) => (
        <MicOption
          key={device.deviceId}
          label={device.label || `Microphone ${index + 1}`}
          active={selected === device.deviceId}
          onClick={() => onSelect(device.deviceId)}
        />
      ))}
      {devices.length === 0 ? (
        <p className="px-2 py-1.5 text-white/50">
          No microphones listed yet — grant access and they appear here.
        </p>
      ) : null}
    </div>
  )
}

function MicOption({
  label,
  active,
  onClick,
}: {
  label: string
  active: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={active}
      onClick={onClick}
      className={[
        'flex w-full cursor-pointer items-center gap-1.5 truncate rounded-lg px-2 py-1.5 text-left transition-colors duration-100',
        active ? 'bg-white/15 text-white' : 'text-white/80 hover:bg-white/10 active:bg-white/15',
      ].join(' ')}
    >
      <svg
        viewBox="0 0 24 24"
        aria-hidden="true"
        className={`size-[10px] shrink-0 ${active ? 'opacity-100' : 'opacity-0'}`}
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="m5 12.5 4.5 4.5L19 7" />
      </svg>
      <span className="truncate">{label}</span>
    </button>
  )
}

function hits(element: HTMLElement | null, x: number, y: number): boolean {
  if (!element) return false
  const rect = element.getBoundingClientRect()
  // A few pixels of slack so the pointer cannot fall through the seam between
  // the pill and the menu sitting above it.
  const slack = 4
  return (
    x >= rect.left - slack &&
    x <= rect.right + slack &&
    y >= rect.top - slack &&
    y <= rect.bottom + slack
  )
}

function noop(): void {
  /* a fire-and-forget IPC failure is not actionable inside the Bar */
}
