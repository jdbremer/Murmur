import {
  DICTATION_ERROR_LABEL,
  MOMENTARY_HOLD_MS,
  type BarVisibility,
  type DictationEvent,
} from '@murmur/shared'

/**
 * The Bar's state → pixels mapping (PLAN §2.1) — pure, so it can be tested.
 *
 * Every number in this file is from the spec: the 64 × 22 idle capsule, the
 * ~160 px listening expansion, the ~150 ms ease-out morph, the ~2.5 s error
 * dismissal. The renderer reads them; it never invents them. Getting the
 * geometry wrong is the single most visible way this stage can fail, and it is
 * the one thing a machine with no display can still check.
 */

// ---------------------------------------------------------------------------
// Geometry & timing constants (PLAN §2.1)
// ---------------------------------------------------------------------------

export const BAR = {
  /** Idle capsule. */
  idleWidth: 64,
  height: 22,
  /** Height while the hover controls are showing — "expands it slightly". */
  hoverHeight: 30,
  /**
   * How much wider the capsule grows on hover. Deliberately more than
   * {@link BAR.controlsWidth}: the extra is breathing room so the controls do
   * not crowd whatever the pill is showing.
   */
  hoverWidth: 84,
  /**
   * What the controls actually occupy on the right, derived from their own
   * geometry: three 18px buttons, two 3px gaps, and the 6px inset they sit at.
   *
   * Kept separate from `hoverWidth` because they answer different questions —
   * how much the capsule grows, versus how much room is no longer available to
   * the interior. Centring the interior against the growth rather than the
   * footprint is what left it sitting 9px off-centre.
   */
  controlsWidth: 3 * 18 + 2 * 3 + 6,
  /** Listening. */
  listeningWidth: 160,
  processingWidth: 132,
  insertingWidth: 112,
  insertedWidth: 96,
  /** Error pills size to their message, within these bounds. */
  errorMinWidth: 180,
  errorMaxWidth: 300,
  /** The window is 360 px wide; nothing may exceed it (see windows/bar.ts). */
  maxWidth: 344,
  /** Every state change morphs over this, ease-out (PLAN §2.1). */
  morphMs: 150,
  /** How long the ✓ pulse holds — shared with main's window retirement. */
  insertedHoldMs: MOMENTARY_HOLD_MS.inserted,
  /** Error auto-dismiss (PLAN §2.1) — likewise shared. */
  errorHoldMs: MOMENTARY_HOLD_MS.error,
  /** Waveform: 24–32 bars, ~2 px wide with a 2 px gap (PLAN §2.1). */
  waveformBars: 28,
  waveformBarWidth: 2,
  waveformBarGap: 2,
  /** Bar heights inside the capsule. */
  waveformMinHeight: 2,
  waveformMaxHeight: 14,
  /** One shimmer sweep across the pill while processing. */
  shimmerPeriodMs: 1100,
} as const

/**
 * The corner orb — the alternative to the pill (settings: `barStyle: 'corner'`).
 *
 * A quarter-disc pinned into a bottom corner of the screen, as if a small round
 * object were sitting behind the panel with only its edge showing. It runs the
 * same five states as the pill and shares its colours; only the geometry
 * differs, so everything below is radii rather than widths.
 *
 * The one number that is not free: the containing window is 320 × 300 (see
 * `main/windows/bar-layout.ts`), and the orb grows from the corner, so no
 * radius may approach either of those.
 */
export const NUB = {
  /** The sliver that shows when nothing is happening. */
  idleRadius: 22,
  /**
   * Every state that is not idle, at one size.
   *
   * The pill sizes each state separately — it has a width to spend, and a
   * short "Inserting" deserves less of it than a live waveform. The orb has no
   * such argument to make: the states differ in what is *drawn* inside it, and
   * resizing the disc between them meant the corner of the screen breathed in
   * and out four times per utterance. One size, entered once and left once, so
   * the only motion during a dictation is the fan responding to your voice.
   *
   * Small on purpose, too. Earlier versions went to 70 and then 46, and both
   * made the growth itself the event — something lunged out of the corner on
   * every key press. Under twice the idle sliver is enough to read as *on* at
   * a glance while staying furniture rather than a performance; the fan,
   * `arcRadius` and `idleDotRadius` are all sized as fractions of these two
   * radii, so moving either means moving those with it.
   */
  activeRadius: 42,
  /** Hovering grows it, the way hovering widens the pill. */
  hoverGrowth: 6,
  /** Nothing may reach the window edge (320 × 300). */
  maxRadius: 120,
  /**
   * How far the window hangs *below* the screen, so macOS's window-corner
   * rounding is off-panel and cannot clip the orb's point. The screen's bottom
   * edge is therefore this far up from the bottom of the page, and everything
   * the corner style draws is positioned against that line rather than against
   * the page.
   *
   * Must equal `NUB_OVERHANG` in `main/windows/bar-layout.ts` — the two are a
   * pair, and `bar-layout.test.ts` asserts they have not drifted.
   */
  overhang: 24,
  /**
   * The canvas is fixed at this size and clipped by the disc, exactly as the
   * pill's is — that is what makes the fan look like it *emerges* from behind
   * the corner as the orb grows, rather than being redrawn at a new scale 60
   * times a second during a 170 ms morph.
   */
  canvas: 56,
  /** Slightly slower than the pill's: a bigger travel needs a longer beat. */
  morphMs: 170,
  /** The listening fan: rays radiating from the corner. */
  /**
   * Ray count follows the fan's radius: the rays are spread over a fixed 72°,
   * so their spacing is `fanRadius × span / (rays − 1)`. Eighteen of them at
   * this radius would sit ~2 px apart — solid, not a fan — so the count came
   * down with the geometry to keep the ~3 px gap the pill's waveform has.
   */
  rays: 11,
  rayWidth: 2,
  /**
   * Where the rays start, and how far they reach at full volume.
   *
   * Deliberately close to the rim — about two thirds out. Sitting the fan
   * halfway made the orb read as a small dial inside a large empty disc; out
   * here it reads as the edge of the thing responding, which is what a
   * waveform hugging the end of a capsule does.
   */
  fanRadius: 27,
  rayMinLength: 2,
  rayMaxLength: 12,
  /**
   * The fan's angular span in degrees, measured from the screen edge the orb
   * sits against. Held off 0 and 90 so the outermost rays are not lying flat
   * along the bezel, which reads as a rendering fault rather than as a taper.
   */
  spanStartDegrees: 9,
  spanEndDegrees: 81,
  /** Where the processing arc sweeps, and the idle dots sit — each about two
   * thirds of the way out of its own state's disc, like the fan. */
  arcRadius: 26,
  idleDotRadius: 13,
  idleDots: 3,
} as const

/** Near-black, per PLAN §2.1. */
export const BAR_BACKGROUND = 'rgba(17,17,22,0.92)'
/** Warm red for the error state. */
export const BAR_ERROR_BACKGROUND = 'rgba(70,22,22,0.94)'
export const BAR_BORDER = 'rgba(255,255,255,0.09)'
/** The capsule's edge brightens while it is actually hearing something. */
export const BAR_LISTENING_BORDER = 'rgba(255,255,255,0.16)'
export const BAR_ERROR_BORDER = 'rgba(255,148,132,0.32)'
/**
 * Two layers: a tight contact shadow that seats the capsule on the screen, and
 * a wide ambient one that lifts it off whatever is behind it. The inset line
 * is the glass highlight along the top edge.
 */
export const BAR_SHADOW =
  '0 2px 6px rgba(0,0,0,0.30), 0 12px 32px rgba(0,0,0,0.42), inset 0 1px 0 rgba(255,255,255,0.07)'

/**
 * The start / stop ring's edge, and the bloom it carries.
 *
 * The listening indigo rather than plain white: a white hairline expanding over
 * a white document is invisible at exactly the moment the ring exists to be
 * seen, and the ring is announcing the state whose glow this already is. The
 * bloom is what keeps it legible over dark windows too.
 */
export const BAR_FLOURISH_BORDER = 'rgba(129,140,248,0.7)'
export const BAR_FLOURISH_GLOW = '0 0 14px rgba(129,140,248,0.32)'

/**
 * A soft state-coloured halo layered onto {@link BAR_SHADOW}: cool while
 * listening, green for the ✓, warm for an error. Transitioned by the renderer,
 * so states bleed into each other instead of snapping.
 */
export const BAR_GLOW = {
  listening: '0 0 24px rgba(129,140,248,0.30)',
  inserted: '0 0 22px rgba(110,231,168,0.26)',
  error: '0 0 24px rgba(248,113,113,0.24)',
} as const

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

/** What the pill is drawing right now. */
export type BarShape =
  /** Dim static dots — the idle hint that the mic is there. */
  | 'dots'
  /** The live waveform. */
  | 'waveform'
  /** Bars collapsed into a left→right shimmer sweep. */
  | 'shimmer'
  /** The ✓ pulse. */
  | 'check'
  /** A short message. */
  | 'message'

export interface BarVisual {
  shape: BarShape
  width: number
  height: number
  background: string
  border: string
  /** Message text for `shape: 'message'`, otherwise empty. */
  label: string
  /** Extra state-coloured halo layered onto the base shadow, or null. */
  glow: string | null
  /** The latched hands-free indicator dot (PLAN §2.1 "Hands-free"). */
  handsFree: boolean
  /** True while this utterance is editing a selection (command mode). */
  command: boolean
  /** What VoiceOver and the window title announce. */
  ariaLabel: string
  /** True while the state is one an assistive tech should be told about. */
  announce: boolean
  /**
   * A meeting is being recorded right now (PLAN §18.2).
   *
   * Rendered as a steady red dot rather than folded into `shape`, because it
   * is orthogonal to what the pill is doing: dictation still owns the pill and
   * cycles through its own states, while this stays lit underneath the whole
   * time. It is also the only always-visible sign that a recording is running,
   * which makes it a consent surface rather than decoration — the pill is
   * forced visible while it is set.
   */
  recording: boolean
}

/**
 * Map one dictation event to the pill's appearance.
 *
 * `hovered` is the only renderer-local input: hovering widens the capsule to
 * fit the cancel / mic / Hub controls without changing what it is showing.
 */
export function describeBar(event: DictationEvent, hovered = false, recording = false): BarVisual {
  const base = describeBase(event)
  const width = clampWidth(base.width + (hovered ? BAR.hoverWidth : 0))
  return { ...base, width, height: hovered ? BAR.hoverHeight : BAR.height, recording }
}

function describeBase(event: DictationEvent): BarVisual {
  switch (event.state) {
    case 'idle':
      return {
        shape: 'dots',
        width: BAR.idleWidth,
        height: BAR.height,
        background: BAR_BACKGROUND,
        border: BAR_BORDER,
        label: '',
        glow: null,
        handsFree: false,
        command: false,
        ariaLabel: 'Murmur is idle. Hold your dictation key to speak.',
        announce: false,
        recording: false,
      }
    case 'listening':
      return {
        shape: 'waveform',
        width: BAR.listeningWidth,
        height: BAR.height,
        background: BAR_BACKGROUND,
        border: BAR_LISTENING_BORDER,
        label: '',
        glow: BAR_GLOW.listening,
        handsFree: event.handsFree,
        command: event.command,
        ariaLabel: event.command
          ? 'Listening — speak how to edit your selection'
          : event.handsFree
            ? 'Listening, hands-free mode'
            : 'Listening',
        announce: true,
        recording: false,
      }
    case 'processing':
      return {
        shape: 'shimmer',
        width: BAR.processingWidth,
        height: BAR.height,
        background: BAR_BACKGROUND,
        border: BAR_BORDER,
        label: '',
        glow: null,
        handsFree: false,
        command: event.command,
        ariaLabel: event.command
          ? 'Editing your selection'
          : event.stage === 'polishing'
            ? 'Polishing your words'
            : 'Transcribing',
        announce: true,
        recording: false,
      }
    case 'inserting':
      return {
        shape: 'shimmer',
        width: BAR.insertingWidth,
        height: BAR.height,
        background: BAR_BACKGROUND,
        border: BAR_BORDER,
        label: '',
        glow: null,
        handsFree: false,
        command: false,
        ariaLabel: 'Inserting text',
        announce: true,
        recording: false,
      }
    case 'inserted':
      return {
        shape: 'check',
        width: BAR.insertedWidth,
        height: BAR.height,
        background: BAR_BACKGROUND,
        border: BAR_BORDER,
        label: '',
        glow: BAR_GLOW.inserted,
        handsFree: false,
        command: false,
        ariaLabel: `Inserted ${event.charCount} characters`,
        announce: true,
        recording: false,
      }
    case 'error':
      // The short, code-keyed label — never the event's `message`. See
      // DICTATION_ERROR_LABEL: the message can be a full instruction or an
      // unbounded string from an engine, and putting either here grew the pill
      // until it truncated away the part that told the user what to do. The
      // long form still reaches the user, through the Hub toast and (below)
      // through the pill's own aria-label.
      return {
        shape: 'message',
        width: errorWidth(DICTATION_ERROR_LABEL[event.code]),
        height: BAR.height,
        background: BAR_ERROR_BACKGROUND,
        border: BAR_ERROR_BORDER,
        label: DICTATION_ERROR_LABEL[event.code],
        glow: BAR_GLOW.error,
        handsFree: false,
        command: false,
        ariaLabel: event.message,
        announce: true,
        recording: false,
      }
  }
}

// ---------------------------------------------------------------------------
// The corner orb
// ---------------------------------------------------------------------------

/**
 * The orb's appearance for one dictation event.
 *
 * Everything but the geometry is the pill's — same shapes, same colours, same
 * aria labels — because they are two drawings of one state machine, and a user
 * who switches styles should not have to relearn what green means.
 */
export interface NubVisual extends Omit<BarVisual, 'width' | 'height'> {
  /** Radius of the quarter-disc, in CSS px, measured from the screen corner. */
  radius: number
}

export function describeNub(event: DictationEvent, hovered = false, recording = false): NubVisual {
  const base = describeBase(event)
  const radius = Math.min(NUB.maxRadius, nubRadius(event) + (hovered ? NUB.hoverGrowth : 0))
  const { width: _width, height: _height, ...rest } = base
  return { ...rest, radius, recording }
}

/** Out, or in. The orb has exactly two sizes — see {@link NUB.activeRadius}. */
function nubRadius(event: DictationEvent): number {
  return event.state === 'idle' ? NUB.idleRadius : NUB.activeRadius
}

// ---------------------------------------------------------------------------
// The start / stop flourish
// ---------------------------------------------------------------------------

/** A ring blooming outward as dictation starts, or collapsing as it stops. */
export type Flourish = 'start' | 'stop'

/**
 * Which flourish — if any — a state transition earns.
 *
 * Only the edges of `listening` count. Not `processing`, not `inserted`: those
 * already have their own signals (the shimmer, the ✓), and a ring on every
 * transition would turn a punctuation mark into wallpaper. This is the moment
 * the user's key press either took or did not, which is the one thing they
 * cannot otherwise confirm without looking away from what they are typing into.
 */
export function flourishFor(
  previous: DictationEvent['state'],
  next: DictationEvent['state'],
): Flourish | null {
  if (previous === next) return null
  if (next === 'listening') return 'start'
  if (previous === 'listening') return 'stop'
  return null
}

/** ~6.2 px per character at 11 px type, plus padding and the warning glyph. */
export function errorWidth(message: string): number {
  const measured = Math.round(70 + message.length * 6.2)
  return Math.min(BAR.errorMaxWidth, Math.max(BAR.errorMinWidth, measured))
}

function clampWidth(width: number): number {
  return Math.min(BAR.maxWidth, Math.round(width))
}

// ---------------------------------------------------------------------------
// Momentary states
// ---------------------------------------------------------------------------

/**
 * `inserted` and `error` are momentary: main emits them and immediately settles
 * the machine back to `idle`. The Bar has to hold them anyway — a ✓ that
 * vanishes in 40 ms is not a confirmation, and PLAN §2.1 gives the error pill
 * ~2.5 s. So the renderer keeps showing the momentary event until its hold
 * expires, then shows whatever the machine has moved on to.
 *
 * Pure and clock-injected: `now` is always passed in, never read here.
 */
export class BarPresenter {
  #latest: DictationEvent = { state: 'idle' }
  #momentary: { event: DictationEvent; until: number } | null = null

  receive(event: DictationEvent, now: number): void {
    const hold = holdMsFor(event)
    if (hold > 0) {
      this.#momentary = { event, until: now + hold }
      // The machine settles to idle when it emits a momentary event, but it
      // does NOT emit that idle — `RESTING_STATE` moves silently. Without this
      // line the presenter would fall back to the stale pre-momentary event
      // (`inserting`, usually) when the hold expires, and the pill would say
      // "Inserting…" forever after every successful dictation.
      this.#latest = { state: 'idle' }
      return
    }
    this.#latest = event
    // A new utterance beginning cancels a lingering ✓ or error immediately.
    if (event.state !== 'idle') this.#momentary = null
  }

  /** What the pill should be showing at `now`. */
  present(now: number): DictationEvent {
    const momentary = this.#momentary
    if (momentary && momentary.until > now) return momentary.event
    if (momentary) this.#momentary = null
    return this.#latest
  }

  /** When the next change happens with no further input, or `null`. */
  expiresAt(): number | null {
    return this.#momentary?.until ?? null
  }
}

export function holdMsFor(event: DictationEvent): number {
  if (event.state === 'inserted') return BAR.insertedHoldMs
  if (event.state === 'error') return BAR.errorHoldMs
  return 0
}

/**
 * Whether the pill should be on screen at all (PLAN §2.1 visibility modes).
 *
 * Main also hides and shows the *window*; this is the renderer agreeing with it,
 * so a Bar that is visible for any other reason (a stale window, a dev build
 * with the window forced open) still respects the user's choice.
 */
export function isBarVisible(
  mode: BarVisibility,
  event: DictationEvent,
  recording = false,
): boolean {
  // A recording in progress overrides every visibility preference, including
  // Hidden. Someone else is being recorded, and the person who started it must
  // be able to see that at a glance without opening anything — a silent
  // recorder with no indicator is the behaviour this feature must never have.
  if (recording) return true
  switch (mode) {
    case 'always':
      return true
    case 'hidden':
      return false
    case 'showWhileDictating':
      return event.state !== 'idle'
  }
}
