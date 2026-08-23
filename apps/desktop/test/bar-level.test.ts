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
  shimmerPosition,
  WaveformHistory,
  waveOffsets,
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

describe("waveOffsets — the pill's live wave", () => {
  it('is a dead-flat line in silence, whatever the clock says', () => {
    // Silence must cost no motion at all: the resting sliver is a hairline,
    // and at level 0 the wave is exactly that hairline, perfectly still.
    for (const t of [0, 300, 1_500, 9_999]) {
      for (const y of waveOffsets(0, t, 24)) expect(y).toBe(0)
    }
  })

  it('pins both ends to the centreline so it fades into the glass', () => {
    const offsets = waveOffsets(1, 400, 24)
    expect(offsets[0]).toBeCloseTo(0, 6)
    expect(offsets[offsets.length - 1]).toBeCloseTo(0, 6)
  })

  it('stays well inside the capsule at every level', () => {
    for (const level of [0, 0.3, 0.7, 1, 4, -2, Number.NaN]) {
      for (const y of waveOffsets(level, 700, 40)) {
        expect(Math.abs(y)).toBeLessThanOrEqual(BAR.waveAmplitude + 1e-9)
        // Never touching the rim of a 12 px capsule.
        expect(Math.abs(y)).toBeLessThan(BAR.activeHeight / 2)
      }
    }
  })

  it('swells with the voice', () => {
    const peak = (level: number): number => Math.max(...waveOffsets(level, 500, 40).map(Math.abs))
    expect(peak(0.9)).toBeGreaterThan(peak(0.3))
    expect(peak(0.3)).toBeGreaterThan(0)
  })

  it('travels: the same voice draws a different curve a moment later', () => {
    expect(waveOffsets(0.8, 0, 24)).not.toEqual(waveOffsets(0.8, 600, 24))
  })

  it('never simply repeats, so the crests do not read as a test signal', () => {
    const a = waveOffsets(0.8, 0, 32)
    const b = waveOffsets(0.8, BAR.wavePeriodMs, 32)
    expect(a.every((y, i) => Math.abs(y - (b[i] ?? 0)) < 1e-9)).toBe(false)
  })
})
