import { describe, expect, it } from 'vitest'

import { surfaceClasses } from '../src/renderer/design/elevation'
import { nextSegmentIndex } from '../src/renderer/design/segmented'
import { skeletonDelay, skeletonWidths } from '../src/renderer/design/skeleton'
import { sparkline } from '../src/renderer/design/sparkline'

describe('surfaceClasses', () => {
  it('defaults to a resting raised card', () => {
    const classes = surfaceClasses().split(' ')
    expect(classes).toContain('bg-surface-raised')
    expect(classes).toContain('elev-1')
    expect(classes).toContain('border-line')
    expect(classes).toContain('rounded-card')
  })

  it('never emits a static rung alongside the hover lift', () => {
    // `elev-lift` declares both rungs and the transition between them; a
    // static `elev-1` next to it is a cascade collision waiting to happen.
    const classes = surfaceClasses({ interactive: true }).split(' ')
    expect(classes).toContain('elev-lift')
    expect(classes).not.toContain('elev-1')
    expect(classes).not.toContain('elev-2')
  })

  it('leaves no double or trailing space when a slot is empty', () => {
    // `elevation: 0` and `padding: 'none'` both contribute nothing; a naive
    // join leaves the gaps behind and every class string in the app grows a
    // ragged tail.
    expect(surfaceClasses({ elevation: 0 })).not.toMatch(/\s\s/)
    expect(surfaceClasses({ elevation: 0, padding: 'none' })).not.toMatch(/\s$/)
    expect(surfaceClasses({ elevation: 0 }).split(' ')).not.toContain('')
  })

  it('gives each surface level a distinct background', () => {
    const backgrounds = (['sunken', 'base', 'raised'] as const).map(
      (surface) => surfaceClasses({ surface }).match(/bg-\S+/)?.[0],
    )
    expect(new Set(backgrounds).size).toBe(3)
    expect(backgrounds).not.toContain(undefined)
  })

  it('carries the tone on the border, so the fill stays neutral', () => {
    expect(surfaceClasses({ tone: 'danger' })).toContain('border-danger/40')
    expect(surfaceClasses({ tone: 'danger' })).toContain('bg-surface-raised')
  })
})

describe('skeletonWidths', () => {
  it('is stable for a given index — a re-render must not reshuffle the lines', () => {
    expect(skeletonWidths(6)).toEqual(skeletonWidths(6))
    // And a longer list keeps the widths the shorter one already had.
    expect(skeletonWidths(9).slice(0, 5)).toEqual(skeletonWidths(6).slice(0, 5))
  })

  it('varies, rather than drawing one bar six times', () => {
    expect(new Set(skeletonWidths(6)).size).toBeGreaterThan(3)
  })

  it('stays inside the range, including the deliberately short last line', () => {
    for (const width of skeletonWidths(40, { min: 45, max: 96 })) {
      expect(width).toBeGreaterThanOrEqual(20)
      expect(width).toBeLessThanOrEqual(96)
    }
  })

  it('ends short, the way a paragraph does', () => {
    const widths = skeletonWidths(5)
    const last = widths[widths.length - 1] as number
    for (const width of widths.slice(0, -1)) expect(last).toBeLessThan(width)
  })

  it('does not rhyme with a second skeleton on the same screen', () => {
    expect(skeletonWidths(6, { seed: 1 })).not.toEqual(skeletonWidths(6, { seed: 2 }))
  })

  it('handles the degenerate counts', () => {
    expect(skeletonWidths(0)).toEqual([])
    expect(skeletonWidths(-3)).toEqual([])
    expect(skeletonWidths(1)).toHaveLength(1)
  })

  it('wraps the stagger so a long list does not end three seconds behind', () => {
    expect(skeletonDelay(0)).toBe(0)
    expect(skeletonDelay(6)).toBe(skeletonDelay(0))
    expect(Math.max(...Array.from({ length: 50 }, (_, i) => skeletonDelay(i)))).toBeLessThan(600)
  })
})

describe('sparkline', () => {
  it('has no geometry for an empty series', () => {
    expect(sparkline([])).toBeNull()
  })

  it('puts a flat series through the middle instead of dividing by zero', () => {
    const geometry = sparkline([4, 4, 4, 4], { height: 28, padding: 2 })
    expect(geometry).not.toBeNull()
    for (const point of geometry?.points ?? []) {
      expect(Number.isFinite(point.y)).toBe(true)
      expect(point.y).toBe(14)
    }
  })

  it('treats all-zero the same way — a week of silence is the common case', () => {
    const geometry = sparkline([0, 0, 0, 0, 0, 0, 0])
    expect(geometry?.line).not.toContain('NaN')
  })

  it('renders one reading as a dot, not a line', () => {
    const geometry = sparkline([7], { width: 96 })
    expect(geometry?.points).toHaveLength(1)
    expect(geometry?.points[0]?.x).toBe(48)
    expect(geometry?.area).toBe('')
  })

  it('spans the padded box and puts the peak above the trough', () => {
    const geometry = sparkline([0, 10, 5], { width: 100, height: 30, padding: 3 })
    const points = geometry?.points ?? []
    expect(points[0]?.x).toBe(3)
    expect(points[points.length - 1]?.x).toBe(97)
    // SVG y grows downward: the maximum is the smallest y.
    expect(points[1]?.y).toBeLessThan(points[0]?.y ?? 0)
    expect(points[0]?.y).toBe(27)
    expect(points[1]?.y).toBe(3)
  })

  it('closes the area along the baseline so the fill has a floor', () => {
    const geometry = sparkline([1, 5, 2], { height: 30 })
    expect(geometry?.area.endsWith('Z')).toBe(true)
    expect(geometry?.area).toContain('L 94 30')
  })

  it('emits finite coordinates only', () => {
    const geometry = sparkline([3, 9, 1, 8, 2, 7])
    expect(geometry?.line).toMatch(
      /^M [\d.-]+ [\d.-]+( C [\d.-]+ [\d.-]+ [\d.-]+ [\d.-]+ [\d.-]+ [\d.-]+)+$/,
    )
  })

  it('never leaves the range of its own data — a spike between zeroes must not dip below zero', () => {
    // The failure this exists for: Catmull-Rom through [0, 0, 500, 0, 0]
    // undershoots on both flat runs, and a chart of a non-negative quantity
    // that goes below its own floor is a false statement about the data.
    const height = 32
    const padding = 2
    const geometry = sparkline([0, 0, 500, 0, 0, 900, 0], { height, padding })
    const ys = [...(geometry?.line.matchAll(/[\d.-]+ ([\d.-]+)/g) ?? [])].map((m) => Number(m[1]))
    expect(ys.length).toBeGreaterThan(0)
    for (const y of ys) {
      expect(y).toBeGreaterThanOrEqual(padding)
      expect(y).toBeLessThanOrEqual(height - padding)
    }
  })

  it('holds that guarantee for noisy data too', () => {
    const values = [4, 91, 2, 77, 13, 68, 5, 99, 1, 50]
    const geometry = sparkline(values, { height: 40, padding: 3 })
    const ys = [...(geometry?.line.matchAll(/[\d.-]+ ([\d.-]+)/g) ?? [])].map((m) => Number(m[1]))
    for (const y of ys) {
      expect(y).toBeGreaterThanOrEqual(3)
      expect(y).toBeLessThanOrEqual(37)
    }
  })

  it('draws straight segments when asked for a polyline', () => {
    const straight = sparkline([0, 10, 0], { curve: 'linear' })
    expect(straight?.line).toBe('M 2 26 L 48 2 L 94 26')
  })

  it('reports the last point, which is the one worth marking', () => {
    const geometry = sparkline([1, 2, 9])
    expect(geometry?.last).toEqual(geometry?.points[2])
  })
})

describe('nextSegmentIndex', () => {
  it('wraps at both ends', () => {
    expect(nextSegmentIndex(0, 'ArrowLeft', 3)).toBe(2)
    expect(nextSegmentIndex(2, 'ArrowRight', 3)).toBe(0)
  })

  it('accepts the vertical axis too', () => {
    expect(nextSegmentIndex(1, 'ArrowUp', 3)).toBe(0)
    expect(nextSegmentIndex(1, 'ArrowDown', 3)).toBe(2)
  })

  it('jumps to the ends', () => {
    expect(nextSegmentIndex(1, 'Home', 4)).toBe(0)
    expect(nextSegmentIndex(1, 'End', 4)).toBe(3)
  })

  it('declines keys that are not its own, so the page keeps them', () => {
    expect(nextSegmentIndex(1, 'Tab', 3)).toBeNull()
    expect(nextSegmentIndex(1, 'a', 3)).toBeNull()
    expect(nextSegmentIndex(1, 'Enter', 3)).toBeNull()
  })

  it('survives an out-of-range or empty control', () => {
    expect(nextSegmentIndex(9, 'ArrowRight', 3)).toBe(0)
    expect(nextSegmentIndex(-4, 'ArrowLeft', 3)).toBe(2)
    expect(nextSegmentIndex(0, 'ArrowRight', 0)).toBeNull()
  })
})
