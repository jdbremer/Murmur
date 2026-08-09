import { describe, expect, it } from 'vitest'

import {
  BAR_HEIGHT,
  BAR_MARGIN_BOTTOM,
  BAR_WIDTH,
  barWindowBounds,
  NUB_HEIGHT,
  NUB_OVERHANG,
  NUB_WIDTH,
  type DisplayRects,
} from '../src/main/windows/bar-layout'
import { NUB } from '../src/renderer/bar/visual'

/**
 * Where the indicator's window lands.
 *
 * Asserted rather than eyeballed for the same reason the pill's geometry is:
 * this runs on machines with no display, and a window placed a few pixels off
 * the corner is the difference between "peeking out from behind the screen" and
 * "floating near the screen edge".
 */

/** A 1440 × 900 laptop with a 70 px Dock and a 25 px menu bar. */
const laptop: DisplayRects = {
  bounds: { x: 0, y: 0, width: 1440, height: 900 },
  workArea: { x: 0, y: 25, width: 1440, height: 805 },
}

/** A second display to the right, with no Dock or menu bar of its own. */
const external: DisplayRects = {
  bounds: { x: 1440, y: -180, width: 2560, height: 1440 },
  workArea: { x: 1440, y: -180, width: 2560, height: 1440 },
}

describe('the pill', () => {
  it('centres on the display and clears the Dock', () => {
    const bounds = barWindowBounds(laptop, { style: 'pill', corner: 'bottomLeft' })
    expect(bounds.width).toBe(BAR_WIDTH)
    expect(bounds.height).toBe(BAR_HEIGHT)
    expect(bounds.x + BAR_WIDTH / 2).toBe(720)
    // Above the work area's bottom edge, not the panel's — otherwise the
    // capsule sits on top of the Dock icons it covers.
    expect(bounds.y + BAR_HEIGHT + BAR_MARGIN_BOTTOM).toBe(830)
  })

  it('ignores the corner setting', () => {
    const left = barWindowBounds(laptop, { style: 'pill', corner: 'bottomLeft' })
    const right = barWindowBounds(laptop, { style: 'pill', corner: 'bottomRight' })
    expect(left).toEqual(right)
  })

  it('follows a display that does not start at the origin', () => {
    const bounds = barWindowBounds(external, { style: 'pill', corner: 'bottomLeft' })
    expect(bounds.x + BAR_WIDTH / 2).toBe(1440 + 1280)
    expect(bounds.y + BAR_HEIGHT + BAR_MARGIN_BOTTOM).toBe(-180 + 1440)
  })
})

/**
 * Where the *screen's* corner falls inside the corner window, which is what
 * everything in the renderer is positioned against. The window deliberately
 * overhangs, so this is not the window's own corner.
 */
function screenCorner(
  bounds: { x: number; y: number; width: number; height: number },
  corner: 'bottomLeft' | 'bottomRight',
): { x: number; y: number } {
  return {
    // Flush horizontally; the overhang is vertical only.
    x: corner === 'bottomLeft' ? bounds.x : bounds.x + bounds.width,
    y: bounds.y + bounds.height - NUB_OVERHANG,
  }
}

describe('the corner orb', () => {
  it('puts the panel’s own bottom-left corner inside the window', () => {
    const bounds = barWindowBounds(laptop, { style: 'corner', corner: 'bottomLeft' })
    // `bounds`, not `workArea`: the orb has to touch the physical corner or it
    // stops reading as something behind the screen. Clearing the Dock the way
    // the pill does would leave it floating 70 px up.
    expect(screenCorner(bounds, 'bottomLeft')).toEqual({ x: 0, y: 900 })
  })

  it('mirrors into the bottom-right corner', () => {
    const bounds = barWindowBounds(laptop, { style: 'corner', corner: 'bottomRight' })
    expect(screenCorner(bounds, 'bottomRight')).toEqual({ x: 1440, y: 900 })
  })

  it('lands on the corner of whichever display it is given', () => {
    const left = barWindowBounds(external, { style: 'corner', corner: 'bottomLeft' })
    expect(screenCorner(left, 'bottomLeft')).toEqual({ x: 1440, y: -180 + 1440 })

    const right = barWindowBounds(external, { style: 'corner', corner: 'bottomRight' })
    expect(screenCorner(right, 'bottomRight')).toEqual({ x: 1440 + 2560, y: -180 + 1440 })
  })

  it('hangs below the screen by exactly the overhang, and never sideways past it', () => {
    // The overhang is the whole reason the orb keeps a sharp point: it puts
    // macOS's window-corner rounding off the panel. Sideways it must not move
    // at all — a frame outside its own display is the kind of window macOS
    // treats specially when handing windows out to Spaces, and that cost the
    // orb its "visible everywhere" behaviour once already.
    for (const corner of ['bottomLeft', 'bottomRight'] as const) {
      for (const display of [laptop, external]) {
        const bounds = barWindowBounds(display, { style: 'corner', corner })
        expect(bounds.width).toBe(NUB_WIDTH)
        expect(bounds.height).toBe(NUB_HEIGHT + NUB_OVERHANG)
        expect(bounds.x).toBeGreaterThanOrEqual(display.bounds.x)
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(display.bounds.x + display.bounds.width)
        expect(bounds.y + bounds.height).toBe(
          display.bounds.y + display.bounds.height + NUB_OVERHANG,
        )
      }
    }
  })

  it('gives the renderer the same overhang main used', () => {
    // Two constants, one number: main sizes the window by it and the renderer
    // positions everything against it. Drift and the orb sits off the corner
    // by the difference.
    expect(NUB.overhang).toBe(NUB_OVERHANG)
  })

  it('still leaves room for everything drawn inside it', () => {
    // The orb grows from the screen corner, which is `NUB_OVERHANG` inside the
    // window, so the usable box is the nominal one.
    expect(NUB.maxRadius).toBeLessThan(Math.min(NUB_WIDTH, NUB_HEIGHT))
  })
})
