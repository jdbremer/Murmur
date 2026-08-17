import { describe, expect, it } from 'vitest'

import {
  ATTACK_MS,
  BAR_INTERVAL_MS,
  barHeights,
  CHECK_PEAK_SCALE,
  CHECK_START_SCALE,
  checkPulseScale,
  DECAY_MS,
  LevelEnvelope,
  meterHeights,
  shimmerPosition,
  WaveformHistory,
} from '../src/renderer/bar/level'
import { BAR } from '../src/renderer/bar/visual'

describe('LevelEnvelope', () => {
  it('starts silent', () => {
    expect(new LevelEnvelope().value).toBe(0)
  })

  it('rises faster than it falls — attack fast, decay smooth (PLAN §2.1)', () => {
    const rising = new LevelEnvelope(0)
    rising.push(1)
    const gained = rising.advance(50)

    const falling = new LevelEnvelope(1)
    falling.push(0)
    const lost = 1 - falling.advance(50)

    expect(gained).toBeGreaterThan(lost)
    expect(ATTACK_MS).toBeLessThan(DECAY_MS)
  })

  it('reaches ~63% of the step in one time constant', () => {
    const envelope = new LevelEnvelope(0)
    envelope.push(1)
    expect(envelope.advance(ATTACK_MS)).toBeCloseTo(1 - Math.exp(-1), 3)
  })

  it('is frame-rate independent: many small steps match one big one', () => {
    const stepped = new LevelEnvelope(0)
    stepped.push(1)
    for (let index = 0; index < 10; index += 1) stepped.advance(10)

    const jumped = new LevelEnvelope(0)
    jumped.push(1)
    jumped.advance(100)

    expect(stepped.value).toBeCloseTo(jumped.value, 6)
  })

  it('settles exactly on the target instead of asymptoting forever', () => {
    const envelope = new LevelEnvelope(0)
    envelope.push(0.5)
    envelope.advance(10_000)
    expect(envelope.value).toBe(0.5)
  })

  it('clamps whatever the stream sends', () => {
    const envelope = new LevelEnvelope()
    envelope.push(9)
    expect(envelope.target).toBe(1)
    envelope.push(-3)
    expect(envelope.target).toBe(0)
    envelope.push(Number.NaN)
    expect(envelope.target).toBe(0)
  })

  it('ignores non-positive time steps', () => {
    const envelope = new LevelEnvelope(0.25)
    envelope.push(1)
    expect(envelope.advance(0)).toBe(0.25)
    expect(envelope.advance(-16)).toBe(0.25)
  })
})

describe('WaveformHistory', () => {
  it('holds one bar per waveform column', () => {
    expect(new WaveformHistory().size).toBe(BAR.waveformBars)
    expect(new WaveformHistory().values()).toHaveLength(BAR.waveformBars)
  })

  it('scrolls: the newest sample is last', () => {
    const history = new WaveformHistory(4, 10)
    history.push(0.1)
    history.push(0.2)
    expect(history.values()).toEqual([0, 0, 0.1, 0.2])
  })

  it('appends one bar per interval, not per animation frame', () => {
    const history = new WaveformHistory(8, BAR_INTERVAL_MS)
    // Six 60 fps frames ≈ 100 ms ≈ three 30 Hz intervals.
    let pushed = 0
    for (let index = 0; index < 6; index += 1) pushed += history.advance(16.7, 0.5)
    expect(pushed).toBe(3)
  })

  it('fills a stall rather than teleporting', () => {
    const history = new WaveformHistory(4, 10)
    expect(history.advance(35, 1)).toBe(3)
    expect(history.values()).toEqual([0, 1, 1, 1])
  })

  it('never spins on a very long stall', () => {
    const history = new WaveformHistory(4, 10)
    expect(history.advance(10_000, 1)).toBe(4)
    expect(history.values()).toEqual([1, 1, 1, 1])
  })

  it('resets to silence', () => {
    const history = new WaveformHistory(3, 10)
    history.push(1)
    history.reset()
    expect(history.values()).toEqual([0, 0, 0])
  })
})

describe('barHeights', () => {
  it('maps silence to the minimum and full scale to the maximum', () => {
    const silent = barHeights([0, 0, 0])
    expect(silent.every((height) => height === BAR.waveformMinHeight)).toBe(true)

    const loud = barHeights([1, 1, 1])
    expect(Math.max(...loud)).toBeCloseTo(BAR.waveformMaxHeight, 5)
  })

  it('tapers the edges so the waveform fades into the capsule', () => {
    const heights = barHeights(Array.from({ length: 9 }, () => 1))
    const first = heights[0] ?? 0
    const middle = heights[4] ?? 0
    expect(first).toBeLessThan(middle)
  })

  it('stays inside the capsule at every level', () => {
    for (const level of [0, 0.2, 0.5, 0.9, 1]) {
      for (const height of barHeights(Array.from({ length: 28 }, () => level))) {
        expect(height).toBeGreaterThanOrEqual(BAR.waveformMinHeight)
        expect(height).toBeLessThanOrEqual(BAR.waveformMaxHeight)
      }
    }
  })

  it('is monotonic in level', () => {
    const quiet = barHeights([0.2])[0] ?? 0
    const loud = barHeights([0.8])[0] ?? 0
    expect(loud).toBeGreaterThan(quiet)
  })
})

describe('shimmerPosition', () => {
  it('sweeps left to right and repeats', () => {
    const start = shimmerPosition(0, 1000)
    const middle = shimmerPosition(500, 1000)
    expect(start).toBeLessThan(middle)
    expect(shimmerPosition(1000, 1000)).toBeCloseTo(start, 6)
  })

  it('enters and leaves off the ends of the pill', () => {
    expect(shimmerPosition(0, 1000)).toBeLessThan(0)
    expect(shimmerPosition(999, 1000)).toBeGreaterThan(1)
  })
})

describe('checkPulseScale', () => {
  it('starts small, overshoots, and settles at 1', () => {
    expect(checkPulseScale(0)).toBe(CHECK_START_SCALE)
    expect(checkPulseScale(320)).toBe(1)
    expect(checkPulseScale(1000)).toBe(1)
    const peak = Math.max(...Array.from({ length: 33 }, (_, i) => checkPulseScale(i * 10)))
    expect(peak).toBeGreaterThan(1)
    expect(peak).toBeLessThanOrEqual(CHECK_PEAK_SCALE)
  })

  it('grows monotonically into the peak', () => {
    let previous = 0
    for (let ms = 0; ms <= 128; ms += 16) {
      const scale = checkPulseScale(ms)
      expect(scale).toBeGreaterThanOrEqual(previous)
      previous = scale
    }
  })
})

describe("meterHeights — the pill's redesigned meter", () => {
  it('is perfectly still in silence, at exactly the resting dot height', () => {
    // The whole continuity trick: at level 0 the meter *is* the resting row of
    // dots, so a quiet moment mid-dictation costs no motion at all. The time
    // argument must not be able to change that.
    for (const t of [0, 250, 1_000, 7_777]) {
      const heights = meterHeights(0, 12, t)
      expect(heights).toHaveLength(12)
      for (const h of heights) expect(h).toBeCloseTo(BAR.waveformMinHeight, 6)
    }
  })

  it('is symmetric about the centre', () => {
    // No direction, so nothing to mistake for progress. Compared without the
    // wobble, which is deliberately not symmetric.
    const heights = meterHeights(0.8, 12, 0, { min: 0, max: 1 })
    const noWobble = meterHeights(0.8, 12, 0)
    expect(noWobble).toHaveLength(12)
    const shape = (i: number): number => {
      const last = 11
      const d = Math.abs(i / last - 0.5) * 2
      return 1 - 0.55 * Math.pow(d, 1.6)
    }
    for (let i = 0; i < 6; i += 1) {
      expect(shape(i)).toBeCloseTo(shape(11 - i), 10)
    }
    expect(heights.length).toBe(12)
  })

  it('is tallest in the middle and shortest at the edges', () => {
    const heights = meterHeights(1, 12, 0)
    const middle = heights[5] ?? 0
    expect(middle).toBeGreaterThan(heights[0] ?? 0)
    expect(middle).toBeGreaterThan(heights[11] ?? 0)
  })

  it('never leaves the capsule at any level', () => {
    for (const level of [0, 0.15, 0.4, 0.75, 1, 1.5, -3, Number.NaN]) {
      for (const h of meterHeights(level, 12, 400)) {
        expect(h).toBeGreaterThanOrEqual(BAR.waveformMinHeight - 1e-9)
        expect(h).toBeLessThanOrEqual(BAR.waveformMaxHeight + 1e-9)
      }
    }
  })

  it('rises with the level', () => {
    const quiet = meterHeights(0.2, 12, 0)[5] ?? 0
    const loud = meterHeights(0.9, 12, 0)[5] ?? 0
    expect(loud).toBeGreaterThan(quiet)
  })

  it('undulates over time while speech is present', () => {
    // Bars must not rise as one block; a per-bar phase is what makes it read
    // as a voice rather than a single pulsing shape.
    const a = meterHeights(0.8, 12, 0)
    const b = meterHeights(0.8, 12, 500)
    expect(a).not.toEqual(b)
  })
})
