import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  isReachable,
  readWindowState,
  restoreBounds,
  writeWindowState,
  type WindowState,
} from '../src/main/windows/window-state'

const LIMITS = { minWidth: 860, minHeight: 560, defaultWidth: 1040, defaultHeight: 700 }
const DEFAULTS = { bounds: { width: 1040, height: 700 }, maximized: false }

const display = (x: number, y: number, width: number, height: number) => ({
  workArea: { x, y, width, height },
})

/** A single 1920×1080 screen with the menu bar taken off the top. */
const LAPTOP = [display(0, 25, 1920, 1055)]
/** The laptop plus an ultrawide to its left, which is where negative x comes from. */
const TWO_SCREENS = [...LAPTOP, display(-3440, 0, 3440, 1440)]

const saved = (overrides: Partial<WindowState> = {}): WindowState => ({
  x: 100,
  y: 100,
  width: 1200,
  height: 800,
  maximized: false,
  ...overrides,
})

describe('restoreBounds', () => {
  it('falls back to the default when there is nothing saved', () => {
    expect(restoreBounds(null, LAPTOP, LIMITS)).toEqual(DEFAULTS)
    expect(restoreBounds(undefined, LAPTOP, LIMITS)).toEqual(DEFAULTS)
  })

  it('falls back rather than trusting a corrupt or partial file', () => {
    expect(restoreBounds({ x: 1 }, LAPTOP, LIMITS)).toEqual(DEFAULTS)
    expect(restoreBounds('nope', LAPTOP, LIMITS)).toEqual(DEFAULTS)
    expect(restoreBounds({ ...saved(), width: Number.NaN }, LAPTOP, LIMITS)).toEqual(DEFAULTS)
    expect(restoreBounds({ ...saved(), maximized: 'yes' }, LAPTOP, LIMITS)).toEqual(DEFAULTS)
  })

  it('restores a sane geometry exactly', () => {
    expect(restoreBounds(saved(), LAPTOP, LIMITS)).toEqual({
      bounds: { x: 100, y: 100, width: 1200, height: 800 },
      maximized: false,
    })
  })

  it('carries the maximized flag back', () => {
    expect(restoreBounds(saved({ maximized: true }), LAPTOP, LIMITS).maximized).toBe(true)
  })

  it('refuses a size below the window minimums', () => {
    expect(restoreBounds(saved({ width: 400 }), LAPTOP, LIMITS)).toEqual(DEFAULTS)
    expect(restoreBounds(saved({ height: 200 }), LAPTOP, LIMITS)).toEqual(DEFAULTS)
  })

  it('refuses a size no display could have produced', () => {
    // Replaying a bug rather than restoring a window.
    expect(restoreBounds(saved({ width: 9000, height: 9000 }), LAPTOP, LIMITS)).toEqual(DEFAULTS)
  })

  describe('the monitor that went away', () => {
    it('drops a position that is now entirely off-screen', () => {
      // Saved on an ultrawide to the left; restored on the laptop alone. This
      // is the bug the whole module exists for: without the check the window
      // opens where nothing can reach it.
      const onUltrawide = saved({ x: -2400, y: 300 })
      expect(restoreBounds(onUltrawide, LAPTOP, LIMITS)).toEqual(DEFAULTS)
    })

    it('keeps that same position while the monitor is still plugged in', () => {
      const onUltrawide = saved({ x: -2400, y: 300 })
      expect(restoreBounds(onUltrawide, TWO_SCREENS, LIMITS).bounds).toMatchObject({ x: -2400 })
    })

    it('keeps a window the user deliberately nudged half off the edge', () => {
      const halfOff = saved({ x: 1300, y: 500, width: 1200, height: 800 })
      expect(restoreBounds(halfOff, LAPTOP, LIMITS).bounds).toMatchObject({ x: 1300 })
    })

    it('falls back when there are no displays at all', () => {
      expect(restoreBounds(saved(), [], LIMITS)).toEqual(DEFAULTS)
    })
  })
})

describe('isReachable', () => {
  const bounds = (x: number, y: number) => ({ x, y, width: 1000, height: 700 })

  it('accepts a window fully on screen', () => {
    expect(isReachable(bounds(100, 100), LAPTOP)).toBe(true)
  })

  it('accepts a window mostly off the right edge but still grabbable', () => {
    expect(isReachable(bounds(1800, 100), LAPTOP)).toBe(true)
  })

  it('rejects a window with only a sliver showing', () => {
    // 20px is not enough to put a pointer on.
    expect(isReachable(bounds(1900, 100), LAPTOP)).toBe(false)
  })

  it('rejects a window above the top of the work area', () => {
    expect(isReachable(bounds(100, -690), LAPTOP)).toBe(false)
  })

  it('is satisfied by any one display, not all of them', () => {
    expect(isReachable(bounds(-3000, 200), TWO_SCREENS)).toBe(true)
  })
})

describe('reading and writing', () => {
  let directory: string

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'murmur-window-'))
  })
  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  it('round-trips', () => {
    const path = join(directory, 'nested', 'window-state.json')
    writeWindowState(path, saved({ maximized: true }))
    expect(readWindowState(path)).toEqual(saved({ maximized: true }))
  })

  it('returns null for a file that is not there', () => {
    expect(readWindowState(join(directory, 'missing.json'))).toBeNull()
  })

  it('returns null rather than throwing on a corrupt file', () => {
    const path = join(directory, 'window-state.json')
    writeFileSync(path, '{ not json', 'utf8')
    expect(readWindowState(path)).toBeNull()
  })

  it('does not throw when the path cannot be written', () => {
    // Losing a remembered size must never take the app down with it.
    expect(() =>
      writeWindowState('/proc/definitely/not/writable/state.json', saved()),
    ).not.toThrow()
  })
})
