import { CheckPulse } from './BarCanvas'
import { NubCanvas } from './NubCanvas'
import { StatusDot } from './parts'
import type { BarCorner } from '@murmur/shared'

import { useEffect, useRef } from 'react'

import {
  BAR_FLOURISH_BORDER,
  BAR_FLOURISH_GLOW,
  BAR_HALO,
  BAR_SHADOW,
  NUB,
  type Flourish,
  type NubVisual,
} from './visual'

/**
 * The corner orb — the alternative to the bottom-centre pill.
 *
 * A quarter-disc pinned into a bottom corner of the screen, reading as a small
 * round object sitting *behind* the panel with only its edge showing. It runs
 * the same five states as the pill, and grows out of the corner as it moves
 * through them: a sliver while idle, most of the way out while listening.
 *
 * The shape is one CSS declaration. `border-radius: 0 100% 0 0` on a square
 * rounds its top-right corner by the full width and height, which carves the
 * square down to exactly the quarter-disc centred on its bottom-left corner —
 * and that corner is the corner of the screen. The mirror image
 * (`100% 0 0 0`) does the other side.
 *
 * Since the pill's redesign this component is **drawing only** — the same
 * glass, ring and shadow constants as the pill, no backdrop-filter, no
 * animated blur. Everything interactive (the hover cluster, its tooltip, the
 * mic menu, the intent timers) lives in Bar.tsx and is shared between the two
 * shapes, so hovering the orb produces exactly the pill's buttons with
 * exactly the pill's timing. The one piece of text that still lives here is
 * the error label, which has nowhere else to sit in a corner.
 */

export interface NubProps {
  visual: NubVisual
  corner: BarCorner
  levelRef: React.RefObject<number>
  reducedMotion: boolean
  /** The orb element — Bar.tsx hit-tests the pointer against it. */
  orbRef: React.RefObject<HTMLDivElement | null>
  /** Hide the error tray while the cluster is up; the buttons win the space. */
  clusterUp: boolean
  /** The ring to play, and a key that restarts it. `null` while none is due. */
  flourish: { kind: Flourish; key: number } | null
}

export function Nub({
  visual,
  corner,
  levelRef,
  reducedMotion,
  orbRef,
  clusterUp,
  flourish,
}: NubProps): React.JSX.Element {
  const left = corner === 'bottomLeft'
  // The corner the disc is centred on is the one it must *not* round.
  const radius = left ? '0 100% 0 0' : '100% 0 0 0'
  const edge = { bottom: 0, ...(left ? { left: 0 } : { right: 0 }) }

  /**
   * The aurora core and the voice-lit rim.
   *
   * Driven straight from the level ref at animation-frame rate, exactly the
   * way the fan is — through refs, never through React state, because 30 Hz
   * re-renders for something only these two elements can see would be the
   * renderer's whole frame budget. Only `opacity` is written: the one
   * property (with transform) the compositor plays without repainting.
   */
  const auroraRef = useRef<HTMLSpanElement | null>(null)
  const rimRef = useRef<HTMLSpanElement | null>(null)

  useEffect(() => {
    if (reducedMotion || visual.shape !== 'waveform') return
    let frame = 0
    const step = (): void => {
      frame = requestAnimationFrame(step)
      const level = levelRef.current ?? 0
      const aurora = auroraRef.current
      const rim = rimRef.current
      // The floor keeps the core alive through pauses in speech; the span is
      // what makes a syllable visibly *land* in the glass.
      if (aurora) aurora.style.opacity = (0.45 + level * 0.5).toFixed(3)
      if (rim) rim.style.opacity = (0.18 + level * 0.8).toFixed(3)
    }
    frame = requestAnimationFrame(step)
    return () => cancelAnimationFrame(frame)
  }, [visual.shape, levelRef, reducedMotion])

  /** The states that cast light on the desktop around the corner. */
  const haloState =
    visual.shape === 'waveform'
      ? ('listening' as const)
      : visual.shape === 'check'
        ? ('inserted' as const)
        : visual.shape === 'message'
          ? ('error' as const)
          : null
  /** The aurora runs while the machine is working; never at rest. */
  const showAurora = visual.shape === 'waveform' || visual.shape === 'shimmer'
  const haloSize = NUB.activeRadius * 2 + 100
  const morph = reducedMotion
    ? 'opacity 120ms linear, background-color 120ms linear'
    : [
        `width ${NUB.morphMs}ms cubic-bezier(0.3,1.28,0.4,1)`,
        `height ${NUB.morphMs}ms cubic-bezier(0.3,1.28,0.4,1)`,
        `background-color ${NUB.morphMs}ms ease-out`,
        `border-color ${NUB.morphMs}ms ease-out`,
        `box-shadow ${NUB.morphMs * 2}ms ease-out`,
      ].join(', ')

  return (
    <>
      {/* The quarter halo — the pill's desktop-light language, bent around a
          corner: a blurred wash on the wallpaper itself, breathing while
          listening, one green flash for the ✓, a warm smoulder for an error.
          Centred ON the screen corner; the half that falls off-screen is
          clipped where nobody can see the cut. */}
      {haloState ? (
        <span
          aria-hidden="true"
          className="nub-halo"
          data-live={!reducedMotion && haloState === 'listening' ? 'true' : undefined}
          data-flash={!reducedMotion && haloState === 'inserted' ? 'true' : undefined}
          style={{
            width: haloSize,
            height: haloSize,
            bottom: -haloSize / 2,
            ...(left ? { left: -haloSize / 2 } : { right: -haloSize / 2 }),
            background: `radial-gradient(circle, ${BAR_HALO[haloState]}, transparent 70%)`,
            ...(reducedMotion ? { opacity: 0.3 } : null),
          }}
        />
      ) : null}

      {/* The error label. Text does not fit inside a quarter-disc, so it rides
          in a capsule above the orb — the pill's material, like everything
          else. It yields to the cluster: a user reaching for Cancel mid-error
          wants the button, not to be told again what went wrong. */}
      {visual.shape === 'message' && !clusterUp ? (
        <div
          className={`nub-tray absolute flex items-center rounded-full px-3 py-1.5 ${
            left ? 'left-2.5' : 'right-2.5'
          }`}
          style={{
            bottom: visual.radius + 10,
            background: visual.background,
            border: `1px solid ${visual.border}`,
            boxShadow: BAR_SHADOW,
            color: 'rgba(255,255,255,0.94)',
          }}
        >
          <span className="max-w-[260px] truncate text-[11px] font-medium leading-[18px]">
            {visual.label}
          </span>
        </div>
      ) : null}

      {/* The start / stop ring. A sibling of the orb rather than a child: the
          orb clips its own overflow, and the whole point of the ring is that it
          leaves. */}
      {flourish ? (
        <span
          key={flourish.key}
          aria-hidden="true"
          className="nub-flourish pointer-events-none absolute"
          data-kind={flourish.kind}
          style={{
            ...edge,
            width: visual.radius,
            height: visual.radius,
            borderRadius: radius,
            border: `1.5px solid ${BAR_FLOURISH_BORDER}`,
            boxShadow: BAR_FLOURISH_GLOW,
            transformOrigin: left ? 'bottom left' : 'bottom right',
          }}
        />
      ) : null}

      <div
        ref={orbRef}
        data-testid="bar-nub"
        data-shape={visual.shape}
        data-corner={corner}
        role="status"
        aria-live={visual.announce ? 'polite' : 'off'}
        aria-label={visual.ariaLabel}
        className="nub-orb absolute overflow-hidden"
        style={{
          ...edge,
          width: visual.radius,
          height: visual.radius,
          borderRadius: radius,
          background: visual.background,
          border: `1px solid ${visual.border}`,
          boxShadow: visual.glow ? `${BAR_SHADOW}, ${visual.glow}` : BAR_SHADOW,
          // No backdrop-filter, same as the pill: on a transparent window it
          // samples nothing and costs the compositor every animated frame.
          color: 'rgba(255,255,255,0.94)',
          transition: morph,
        }}
      >
        {/* The aurora core: a conic band of indigo-violet light revolving
            around the screen corner, clipped by the disc. A square twice the
            orb's maximum radius, centred on the corner, spun by the compositor
            (transform only) — its size never changes, so the orb's own morph
            never forces it to relayout. Brightness rides the voice (see the
            energy loop above). */}
        {showAurora ? (
          <span
            ref={auroraRef}
            aria-hidden="true"
            className="nub-aurora pointer-events-none absolute"
            style={{
              width: NUB.maxRadius * 2,
              height: NUB.maxRadius * 2,
              bottom: -NUB.maxRadius,
              ...(left ? { left: -NUB.maxRadius } : { right: -NUB.maxRadius }),
              opacity: visual.shape === 'shimmer' ? 0.3 : reducedMotion ? 0.4 : 0.45,
            }}
          />
        ) : null}

        {/* The pill's two glass coats, bent around the corner. */}
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0"
          style={{
            borderRadius: radius,
            background:
              'linear-gradient(to bottom, rgba(255,255,255,0.11), rgba(255,255,255,0.02) 46%, rgba(0,0,0,0.10))',
          }}
        />
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0"
          style={{
            borderRadius: radius,
            background:
              'radial-gradient(120% 140% at 50% -30%, rgba(255,255,255,0.13), transparent 55%)',
          }}
        />

        <NubInterior
          visual={visual}
          levelRef={levelRef}
          reducedMotion={reducedMotion}
          left={left}
        />

        {/* The rim, lit by the voice: the disc's own edge as a level meter.
            Sat over the interior so the fan appears to glow through it. */}
        {visual.shape === 'waveform' ? (
          <span
            ref={rimRef}
            aria-hidden="true"
            className="nub-rim pointer-events-none absolute inset-0"
            style={{
              borderRadius: radius,
              border: '1.5px solid rgba(176,186,255,0.95)',
              opacity: reducedMotion ? 0.5 : 0.18,
            }}
          />
        ) : null}

        {/* The state lights tuck into the corner itself, where the orb is
            solid at every radius it ever takes: hands-free and command mode
            along the bottom edge, recording up the side, so a hands-free
            dictation during a recorded meeting shows both. */}
        {visual.handsFree ? (
          <StatusDot
            kind="handsFree"
            style={{ bottom: 4, ...(left ? { left: 11 } : { right: 11 }) }}
          />
        ) : null}
        {visual.command ? (
          <StatusDot
            kind="command"
            style={{ bottom: 4, ...(left ? { left: 11 } : { right: 11 }) }}
          />
        ) : null}
        {visual.recording ? (
          <StatusDot
            kind="recording"
            style={{ bottom: 11, ...(left ? { left: 4 } : { right: 4 }) }}
          />
        ) : null}
      </div>
    </>
  )
}

/**
 * What is drawn inside the disc.
 *
 * The three animated shapes go to the canvas; the ✓ and the error glyph are
 * DOM, sat on the diagonal where the disc is deepest. Under Reduce Motion the
 * canvas is not mounted at all — a single static arc stands in, so the orb
 * still shows it can hear you without anything moving (PLAN §15.5).
 */
function NubInterior({
  visual,
  levelRef,
  reducedMotion,
  left,
}: {
  visual: NubVisual
  levelRef: React.RefObject<number>
  reducedMotion: boolean
  left: boolean
}): React.JSX.Element | null {
  // The resting sliver is empty glass, as the pill's is — the ring is the
  // whole idle statement, and an empty interior is also a free one: no canvas
  // is mounted, so an idle orb schedules nothing at all.
  if (visual.shape === 'dots') return null

  // Far enough from the corner to sit in the body of the disc, close enough
  // that a 14 px glyph still clears the arc at `activeRadius`.
  const diagonal = { bottom: 8, ...(left ? { left: 8 } : { right: 8 }) }

  if (visual.shape === 'check') {
    return (
      <span className="absolute" style={diagonal}>
        <CheckPulse reducedMotion={reducedMotion} />
      </span>
    )
  }
  if (visual.shape === 'message') {
    return (
      <svg
        viewBox="0 0 24 24"
        aria-hidden="true"
        className="absolute size-[14px]"
        style={diagonal}
        fill="none"
        stroke="rgba(255,178,160,0.95)"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M12 8v5M12 16.5h.01" />
        <circle cx="12" cy="12" r="9" />
      </svg>
    )
  }
  if (reducedMotion) {
    return <StaticArc shape={visual.shape} left={left} />
  }
  return (
    <span
      aria-hidden="true"
      className="absolute bottom-0"
      // The canvas only ever draws the bottom-left case; the other corner is
      // this one flip. The fan is near enough symmetric for it to be invisible,
      // and nothing mirrored here carries text.
      //
      // The anchoring has to move with it. The canvas is wider than the orb and
      // is clipped by it, and its polar origin is its own bottom-*left* pixel:
      // pinned `left: 0` and flipped about the left edge, that origin swings out
      // of the orb entirely and the whole fan is clipped away. Pin the edge the
      // corner is on, and mirror about that same edge.
      style={{
        ...(left ? { left: 0 } : { right: 0 }),
        transform: left ? undefined : 'scaleX(-1)',
        transformOrigin: left ? 'bottom left' : 'bottom right',
      }}
    >
      <NubCanvas
        shape={visual.shape}
        levelRef={levelRef}
        epoch={visual.shape === 'waveform' ? 1 : 0}
      />
    </span>
  )
}

/** Reduce Motion: one still arc instead of a dancing fan (PLAN §15.5). */
function StaticArc({
  shape,
  left,
}: {
  shape: 'dots' | 'waveform' | 'shimmer'
  left: boolean
}): React.JSX.Element {
  const size = shape === 'dots' ? NUB.idleDotRadius * 2 : NUB.fanRadius * 2
  return (
    <span
      aria-hidden="true"
      className="absolute bottom-0"
      style={{
        ...(left ? { left: 0 } : { right: 0 }),
        width: size,
        height: size,
        borderRadius: '50%',
        border: '1px solid rgba(255,255,255,0.9)',
        opacity: shape === 'waveform' ? 0.6 : 0.3,
        // Centred on the screen corner, so only its outer quarter shows.
        transform: `translate(${left ? '-50%' : '50%'}, 50%)`,
      }}
    />
  )
}
