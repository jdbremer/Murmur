import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import type { Display } from 'electron'

/**
 * Remembering where a window was.
 *
 * The Hub opened at 1040 × 700 in the middle of the screen every single time,
 * however the user had left it. That is a small thing that reads as an
 * unfinished app: every other window on the machine comes back where it was.
 *
 * The interesting part is not the saving, it is the *validating*. A geometry
 * saved on a 34-inch monitor and restored on a laptop puts the window
 * completely off-screen, with no way to drag it back — the classic
 * restore-window bug, and the reason this is a tested pure function rather
 * than a JSON round-trip.
 */

export interface WindowState {
  x: number
  y: number
  width: number
  height: number
  maximized: boolean
}

export interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

export interface WindowStateLimits {
  minWidth: number
  minHeight: number
  defaultWidth: number
  defaultHeight: number
}

/** How much of the window has to be on a display for it to count as reachable. */
const MIN_VISIBLE_PX = 80

function isState(value: unknown): value is WindowState {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return (
    ['x', 'y', 'width', 'height'].every(
      (key) => typeof candidate[key] === 'number' && Number.isFinite(candidate[key]),
    ) && typeof candidate.maximized === 'boolean'
  )
}

/**
 * Bounds to actually open with, given what was saved and what displays exist
 * now.
 *
 * Returns the default size, centred by the caller (by omitting x/y), whenever
 * the saved state cannot be honoured: no state, corrupt state, a size below
 * the minimums, or a position that no longer lands on any display. Every one
 * of those is a real case — the last one is just a monitor being unplugged.
 */
export function restoreBounds(
  saved: unknown,
  displays: readonly Pick<Display, 'workArea'>[],
  limits: WindowStateLimits,
): { bounds: Partial<Bounds> & { width: number; height: number }; maximized: boolean } {
  const fallback = {
    bounds: { width: limits.defaultWidth, height: limits.defaultHeight },
    maximized: false,
  }

  if (!isState(saved)) return fallback
  if (saved.width < limits.minWidth || saved.height < limits.minHeight) return fallback
  // A window larger than every display is not a restore, it is a bug being
  // replayed.
  const widest = Math.max(0, ...displays.map((display) => display.workArea.width))
  const tallest = Math.max(0, ...displays.map((display) => display.workArea.height))
  if (saved.width > widest * 1.5 || saved.height > tallest * 1.5) return fallback

  if (!isReachable(saved, displays)) return fallback

  return {
    bounds: { x: saved.x, y: saved.y, width: saved.width, height: saved.height },
    maximized: saved.maximized,
  }
}

/**
 * Is enough of this rectangle on some display to grab with the pointer?
 *
 * Deliberately not "fully contained": a window the user deliberately nudged
 * half off the edge should come back exactly where they left it. The bar is
 * only that its title area can be reached.
 */
export function isReachable(
  bounds: Bounds,
  displays: readonly Pick<Display, 'workArea'>[],
): boolean {
  return displays.some((display) => {
    const area = display.workArea
    const overlapX =
      Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x)
    const overlapY =
      Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y)
    return overlapX >= MIN_VISIBLE_PX && overlapY >= MIN_VISIBLE_PX
  })
}

export function readWindowState(path: string): unknown {
  try {
    if (!existsSync(path)) return null
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    // A corrupt file is not worth a crash, and the fallback is a sensible
    // default window.
    return null
  }
}

/** Atomic, like the settings store: a torn write here loses the geometry. */
export function writeWindowState(path: string, state: WindowState): void {
  try {
    mkdirSync(dirname(path), { recursive: true })
    const temporary = `${path}.tmp`
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    renameSync(temporary, path)
  } catch {
    // Losing the remembered size is not worth surfacing to the user.
  }
}
