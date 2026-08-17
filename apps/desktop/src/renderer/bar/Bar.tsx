import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type {
  AudioDevice,
  BarCorner,
  BarStyle,
  BarVisibility,
  DictationEvent,
  HotkeyKey,
} from '@murmur/shared'

import { useReducedMotion } from '../hooks/useReducedMotion'
import { BarCanvas, CheckPulse } from './BarCanvas'
import { barHeights } from './level'
import { Nub } from './Nub'
import {
  BAR,
  BAR_FLOURISH_BORDER,
  BAR_FLOURISH_GLOW,
  BAR_HALO,
  BAR_IDLE_BACKGROUND,
  BAR_IDLE_BORDER,
  BAR_SHADOW,
  BarPresenter,
  CLUSTER,
  describeBar,
  describeCluster,
  describeNub,
  flourishFor,
  HOVER_ZONE,
  isBarVisible,
  NUB,
  type BarVisual,
  type ClusterAction,
  type ClusterButton,
  type ClusterSpec,
  type Flourish,
} from './visual'

/**
 * How long the exit animation gets before the pill unmounts. Must stay inside
 * the ~250 ms grace main leaves between a momentary hold expiring and the
 * window being hidden (see applyBarVisibility in main/index.ts).
 */
const EXIT_MS = 170

/**
 * How long a start / stop ring lives before it is taken out of the DOM. Must
 * outlast the longest flourish animation in bar.css (the 420 ms bloom), or the
 * ring is unmounted mid-flight.
 */
const FLOURISH_MS = 460

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
 *
 * Hovering swaps the pill for a row of floating buttons rather than growing it
 * (see {@link describeCluster}). That swap is the one thing here that can go
 * badly wrong: the resting pill is a 10 px sliver, and hit-testing a target
 * that vanishes under the pointer flickers. {@link HOVER_ZONE} is the fix — a
 * fixed rectangle, larger than either state, that owns the hover once it starts.
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
  /** The start / stop ring (settings: barFlourish), keyed so it can replay. */
  const [flourish, setFlourish] = useState<{ kind: Flourish; key: number } | null>(null)
  const flourishEnabledRef = useRef(true)
  const flourishKey = useRef(0)
  const previousState = useRef<DictationEvent['state']>('idle')
  const [hovered, setHovered] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [devices, setDevices] = useState<AudioDevice[]>([])
  /** The configured hotkey, shown inside the Dictate button ("Dictate fn"). */
  const [hotkeyKey, setHotkeyKey] = useState<HotkeyKey>('fn')
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
      // The ring marks the edges of `listening` — from the *machine's* events,
      // not the presenter's held view, so it fires the moment the key lands.
      const kind = flourishFor(previousState.current, next.state)
      previousState.current = next.state
      if (kind && flourishEnabledRef.current) {
        flourishKey.current += 1
        setFlourish({ kind, key: flourishKey.current })
      }
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

  // The ring removes itself once its animation has finished.
  useEffect(() => {
    if (flourish === null) return
    const timer = setTimeout(() => setFlourish(null), FLOURISH_MS)
    return () => clearTimeout(timer)
  }, [flourish])

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
      hotkey: { key: HotkeyKey }
    }): void => {
      visibilityRef.current = settings.barVisibility
      setVisibility(settings.barVisibility)
      setStyle(settings.barStyle)
      setCorner(settings.barCorner)
      flourishEnabledRef.current = settings.barFlourish
      setMicDeviceId(settings.micDeviceId)
      setHotkeyKey(settings.hotkey.key)
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

  const showCluster = hovered || menuOpen
  const visual = useMemo(() => describeBar(event, recording), [event, recording])
  // Hover deliberately does not grow the orb: the cluster is the hover
  // response for both shapes, and two answers to one gesture is one too many.
  const nubVisual = useMemo(() => describeNub(event, false, recording), [event, recording])
  const cluster = useMemo(() => describeCluster(event), [event])
  const visible = isBarVisible(visibility, event, recording)
  // The states that cast light on the desktop behind the pill. `event` is the
  // presenter's *held* event, so `inserted` persists long enough for the
  // halo's flash to complete inside it.
  const haloState =
    event.state === 'listening' || event.state === 'inserted' || event.state === 'error'
      ? event.state
      : null

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

  // The cluster gets the same treatment on a shorter clock: hover ending
  // starts its exit animation rather than unmounting it on that frame, which
  // was the cheapest-looking moment on the whole surface — controls that
  // vanish between two pointer samples read as a glitch, not a dismissal.
  const [clusterPresent, setClusterPresent] = useState(false)
  if (showCluster && !clusterPresent) setClusterPresent(true)
  useEffect(() => {
    if (showCluster) return
    const timer = setTimeout(() => setClusterPresent(false), reducedMotion ? 100 : CLUSTER.leaveMs)
    return () => clearTimeout(timer)
  }, [showCluster, reducedMotion])

  // -- click-through hit-testing --------------------------------------------
  const pillRef = useRef<HTMLDivElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const zoneRef = useRef<HTMLDivElement | null>(null)
  const interactiveRef = useRef(false)
  /**
   * Whether the cluster is up, as the *mouse handler* sees it.
   *
   * Maintained by the handler itself rather than mirrored from state, and that
   * is the whole point: writing it from an effect leaves it a paint behind, and
   * moves arrive at 60–125 Hz. One stale read sends the next move down the
   * narrow "entering" branch, which tests the collapsed 44 px sliver — so a
   * pointer already travelling along the cluster reads as outside and the two
   * states start fighting. Kept in a ref rather than in state so the listener
   * below is subscribed once; resubscribing mid-gesture drops the move that
   * would have ended it.
   */
  const hoveredRef = useRef(false)

  const setInteractive = useCallback((next: boolean) => {
    if (interactiveRef.current === next) return
    interactiveRef.current = next
    window.murmur.bar.setPointerRegion({ interactive: next })
  }, [])

  /**
   * Hover intent. The pointer arms an open timer by resting on the pill and a
   * close timer by stepping out of the zone; either is cancelled by movement
   * the other way. This is what separates deliberate hovers from pass-throughs
   * — with the immediate version, every pointer that crossed the bottom of the
   * screen played the whole swap, which is what "touchy" was.
   */
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const clearTimer = (timer: typeof openTimer): void => {
      if (timer.current !== null) {
        clearTimeout(timer.current)
        timer.current = null
      }
    }

    const onMove = (moveEvent: MouseEvent): void => {
      const { clientX, clientY } = moveEvent
      // Asymmetric on purpose. *Entering* is judged against the pill itself
      // (plus a little slack), so the buttons never arm from a stray pass
      // near the bottom of the screen. *Staying* is judged against the fixed
      // zone, which is larger than the row — otherwise collapsing the pill
      // out from under the pointer would immediately un-hover it, and the two
      // states would fight each other at ~60 Hz.
      const inside = hoveredRef.current
        ? hits(zoneRef.current, clientX, clientY) || hits(panelRef.current, clientX, clientY)
        : style === 'corner'
          ? hitsOrb(pillRef.current, corner, clientX, clientY)
          : hits(pillRef.current, clientX, clientY, 8)

      if (inside && visible) {
        clearTimer(closeTimer)
        if (!hoveredRef.current && openTimer.current === null) {
          openTimer.current = setTimeout(() => {
            openTimer.current = null
            hoveredRef.current = true
            setHovered(true)
            setInteractive(true)
          }, CLUSTER.openDelayMs)
        }
      } else {
        clearTimer(openTimer)
        if (hoveredRef.current && closeTimer.current === null) {
          closeTimer.current = setTimeout(() => {
            closeTimer.current = null
            hoveredRef.current = false
            setHovered(false)
            // The menu dies with the hover — there is no other way out: this
            // window is focusable:false, so it never gets a blur or an
            // outside click.
            setMenuOpen(false)
            setInteractive(false)
          }, CLUSTER.closeGraceMs)
        }
      }
    }

    const onLeave = (): void => {
      // The pointer left the whole window; the same grace applies — it may be
      // arcing over the transparent edge on its way back to a button.
      onMove(new MouseEvent('mousemove', { clientX: -1000, clientY: -1000 }))
    }

    window.addEventListener('mousemove', onMove)
    document.addEventListener('mouseleave', onLeave)
    return () => {
      window.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseleave', onLeave)
      clearTimer(openTimer)
      clearTimer(closeTimer)
    }
  }, [corner, setInteractive, style, visible])

  // A pill that goes away must not leave the window swallowing clicks — and
  // must not leave the handler believing the cluster is still up, or a timer
  // about to open it over nothing.
  useEffect(() => {
    if (visible) return
    if (openTimer.current !== null) clearTimeout(openTimer.current)
    hoveredRef.current = false
    setInteractive(false)
    // Through the close timer at zero rather than a bare setState: it is the
    // same "the hover is over" transition the pointer path takes, and it keeps
    // this effect from setting state synchronously mid-commit.
    if (closeTimer.current !== null) clearTimeout(closeTimer.current)
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null
      setHovered(false)
      setMenuOpen(false)
    }, 0)
    return () => {
      if (closeTimer.current !== null) {
        clearTimeout(closeTimer.current)
        closeTimer.current = null
      }
    }
  }, [setInteractive, visible])

  if (!visible && !present) return null

  const onClusterAction = (action: ClusterAction): void => {
    switch (action) {
      case 'dictate':
        // Hands-free, because a click has no key to hold. The Bar window is
        // focusable:false and, on macOS, a non-activating panel — so clicking
        // here does not change the frontmost app, and the utterance still lands
        // in whatever the user was working in.
        setMenuOpen(false)
        void window.murmur.dictation.startHandsFree().catch(noop)
        return
      case 'stop':
        setMenuOpen(false)
        void window.murmur.dictation.stopHandsFree().catch(noop)
        return
      case 'cancel':
        setMenuOpen(false)
        void window.murmur.dictation.cancel().catch(noop)
        return
      case 'scratchpad':
        setMenuOpen(false)
        void window.murmur.notes.openWindow({ noteId: null }).catch(noop)
        return
      case 'mic':
        setMenuOpen((open) => !open)
        return
      case 'hub':
        setMenuOpen(false)
        void window.murmur.app.openHub().catch(noop)
        return
    }
  }

  if (style === 'corner') {
    const left = corner === 'bottomLeft'
    return (
      <div
        className="nub-stage relative h-full w-full"
        data-corner={corner}
        data-leaving={visible ? undefined : 'true'}
      >
        {/* The window hangs NUB.overhang below the screen so macOS's own
            window-corner rounding falls off the panel (see bar-layout.ts).
            This box trims that overhang away, so everything inside anchors to
            the real bottom edge of the screen. */}
        <div className="nub-anchor absolute inset-x-0 top-0" style={{ bottom: NUB.overhang }}>
          {/* The stay-zone, corner-anchored. Taller than the pill's: the
              cluster and its tooltip stand on top of the orb's radius. */}
          <div
            ref={zoneRef}
            aria-hidden="true"
            className="pointer-events-none absolute bottom-0"
            style={{
              width: 300,
              height: NUB.activeRadius + HOVER_ZONE.height,
              ...(left ? { left: 0 } : { right: 0 }),
            }}
          />

          <Nub
            visual={nubVisual}
            corner={corner}
            levelRef={levelRef}
            reducedMotion={reducedMotion}
            orbRef={pillRef}
            clusterUp={showCluster || clusterPresent}
            flourish={flourish}
          />

          {menuOpen ? (
            <div
              className={`absolute ${left ? 'left-2.5' : 'right-2.5'}`}
              style={{
                bottom: nubVisual.radius + 12 + CLUSTER.chipSize + 8,
              }}
            >
              <MicMenu
                panelRef={panelRef}
                devices={devices}
                selected={micDeviceId}
                onSelect={(deviceId) => {
                  setMenuOpen(false)
                  void window.murmur.settings.set({ micDeviceId: deviceId }).catch(noop)
                }}
              />
            </div>
          ) : null}

          {clusterPresent ? (
            <div
              className={`absolute ${left ? 'left-2.5' : 'right-2.5'}`}
              style={{ bottom: nubVisual.radius + 12 }}
            >
              <Cluster
                spec={cluster}
                anchor={left ? 'left' : 'right'}
                hotkeyHint={HOTKEY_HINT[hotkeyKey] ?? null}
                menuOpen={menuOpen}
                leaving={!showCluster}
                onAction={onClusterAction}
              />
            </div>
          ) : null}
        </div>
      </div>
    )
  }

  return (
    <div
      className="bar-stage relative flex h-full w-full flex-col items-center justify-end"
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

      {/*
        The hover zone. Invisible, click-through, and centred on the pill: it
        exists only so the pointer has a stable rectangle to be "inside" while
        the pill collapses and the cluster grows in its place. Sized in
        `visual.ts` so the test can pin it.

        Positioned explicitly rather than by flex static position. Every "stay
        hovered" hit-test measures this element's rect, so where it lands is
        load-bearing — leaving it to an abspos flex child's default placement
        would make the anti-flicker mechanism depend on a layout detail nothing
        states. Hence `relative` on the stage above and the centring here.
      */}
      <div
        ref={zoneRef}
        aria-hidden="true"
        className="pointer-events-none absolute bottom-0 left-1/2 -translate-x-1/2"
        style={{ width: HOVER_ZONE.width, height: HOVER_ZONE.height }}
      />

      {/* Pill and cluster occupy the same spot and cross-fade. Stacked rather
          than swapped so neither reflows the other on the way in or out. */}
      <div className="relative flex items-end justify-center" style={{ height: cluster.height }}>
        {haloState ? (
          <Halo
            state={haloState}
            width={visual.width}
            pillHeight={visual.height}
            reducedMotion={reducedMotion}
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
            // Deliberately NO backdrop-filter, here or on the cluster chips.
            // In a transparent Electron window it can only sample the window's
            // *own* content — behind this capsule that is empty transparency,
            // so it blurs nothing and shows nothing, yet still drags the
            // compositor through the full backdrop chain on every animated
            // frame. Five of these ran during the hover swap and the swap
            // visibly hitched. Real desktop vibrancy needs the native
            // NSVisualEffectView; until then the sheen layers below are the
            // glass, and they are free.
            color: 'rgba(255,255,255,0.94)',
            // Out of the way while the cluster is up — but still laid out, so
            // the row keeps its position and the fade has something to fade.
            opacity: showCluster ? 0 : 1,
            pointerEvents: showCluster ? 'none' : 'auto',
            transition: reducedMotion
              ? `opacity ${CLUSTER.fadeMs}ms linear`
              : [
                  `width ${BAR.morphMs}ms cubic-bezier(0.3,1.33,0.4,1)`,
                  `height ${BAR.morphMs}ms cubic-bezier(0.3,1.33,0.4,1)`,
                  `background-color ${BAR.morphMs}ms ease-out`,
                  `border-color ${BAR.morphMs}ms ease-out`,
                  // The glow blooms and fades slower than the morph, so a state
                  // change reads as a wash of colour rather than a switch.
                  `box-shadow ${BAR.morphMs * 2}ms ease-out`,
                  `opacity ${CLUSTER.fadeMs}ms ease-out`,
                ].join(', '),
          }}
        >
          {/* Glass, in two coats: a vertical sheen that lights the top edge
              and seats the bottom, then a soft key light falling from above.
              Together they read as curvature; either alone reads as a flat
              fill with a stripe on it. */}
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 rounded-full"
            style={{
              background:
                'linear-gradient(to bottom, rgba(255,255,255,0.11), rgba(255,255,255,0.02) 46%, rgba(0,0,0,0.10))',
            }}
          />
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 rounded-full"
            style={{
              background:
                'radial-gradient(120% 140% at 50% -30%, rgba(255,255,255,0.13), transparent 55%)',
            }}
          />
          <div className="relative flex min-w-0 max-w-full items-center justify-center">
            <BarInterior visual={visual} levelRef={levelRef} reducedMotion={reducedMotion} />
          </div>
          {visual.recording ? <RecordingDot /> : null}
          {visual.handsFree ? <HandsFreeDot /> : null}
          {visual.command ? <CommandDot /> : null}
        </div>

        {/* The start / stop ring, remounted per flourish (the key). An outer
            span carries the centring translate; the inner one animates scale —
            composed on one element the keyframes' transform would overwrite
            the translate and throw the ring half a pill-width sideways. */}
        {flourish ? (
          <span
            key={flourish.key}
            aria-hidden="true"
            className="pointer-events-none absolute bottom-0 left-1/2 -translate-x-1/2"
            style={{ width: visual.width, height: visual.height }}
          >
            <span
              className="bar-flourish block h-full w-full rounded-full"
              data-kind={flourish.kind}
              style={{
                border: `1.5px solid ${BAR_FLOURISH_BORDER}`,
                boxShadow: BAR_FLOURISH_GLOW,
              }}
            />
          </span>
        ) : null}

        {clusterPresent ? (
          <Cluster
            spec={cluster}
            hotkeyHint={HOTKEY_HINT[hotkeyKey] ?? null}
            menuOpen={menuOpen}
            leaving={!showCluster}
            onAction={onClusterAction}
          />
        ) : null}
      </div>
    </div>
  )
}

/**
 * The ambient wash behind the capsule (see {@link BAR_HALO}).
 *
 * A blurred radial span, wider than the pill, sitting on the transparent
 * window — so the light lands on the user's actual desktop. Breathing is CSS
 * (`bar-halo`), gated per state: listening breathes, the ✓ is a single flash
 * timed inside the inserted hold, an error smoulders without animating.
 * Under Reduce Motion it is a faint static glow.
 */
function Halo({
  state,
  width,
  pillHeight,
  reducedMotion,
}: {
  state: keyof typeof BAR_HALO
  width: number
  /** The capsule this is lighting, so the wash can be centred on it. */
  pillHeight: number
  reducedMotion: boolean
}): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      className="bar-halo"
      data-live={!reducedMotion && state === 'listening' ? 'true' : undefined}
      data-flash={!reducedMotion && state === 'inserted' ? 'true' : undefined}
      style={{
        width: width + BAR.haloSpreadX,
        height: BAR.haloHeight,
        // Centred *on the capsule*, which sits at the bottom of this row and is
        // shorter than the halo — so the light spills evenly above and below it
        // rather than hanging off one edge. Horizontal centring is the CSS's
        // job (`margin-inline: auto`); only this axis needs the pill's size.
        bottom: (pillHeight - BAR.haloHeight) / 2,
        // Fully transparent well inside the box — see .bar-halo for why the
        // edge of this gradient is load-bearing and not just taste.
        background: `radial-gradient(closest-side, ${BAR_HALO[state]}, transparent 66%)`,
        ...(reducedMotion ? { opacity: 0.3 } : null),
      }}
    />
  )
}

/**
 * The controls that stand in for the pill on hover — the reference product's
 * exact arrangement: one row of round near-black buttons where the pill was,
 * and a floating capsule above the hovered one naming it ("Dictate fn", with
 * the user's real hotkey). The label is a tooltip, not a control.
 *
 * The motion rules here exist because the swap used to read as clunky, twice:
 *
 *  - The row enters and leaves as **one animated unit**. A per-button cascade
 *    meant five layers animating independently against the pill's fade, and
 *    the sum read as commotion.
 *  - The tooltip is **one persistent element that glides** between buttons.
 *    Conditional mounting meant it unmounted in every 8 px gap and replayed
 *    its entrance on the far side — a blink per button while scrubbing the
 *    row. It now keeps its last label while fading, and slides on transform.
 */
function Cluster({
  spec,
  anchor = 'center',
  hotkeyHint,
  menuOpen,
  leaving,
  onAction,
}: {
  spec: ClusterSpec
  /**
   * Where the row grows out of: the pill's bottom-centre, or the orb's
   * corner. Sets the morph's transform-origin (bar.css), so the row inflates
   * out of whichever shape it is standing in for.
   */
  anchor?: 'left' | 'center' | 'right'
  /** Short label for the configured hotkey ("fn", "⌘"), or null to omit. */
  hotkeyHint: string | null
  menuOpen: boolean
  /** Hover has ended; play the exit and swallow no clicks while doing it. */
  leaving: boolean
  onAction: (action: ClusterAction) => void
}): React.JSX.Element {
  /**
   * `hover` is the button under the pointer right now; `last` is the one the
   * tooltip is (still) showing. Kept together in one state so the label can
   * fade out in place over the button the pointer just left, rather than
   * vanishing the instant `hover` goes null in a gap.
   */
  const [tip, setTip] = useState<{ hover: ClusterAction | null; last: ClusterAction | null }>({
    hover: null,
    last: null,
  })

  const shown = spec.chips.find((chip) => chip.action === tip.last) ?? null
  const shownIndex = shown ? spec.chips.findIndex((chip) => chip.action === shown.action) : 0
  const tipCentre = shownIndex * (CLUSTER.chipSize + CLUSTER.gap) + CLUSTER.chipSize / 2
  const tipOn = tip.hover !== null && shown !== null && !menuOpen && !leaving

  return (
    <div
      data-testid="bar-cluster"
      data-leaving={leaving ? 'true' : undefined}
      data-anchor={anchor === 'center' ? undefined : anchor}
      className={`bar-cluster flex items-center ${anchor === 'center' ? 'absolute bottom-0' : 'relative'}`}
      style={{ gap: CLUSTER.gap, height: spec.height }}
      onMouseLeave={() => setTip((current) => ({ hover: null, last: current.last }))}
    >
      {/* One element for the label, always mounted once something has been
          hovered — it slides and fades, it never re-mounts. */}
      {shown ? (
        <div
          aria-hidden="true"
          className="bar-tooltip pointer-events-none absolute left-0 flex items-baseline gap-1.5 whitespace-nowrap rounded-full px-4 text-[13px] font-medium text-white"
          style={{
            bottom: CLUSTER.chipSize + CLUSTER.tooltipGap,
            height: CLUSTER.tooltipHeight,
            lineHeight: `${CLUSTER.tooltipHeight}px`,
            transform: `translateX(calc(${tipCentre}px - 50%))`,
            opacity: tipOn ? 1 : 0,
            background: CLUSTER_BUTTON_BG,
            border: `1px solid ${CLUSTER_BUTTON_BORDER}`,
            boxShadow: BAR_SHADOW,
          }}
        >
          {shown.label}
          {shown.action === 'dictate' && hotkeyHint ? (
            <span className="font-bold">{hotkeyHint}</span>
          ) : null}
        </div>
      ) : null}

      {spec.chips.map((chip) => (
        <ClusterButtonView
          key={chip.action}
          button={chip}
          pressed={chip.action === 'mic' ? menuOpen : undefined}
          onHover={(over) =>
            setTip((current) => ({
              hover: over ? chip.action : current.hover === chip.action ? null : current.hover,
              last: over ? chip.action : current.last,
            }))
          }
          onClick={() => onAction(chip.action)}
        />
      ))}
    </div>
  )
}

/**
 * The buttons are dressed in the resting pill's EXACT recipe — its translucent
 * fill, its bright ring, its shadow stack. Not "similar": the same constants.
 * Anything darker or dimmer-edged read as the pill being replaced by
 * strangers; identical material is half of what makes the swap read as the
 * pill becoming the buttons (the silhouette morph in bar.css is the other
 * half).
 */
const CLUSTER_BUTTON_BG = BAR_IDLE_BACKGROUND
const CLUSTER_BUTTON_BORDER = BAR_IDLE_BORDER

/** Foreground colour per tone; backgrounds come from the wash overlay below. */
const CLUSTER_TONE: Record<ClusterButton['tone'], string> = {
  default: 'text-white/90 hover:text-white',
  accent: 'text-white',
  destructive: 'text-red-200 hover:text-red-100',
}

/** The hover wash per tone — an overlay span, so it wins over the inline base. */
const CLUSTER_WASH: Record<ClusterButton['tone'], string> = {
  default: 'bg-white/10',
  accent: 'bg-white/10',
  destructive: 'bg-red-500/25',
}

function ClusterButtonView({
  button,
  pressed,
  onHover,
  onClick,
}: {
  button: ClusterButton
  pressed?: boolean | undefined
  onHover: (over: boolean) => void
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-label={button.label}
      aria-pressed={pressed}
      onClick={onClick}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
      className={[
        'bar-pill bar-chip group relative flex shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-full',
        CLUSTER_TONE[button.tone],
      ].join(' ')}
      style={{
        width: CLUSTER.chipSize,
        height: CLUSTER.chipSize,
        background: CLUSTER_BUTTON_BG,
        border: `1px solid ${CLUSTER_BUTTON_BORDER}`,
        boxShadow: BAR_SHADOW,
      }}
    >
      {/* Hover / pressed wash. An overlay because the base colour is an inline
          style, which outranks any hover class put on the button itself. */}
      <span
        aria-hidden="true"
        className={[
          'pointer-events-none absolute inset-0 rounded-full transition-opacity duration-150',
          CLUSTER_WASH[button.tone],
          pressed ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-active:opacity-70',
        ].join(' ')}
      />
      {/* Same top light as the pill, so the row reads as the same material. */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 rounded-full"
        style={{
          background:
            'linear-gradient(to bottom, rgba(255,255,255,0.10), rgba(255,255,255,0.01) 50%, rgba(0,0,0,0.08))',
        }}
      />
      <svg
        viewBox="0 0 24 24"
        aria-hidden="true"
        className="relative size-[16px] shrink-0"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {CLUSTER_ICON[button.action]}
      </svg>
    </button>
  )
}

/** How the hotkey reads inside the Dictate tooltip. Unmappable keys show none. */
const HOTKEY_HINT: Partial<Record<HotkeyKey, string>> = {
  fn: 'fn',
  rightCmd: '⌘',
  rightOpt: '⌥',
  rightCtrl: 'ctrl',
  capsLock: 'caps',
}

const CLUSTER_ICON: Record<ClusterAction, React.ReactNode> = {
  // A microphone.
  dictate: (
    <path d="M12 4a2.5 2.5 0 0 1 2.5 2.5v5a2.5 2.5 0 0 1-5 0v-5A2.5 2.5 0 0 1 12 4zM6 11a6 6 0 0 0 12 0M12 17v3" />
  ),
  // A filled square: the universal stop.
  stop: <rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" stroke="none" />,
  cancel: <path d="M6 6l12 12M18 6L6 18" />,
  // A page with a line on it.
  scratchpad: <path d="M6 4h8l4 4v12H6zM14 4v4h4M9 13h6M9 16.5h4" />,
  mic: (
    <path d="M12 4a2.5 2.5 0 0 1 2.5 2.5v5a2.5 2.5 0 0 1-5 0v-5A2.5 2.5 0 0 1 12 4zM6 11a6 6 0 0 0 12 0M12 17v3" />
  ),
  hub: <path d="M5 5h6M5 5v6M5 5l7 7M19 19h-6M19 19v-6M19 19l-7-7" />,
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
}): React.JSX.Element | null {
  // The resting sliver is an empty outlined capsule, as in the reference —
  // the ring itself is the whole idle statement. The dots it used to hold
  // made it read as a tiny broken waveform.
  if (visual.shape === 'dots') return null
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
        background: 'rgba(18,18,25,0.95)',
        border: '1px solid rgba(255,255,255,0.10)',
        boxShadow: BAR_SHADOW,
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

/**
 * The corner orb is a quarter-disc, so its bounding box over-claims by a fifth
 * of its area — the empty square outside the arc. Hit-test it as what it is:
 * within `radius + slack` of the screen corner it is pinned to.
 */
function hitsOrb(
  element: HTMLElement | null,
  corner: BarCorner,
  x: number,
  y: number,
  slack = 10,
): boolean {
  if (!element) return false
  const rect = element.getBoundingClientRect()
  const originX = corner === 'bottomLeft' ? rect.left : rect.right
  const originY = rect.bottom
  const reach = rect.width + slack
  const dx = x - originX
  const dy = y - originY
  return dx * dx + dy * dy <= reach * reach
}

function hits(element: HTMLElement | null, x: number, y: number, slack = 4): boolean {
  if (!element) return false
  const rect = element.getBoundingClientRect()
  // A few pixels of slack so the pointer cannot fall through the seam between
  // the pill and the menu sitting above it — and, for the resting sliver, so a
  // 10 px-tall target is not 10 px of aim.
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
