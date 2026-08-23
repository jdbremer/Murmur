/**
 * Surfaces and elevation (PLAN §2.2.6) — the one place that decides what a
 * raised thing looks like.
 *
 * Before this existed, every card in the Hub wrote its own
 * `rounded-card border border-line bg-surface p-5`, and the differences
 * between them were accidents rather than decisions: some had a shadow, some
 * did not, hover states appeared on two cards out of thirty. Components now
 * ask for a *level* and get whatever that level currently means.
 *
 * Two independent axes, deliberately not collapsed into one:
 *
 *  - **surface** is what colour the thing is. In dark mode this is the whole
 *    of elevation (a black shadow on a near-black canvas is invisible), which
 *    is why a card inside the content pane has to be `raised` rather than
 *    `base` — both are `#16161b` otherwise and the card disappears into the
 *    pane.
 *  - **elevation** is how far off the page it sits, and resolves to the
 *    `--elevation-*` variables in theme.css, which each theme defines its own
 *    way.
 *
 * They travel together for cards but not for everything: the content pane is
 * `base` at elevation 1, a card inside it is `raised` at elevation 1, and a
 * toast is `raised` at elevation 3.
 */

/** 0 lies flat on the page; 3 floats clear of it. */
export type Elevation = 0 | 1 | 2 | 3

export type SurfaceLevel = 'sunken' | 'base' | 'raised'

/** Which semantic edge the surface carries, if any. */
export type SurfaceTone = 'default' | 'accent' | 'positive' | 'warning' | 'danger' | 'dashed'

export type SurfacePadding = 'none' | 'sm' | 'md' | 'lg'

const ELEVATION_CLASS: Record<Elevation, string> = {
  0: '',
  1: 'elev-1',
  2: 'elev-2',
  3: 'elev-3',
}

const SURFACE_CLASS: Record<SurfaceLevel, string> = {
  sunken: 'bg-surface-sunken',
  base: 'bg-surface',
  raised: 'bg-surface-raised',
}

const TONE_CLASS: Record<SurfaceTone, string> = {
  default: 'border-line',
  accent: 'border-accent/40',
  positive: 'border-positive/40',
  warning: 'border-warning/40',
  danger: 'border-danger/40',
  dashed: 'border-dashed border-line',
}

const PADDING_CLASS: Record<SurfacePadding, string> = {
  none: '',
  sm: 'p-3.5',
  md: 'p-5',
  lg: 'p-6',
}

/**
 * Every field takes an explicit `| undefined` so callers under
 * `exactOptionalPropertyTypes` can forward their own optional props straight
 * through — without it, `Card` has to rebuild this object one conditional
 * spread at a time.
 */
export interface SurfaceOptions {
  /** Default 1 — the resting rung. */
  elevation?: Elevation | undefined
  /** Default `raised`, because most surfaces in the Hub sit inside the pane. */
  surface?: SurfaceLevel | undefined
  tone?: SurfaceTone | undefined
  padding?: SurfacePadding | undefined
  /**
   * Lifts to the next rung on hover. Reserved for surfaces that are genuinely
   * a single click target — a card that merely *contains* buttons must not
   * lift, or the whole page twitches as the pointer crosses it.
   */
  interactive?: boolean | undefined
  /** Appended verbatim, for the one-off that the scale does not cover. */
  className?: string | undefined
}

/**
 * The full class string for a surface.
 *
 * `interactive` replaces the static elevation class rather than adding to it:
 * `elev-lift` already declares both rungs plus the transition between them,
 * and a static `elev-1` alongside it would win or lose depending on rule order
 * — exactly the kind of cascade collision that is invisible until it is not.
 */
export function surfaceClasses(options: SurfaceOptions = {}): string {
  const {
    elevation = 1,
    surface = 'raised',
    tone = 'default',
    padding = 'md',
    interactive = false,
    className = '',
  } = options

  return [
    'rounded-card border',
    TONE_CLASS[tone],
    SURFACE_CLASS[surface],
    PADDING_CLASS[padding],
    interactive ? 'elev-lift' : ELEVATION_CLASS[elevation],
    className,
  ]
    .filter(Boolean)
    .join(' ')
    .trim()
}
