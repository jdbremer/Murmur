import { describe, expect, it } from 'vitest'

import { mixToMono } from '../src/renderer/hub/transcribe/downmix'

/**
 * The downmix is the one piece of decode arithmetic that is ours rather than
 * Chromium's, so it is the piece that gets pinned.
 */

describe('mixToMono', () => {
  it('averages stereo channels', () => {
    const left = new Float32Array([1, 0.5, -1])
    const right = new Float32Array([0, 0.5, 1])
    expect([...mixToMono([left, right], 3)]).toEqual([0.5, 0.5, 0])
  })

  it('copies mono rather than aliasing the decoder buffer', () => {
    const source = new Float32Array([0.1, 0.2])
    const out = mixToMono([source], 2)
    expect([...out]).toEqual([...source])
    out[0] = 9
    expect(source[0]).toBeCloseTo(0.1)
  })

  it('cannot clip what was not already clipped', () => {
    const loudLeft = new Float32Array([1, 1])
    const loudRight = new Float32Array([1, -1])
    const out = mixToMono([loudLeft, loudRight], 2)
    expect(Math.max(...out.map(Math.abs))).toBeLessThanOrEqual(1)
  })

  it('handles the empty case', () => {
    expect(mixToMono([], 0).length).toBe(0)
  })
})
