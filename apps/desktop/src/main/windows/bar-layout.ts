import type { BarCorner, BarStyle } from '@murmur/shared'

/**
 * Where the Bar window goes, in pixels — the whole of it, and none of Electron.
 *
 * Split out of `bar.ts` so it can be unit-tested: that module imports
 * `BrowserWindow` and `screen` at the top level, and the arithmetic here is
 * exactly the part worth asserting on a machine with no display. `bar.ts` reads
 * the display from `screen` and hands the rectangles straight in.
 */

/** Structurally Electron's `Rectangle`, without importing Electron for it. */
export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** The display the pill is being placed on, as `screen` reports it. */
export interface DisplayRects {
  /** The whole panel, Dock and menu bar included. */
  bounds: Rect
  /** What is left after the Dock and menu bar. */
  workArea: Rect
}

export interface BarLayout {
  style: BarStyle
  corner: BarCorner
}

export const DEFAULT_BAR_LAYOUT: BarLayout = { style: 'pill', corner: 'bottomLeft' }

// ---------------------------------------------------------------------------
// Pill: bottom-centre
// ---------------------------------------------------------------------------

export const BAR_WIDTH = 360
/**
 * Taller than the capsule on purpose. The pill sits flush with the bottom of
 * the page; the space above it is where the hover cluster's tooltip stands
 * (~70 px of buttons + floating label) and where the mic picker opens above
 * that, so the window never has to resize mid-interaction (which on macOS
 * would fight the ~150 ms morph the pill is already animating). Everything
 * above the pill is transparent *and* click-through, so it costs the user
 * nothing.
 */
export const BAR_HEIGHT = 250
/** Gap between the pill and whatever is below it (PLAN §2.1). */
export const BAR_MARGIN_BOTTOM = 10

// ---------------------------------------------------------------------------
// Corner nub: flush into a bottom corner
// ---------------------------------------------------------------------------

/**
 * The corner window is smaller than the pill's but not small: the orb itself is
 * at most ~86 px across, and the rest is headroom for the tray (hover controls,
 * or the error label) and the mic picker stacked above it. Same reasoning as
 * `BAR_HEIGHT` — a window that resizes mid-hover fights the morph.
 */
export const NUB_WIDTH = 320
export const NUB_HEIGHT = 300

/**
 * How far the corner window hangs *below* the bottom of the screen.
 *
 * macOS rounds the corners of a frameless window, and that rounding clips
 * everything the page draws. The pill never noticed — it floats in the middle
 * of its window — but the orb is pinned to a corner, and the clip shaved its
 * point off into a leaf.
 *
 * The obvious lever is `roundedCorners: false`, and it is not worth reaching
 * for: it swaps the window's style mask for a borderless one, which Electron's
 * own docs note is no longer fullscreenable — and this window is an `NSPanel`
 * precisely so it can appear over full-screen Spaces (see `keepBarEverywhere`).
 * Trading that for a corner would be a poor bargain, and the combination is
 * untested.
 *
 * So the window is dropped below the screen instead. Its two bottom corners —
 * the rounded ones that matter — end up off-panel, the screen's bottom edge
 * lands this far inside the window, and the orb is anchored to *that* line.
 * Removing it puts the rounding straight back, so it is load-bearing rather
 * than defensive: verified on a real desktop, twice, in both directions.
 *
 * Downward only, deliberately. An earlier version also overhung sideways,
 * which put the window at a negative x — a frame outside the display it
 * belongs to. Nothing is gained by it: the clip is a small radius at the
 * window's own corner, and 24 px of vertical clearance already puts the orb's
 * corner clear of it.
 *
 * `NUB.overhang` in the renderer must agree with this, and `bar-layout.test.ts`
 * asserts it does.
 */
export const NUB_OVERHANG = 24

/**
 * Bottom-centre of the display under the cursor, or flush into one of its
 * bottom corners.
 *
 * The pill's vertical edge comes from `workArea`, so it clears the Dock instead
 * of landing on top of it. It used to measure against `bounds` — deliberately,
 * on the theory that a HUD should float over the Dock rather than dodge it —
 * but with the Dock at the bottom and not auto-hiding, that puts an opaque
 * capsule squarely over the icons it covers. Losing a Dock icon to a pill you
 * cannot move is worse than the small gap this leaves when the Dock is hidden.
 * A Dock on the left or right does not change `workArea`'s bottom edge, so
 * those setups land exactly where they always did.
 *
 * The **corner** style measures against `bounds` on both axes, and that is the
 * whole point of it: the orb has to touch the physical corner or it stops
 * looking like something behind the screen and starts looking like something
 * floating near it. A centred Dock does not reach the far corners; a Dock
 * pinned to the same side the orb is on does, which is what the left/right
 * choice is for.
 *
 * `x` for the pill stays measured against `bounds`: centred on the *screen* is
 * what reads as centred, and a 360 px capsule never reaches a side Dock anyway.
 */
export function barWindowBounds(display: DisplayRects, layout: BarLayout): Rect {
  const { bounds, workArea } = display
  if (layout.style === 'corner') {
    // Flush to the side the orb is on, and hanging `NUB_OVERHANG` below the
    // screen so the window's rounded bottom corners are off-panel. Horizontally
    // the frame stays inside the display, which keeps it an ordinary window as
    // far as Spaces are concerned.
    return {
      x: Math.round(
        layout.corner === 'bottomLeft' ? bounds.x : bounds.x + bounds.width - NUB_WIDTH,
      ),
      y: Math.round(bounds.y + bounds.height - NUB_HEIGHT),
      width: NUB_WIDTH,
      height: NUB_HEIGHT + NUB_OVERHANG,
    }
  }
  return {
    x: Math.round(bounds.x + (bounds.width - BAR_WIDTH) / 2),
    y: Math.round(workArea.y + workArea.height - BAR_HEIGHT - BAR_MARGIN_BOTTOM),
    width: BAR_WIDTH,
    height: BAR_HEIGHT,
  }
}
