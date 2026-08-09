import type { AudioDevice, BarCorner } from '@murmur/shared'

import { CheckPulse } from './BarCanvas'
import { NubCanvas } from './NubCanvas'
import { Controls, MicMenu, StatusDot } from './parts'
import {
  BAR_FLOURISH_BORDER,
  BAR_FLOURISH_GLOW,
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
 * What does *not* fit inside a quarter-disc is text, so the error label and the
 * hover controls live in a small capsule — the tray — that rides above the orb
 * and slides with it as it morphs.
 */

export interface NubProps {
  visual: NubVisual
  corner: BarCorner
  levelRef: React.RefObject<number>
  reducedMotion: boolean
  showControls: boolean
  menuOpen: boolean
  devices: AudioDevice[]
  micDeviceId: string | null
  /** The orb itself — the pointer region and the hit-test target. */
  orbRef: React.RefObject<HTMLDivElement | null>
  /** The tray and menu stack, so the pointer can travel up to them. */
  panelRef: React.RefObject<HTMLDivElement | null>
  /** The ring to play, and a key that restarts it. `null` while none is due. */
  flourish: { kind: Flourish; key: number } | null
  onCancel: () => void
  onMic: () => void
  onHub: () => void
  onSelectDevice: (deviceId: string | null) => void
}

export function Nub({
  visual,
  corner,
  levelRef,
  reducedMotion,
  showControls,
  menuOpen,
  devices,
  micDeviceId,
  orbRef,
  panelRef,
  flourish,
  onCancel,
  onMic,
  onHub,
  onSelectDevice,
}: NubProps): React.JSX.Element {
  const left = corner === 'bottomLeft'
  // The corner the disc is centred on is the one it must *not* round.
  const radius = left ? '0 100% 0 0' : '100% 0 0 0'
  const edge = { bottom: 0, ...(left ? { left: 0 } : { right: 0 }) }
  const stack = left ? { left: 10 } : { right: 10 }
  const morph = reducedMotion
    ? 'opacity 120ms linear, background-color 120ms linear'
    : [
        `width ${NUB.morphMs}ms cubic-bezier(0.3,1.28,0.4,1)`,
        `height ${NUB.morphMs}ms cubic-bezier(0.3,1.28,0.4,1)`,
        `bottom ${NUB.morphMs}ms cubic-bezier(0.3,1.28,0.4,1)`,
        `background-color ${NUB.morphMs}ms ease-out`,
        `border-color ${NUB.morphMs}ms ease-out`,
        `box-shadow ${NUB.morphMs * 2}ms ease-out`,
      ].join(', ')

  // The tray carries whichever of the two is live. Controls win when both are:
  // a user who has reached for the pill mid-error wants the cancel button, not
  // to be told again what went wrong.
  const tray = showControls ? 'controls' : visual.shape === 'message' ? 'message' : null

  return (
    <>
      {tray || menuOpen ? (
        <div
          ref={panelRef}
          className={`absolute flex flex-col ${left ? 'items-start' : 'items-end'} gap-2`}
          style={{ bottom: visual.radius + 8, ...stack, transition: morph }}
        >
          {menuOpen ? (
            <MicMenu devices={devices} selected={micDeviceId} onSelect={onSelectDevice} />
          ) : null}
          {tray ? (
            <div
              className="nub-tray flex items-center rounded-full px-[6px] py-[4px]"
              style={{
                background: visual.background,
                border: `1px solid ${visual.border}`,
                boxShadow: BAR_SHADOW,
                backdropFilter: 'blur(14px)',
                color: 'rgba(255,255,255,0.94)',
              }}
            >
              {tray === 'controls' ? (
                <Controls menuOpen={menuOpen} onCancel={onCancel} onMic={onMic} onHub={onHub} />
              ) : (
                <span className="max-w-[280px] truncate px-1.5 text-[11px] font-medium leading-[18px]">
                  {visual.label}
                </span>
              )}
            </div>
          ) : null}
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
          backdropFilter: 'blur(14px)',
          color: 'rgba(255,255,255,0.94)',
          transition: morph,
        }}
      >
        <NubInterior
          visual={visual}
          levelRef={levelRef}
          reducedMotion={reducedMotion}
          left={left}
        />

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
}): React.JSX.Element {
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
