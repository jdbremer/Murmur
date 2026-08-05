import { describe, expect, it } from 'vitest'

import {
  clamp01,
  METER_CEILING_DB,
  METER_FLOOR_DB,
  normaliseLevel,
} from '../src/renderer/audio/meter'

describe('normaliseLevel', () => {
  it('maps silence to 0 and full scale to 1', () => {
    expect(normaliseLevel(0)).toBe(0)
    expect(normaliseLevel(1)).toBe(1)
  })

  it('rejects garbage without throwing', () => {
    expect(normaliseLevel(-0.5)).toBe(0)
    expect(normaliseLevel(Number.NaN)).toBe(0)
    expect(normaliseLevel(Number.POSITIVE_INFINITY)).toBe(1)
  })

  it('pins the floor and ceiling of the dB window', () => {
    const floor = Math.pow(10, METER_FLOOR_DB / 20)
    const ceiling = Math.pow(10, METER_CEILING_DB / 20)
    expect(normaliseLevel(floor)).toBeCloseTo(0, 6)
    expect(normaliseLevel(ceiling)).toBeCloseTo(1, 6)
    // Below the floor there is nothing to show; above the ceiling it is pinned.
    expect(normaliseLevel(floor / 2)).toBe(0)
    expect(normaliseLevel(ceiling * 1.5)).toBe(1)
  })

  it('puts conversational speech in the usable middle of the range', () => {
    const speech = normaliseLevel(0.05)
    expect(speech).toBeGreaterThan(0.25)
    expect(speech).toBeLessThan(0.85)
  })

  it('is monotonic', () => {
    let previous = -1
    for (const amplitude of [0.001, 0.01, 0.05, 0.1, 0.3, 0.6, 1]) {
      const level = normaliseLevel(amplitude)
      expect(level).toBeGreaterThanOrEqual(previous)
      previous = level
    }
  })
})

describe('clamp01', () => {
  it('clamps and swallows non-finite values', () => {
    expect(clamp01(-1)).toBe(0)
    expect(clamp01(0.5)).toBe(0.5)
    expect(clamp01(2)).toBe(1)
    expect(clamp01(Number.NaN)).toBe(0)
  })
})
