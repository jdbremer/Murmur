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
  /**
   * The resting sliver.
   *
   * Much smaller than the 64 x 22 the pill shipped with, and deliberately so:
   * at rest this is an *indicator*, not a control. It sits over whatever the
   * user is working in all day, and the less of their screen it occupies the
   * better. Everything it used to offer is now one hover away, at a size worth
   * clicking (see {@link CLUSTER}).
   */
  idleWidth: 44,
  idleHeight: 8,
  /**
   * Height once there is something to show — a waveform, a shimmer, a ✓, a
   * message. Still thinner than the old resting pill.
   */
  activeHeight: 18,
  /** Listening. */
  listeningWidth: 148,
  processingWidth: 120,
  insertingWidth: 104,
  insertedWidth: 88,
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
  waveformMaxHeight: 10,
  /** One shimmer sweep across the pill while processing. */
  shimmerPeriodMs: 1100,
} as const

/** Near-black, per PLAN §2.1. */
export const BAR_BACKGROUND = 'rgba(17,17,23,0.94)'
/** Warm red for the error state. */
export const BAR_ERROR_BACKGROUND = 'rgba(72,20,22,0.95)'
export const BAR_BORDER = 'rgba(255,255,255,0.10)'
/**
 * The resting sliver's outline — much brighter than the active border. At rest
 * the capsule is empty and tiny; the outline *is* the pill, exactly as in the
 * reference product, where the idle state reads as a drawn ring rather than a
 * filled blob.
 */
export const BAR_IDLE_BORDER = 'rgba(255,255,255,0.32)'
/**
 * The resting sliver's fill — noticeably more translucent than the active
 * capsule. In the reference the idle pill is a drawn ring with the wallpaper
 * dimly visible through it; a solid black blob reads as a hole in the screen.
 */
export const BAR_IDLE_BACKGROUND = 'rgba(18,18,23,0.60)'
/**
 * The capsule's edge while it is actually hearing something — brighter, and
 * *cooled* towards the listening glow's indigo rather than plain white, so the
 * rim and the halo read as one light source instead of two coincidences.
 */
export const BAR_LISTENING_BORDER = 'rgba(186,196,255,0.30)'
export const BAR_ERROR_BORDER = 'rgba(255,148,132,0.35)'
/**
 * The capsule's shadow stack — the half of the material that sells it.
 *
 * Five layers, each with one job: a 1 px contact shadow that seats the capsule
 * on the screen, a mid-distance shadow that gives it body, a wide soft ambient
 * that lifts it off whatever is behind it, an inset top light (the glass
 * highlight), and a half-pixel inner ring that reads as the polished edge of
 * the glass. Collapsing these into two layers is what made the old pill look
 * like a screenshot of a pill.
 */
export const BAR_SHADOW =
  '0 1px 2px rgba(0,0,0,0.34), 0 6px 16px rgba(0,0,0,0.35), 0 18px 44px rgba(0,0,0,0.42), ' +
  'inset 0 1px 0 rgba(255,255,255,0.09), inset 0 0 0 0.5px rgba(255,255,255,0.05)'

/** The cluster buttons' lighter stack — a 30 px chip does not cast a 44 px shadow. */
export const CLUSTER_SHADOW =
  '0 1px 2px rgba(0,0,0,0.30), 0 4px 12px rgba(0,0,0,0.30), 0 12px 28px rgba(0,0,0,0.34), ' +
  'inset 0 1px 0 rgba(255,255,255,0.10)'

/**
 * A soft state-coloured rim glow layered onto {@link BAR_SHADOW}: cool while
 * listening, green for the ✓, warm for an error. Transitioned by the renderer,
 * so states bleed into each other instead of snapping.
 */
export const BAR_GLOW = {
  listening: '0 0 30px rgba(129,140,248,0.36)',
  inserted: '0 0 26px rgba(110,231,168,0.30)',
  error: '0 0 26px rgba(248,113,113,0.28)',
} as const

/** The start / stop ring's stroke and glow — the listening indigo. */
export const BAR_FLOURISH_BORDER = 'rgba(129,140,248,0.7)'
export const BAR_FLOURISH_GLOW = '0 0 14px rgba(129,140,248,0.32)'

/**
 * The ambient halo *behind* the capsule — a blurred radial wash on the desktop
 * itself. {@link BAR_GLOW} hugs the rim; this one falls on the wallpaper
 * around the pill, which is what makes a state change read as light coming on
 * rather than as a div being recoloured. It breathes while listening, flashes
 * once for the ✓, and smoulders steadily for an error.
 */
export const BAR_HALO = {
  listening: 'rgba(105,110,245,0.55)',
  inserted: 'rgba(74,222,128,0.50)',
  error: 'rgba(248,113,113,0.45)',
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
 * Hover is deliberately *not* an input here any more. The pill used to widen on
 * hover to fit three glyphs inside itself, which meant the thing you were
 * pointing at moved and then had controls crammed into it. It now gets out of
 * the way instead: the renderer collapses this pill and puts {@link
 * describeCluster}'s buttons in its place, at a size worth clicking.
 */
export function describeBar(event: DictationEvent, recording = false): BarVisual {
  return { ...describeBase(event), recording }
}

function describeBase(event: DictationEvent): BarVisual {
  switch (event.state) {
    case 'idle':
      return {
        shape: 'dots',
        width: BAR.idleWidth,
        height: BAR.idleHeight,
        background: BAR_IDLE_BACKGROUND,
        border: BAR_IDLE_BORDER,
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
        height: BAR.activeHeight,
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
        height: BAR.activeHeight,
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
        height: BAR.activeHeight,
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
        height: BAR.activeHeight,
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
        height: BAR.activeHeight,
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

/** ~6.2 px per character at 11 px type, plus padding and the warning glyph. */
export function errorWidth(message: string): number {
  const measured = Math.round(70 + message.length * 6.2)
  return Math.min(BAR.errorMaxWidth, Math.max(BAR.errorMinWidth, measured))
}

function clampWidth(width: number): number {
  return Math.min(BAR.maxWidth, Math.round(width))
}

// ---------------------------------------------------------------------------
// The hover cluster
// ---------------------------------------------------------------------------

/**
 * Geometry of the floating buttons that replace the pill on hover.
 *
 * A labelled primary button at a real click target size, plus round chips for
 * the rest. The old design put three 18 px glyphs *inside* a 22 px capsule,
 * which is smaller than any platform's minimum touch target and gave the most
 * common action — start dictating — no button at all.
 */
export const CLUSTER = {
  /** The round buttons. */
  chipSize: 34,
  gap: 8,
  /** The floating label above the hovered button ("Dictate fn"). */
  tooltipHeight: 28,
  tooltipGap: 8,
  /**
   * How long the pointer must rest on the pill before the buttons open.
   *
   * Hover *intent*, and it is what separates "responsive" from "touchy": with
   * zero delay the row fired for every pointer that merely crossed the bottom
   * of the screen, and the swap played dozens of times an hour uninvited.
   * ~100 ms is imperceptible when you meant it and still filters most
   * pass-throughs when you did not.
   */
  openDelayMs: 100,
  /**
   * How long the row survives the pointer stepping outside before it closes.
   *
   * The forgiveness window: slipping 2 px past the edge mid-reach no longer
   * yanks the buttons away. Deliberately longer than the open delay — losing
   * UI you were using is worse than briefly seeing UI you are done with.
   */
  closeGraceMs: 300,
  /** The pill's cross-fade under the morphing row. */
  fadeMs: 160,
  /**
   * How long the row lingers after the close fires, animating out. Before
   * this existed the cluster unmounted on the frame the hover ended, which
   * was the single cheapest-looking moment on the whole surface.
   *
   * There is deliberately no per-button stagger. The row morphs in as ONE
   * unit, scaling up out of the pill's silhouette and shrinking back into it
   * on the way out — continuity of shape is what makes it read as the pill
   * *becoming* the buttons rather than being replaced by them.
   */
  leaveMs: 140,
} as const

export type ClusterAction = 'dictate' | 'stop' | 'cancel' | 'scratchpad' | 'mic' | 'hub'

export interface ClusterButton {
  action: ClusterAction
  /** The tooltip text and the accessible name. */
  label: string
  tone: 'default' | 'accent' | 'destructive'
}

export interface ClusterSpec {
  /** The round buttons, left to right. */
  chips: ClusterButton[]
  width: number
  height: number
}

/**
 * Which buttons the cluster shows for the current state.
 *
 * One row of round buttons, exactly as the reference product draws it; the
 * label is not printed on the button but floats above the hovered one as a
 * tooltip ("Dictate fn"). Three layouts, and the reasoning behind the split is
 * about what the mouse can honestly do:
 *
 *  - **At rest** the cluster is a launcher: dictate, jot a note, pick a mic,
 *    open the Hub.
 *  - **Hands-free** was started by a click (or a double-tap), so it can be
 *    ended by one: Stop finishes the utterance and inserts it. Discard sits
 *    beside it for throwing the utterance away instead.
 *  - **Anything else in flight** — a physically-held key, transcription,
 *    insertion — offers Cancel only. There is no "stop and keep" for a held
 *    key: the way to end that is to let go, and a Stop button that silently
 *    meant Cancel would be a lie about what the click does.
 *
 * The momentary `inserted` and `error` states fall through to the resting
 * layout: they are already over, and a Cancel button for a finished dictation
 * cancels nothing.
 */
export function describeCluster(event: DictationEvent): ClusterSpec {
  const chips = clusterButtons(event)
  return {
    chips,
    width: clampWidth(chips.length * CLUSTER.chipSize + (chips.length - 1) * CLUSTER.gap),
    height: CLUSTER.chipSize,
  }
}

function clusterButtons(event: DictationEvent): ClusterButton[] {
  if (event.state === 'listening' && event.handsFree) {
    return [
      { action: 'stop', label: 'Stop', tone: 'accent' },
      { action: 'cancel', label: 'Discard', tone: 'destructive' },
      { action: 'mic', label: 'Microphone', tone: 'default' },
    ]
  }

  if (event.state === 'listening' || event.state === 'processing' || event.state === 'inserting') {
    return [
      { action: 'cancel', label: 'Cancel', tone: 'destructive' },
      { action: 'mic', label: 'Microphone', tone: 'default' },
    ]
  }

  return [
    { action: 'dictate', label: 'Dictate', tone: 'accent' },
    { action: 'scratchpad', label: 'New note', tone: 'default' },
    { action: 'mic', label: 'Microphone', tone: 'default' },
    { action: 'hub', label: 'Open Murmur', tone: 'default' },
  ]
}

// ---------------------------------------------------------------------------
// The corner orb ("nub")
// ---------------------------------------------------------------------------

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

/**
 * The corner orb's presentation (the `corner` Bar style).
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

/**
 * The pointer region the Bar window claims while the cluster is up.
 *
 * Fixed, and larger than any cluster, on purpose. The pill is a 10 px sliver;
 * hovering it collapses it to nothing and replaces it with a 30 px row, so
 * hit-testing against the *live* geometry moves the boundary out from under the
 * pointer and the two states flicker against each other. Testing against a
 * stable rectangle instead means the hover you started can only be ended by
 * actually leaving it.
 */
export const HOVER_ZONE = {
  width: BAR.maxWidth,
  // Buttons + the tooltip floating above them, plus slack.
  height: 100,
} as const

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
