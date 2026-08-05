import { describe, expect, it } from 'vitest'

import type { DictationEvent } from '@murmur/shared'

import {
  BAR,
  BAR_BACKGROUND,
  BAR_ERROR_BACKGROUND,
  BarPresenter,
  describeBar,
  errorWidth,
  holdMsFor,
  isBarVisible,
} from '../src/renderer/bar/visual'

/**
 * The Bar is built on a machine with no display, so its geometry is asserted
 * rather than eyeballed. Every number below traces to PLAN §2.1.
 */

const listening: DictationEvent = { state: 'listening', handsFree: false, level: 0.5 }
const processing: DictationEvent = { state: 'processing', stage: 'transcribing' }
const inserted: DictationEvent = { state: 'inserted', charCount: 27, method: 'paste' }
const failed: DictationEvent = { state: 'error', code: 'no-speech', message: "Didn't catch that" }

describe('describeBar', () => {
  it('renders the idle capsule at the spec size', () => {
    const visual = describeBar({ state: 'idle' })
    expect(visual.width).toBe(64)
    expect(visual.height).toBe(22)
    expect(visual.shape).toBe('dots')
    expect(visual.background).toBe(BAR_BACKGROUND)
  })

  it('expands to ~160 px with a waveform while listening', () => {
    const visual = describeBar(listening)
    expect(visual.width).toBe(160)
    expect(visual.shape).toBe('waveform')
    expect(visual.handsFree).toBe(false)
  })

  it('shows the hands-free indicator only in hands-free mode', () => {
    expect(describeBar({ ...listening, handsFree: true }).handsFree).toBe(true)
    expect(describeBar({ ...listening, handsFree: true }).ariaLabel).toContain('hands-free')
  })

  it('collapses the bars into a shimmer while processing and inserting', () => {
    expect(describeBar(processing).shape).toBe('shimmer')
    expect(describeBar({ state: 'inserting' }).shape).toBe('shimmer')
  })

  it('names the polishing stage for assistive technology', () => {
    expect(describeBar({ state: 'processing', stage: 'polishing' }).ariaLabel).toContain(
      'Polishing',
    )
  })

  it('pulses a check for an insertion', () => {
    const visual = describeBar(inserted)
    expect(visual.shape).toBe('check')
    expect(visual.ariaLabel).toBe('Inserted 27 characters')
  })

  it('tints warm red and carries the message on failure', () => {
    const visual = describeBar(failed)
    expect(visual.shape).toBe('message')
    expect(visual.background).toBe(BAR_ERROR_BACKGROUND)
    expect(visual.label).toBe("Didn't catch that")
  })

  it('widens on hover to make room for the controls, and grows slightly', () => {
    const resting = describeBar(listening)
    const hovered = describeBar(listening, true)
    expect(hovered.width).toBe(resting.width + BAR.hoverWidth)
    expect(hovered.height).toBe(BAR.hoverHeight)
    expect(hovered.shape).toBe(resting.shape)
  })

  it('never exceeds the Bar window width, even hovering a long error', () => {
    const long = { ...failed, message: 'x'.repeat(200) } satisfies DictationEvent
    expect(describeBar(long, true).width).toBeLessThanOrEqual(BAR.maxWidth)
    expect(describeBar(long, true).width).toBeLessThanOrEqual(360)
  })

  it('keeps the idle state silent for screen readers, and announces the rest', () => {
    expect(describeBar({ state: 'idle' }).announce).toBe(false)
    for (const event of [listening, processing, inserted, failed]) {
      expect(describeBar(event).announce).toBe(true)
    }
  })
})

describe('errorWidth', () => {
  it('sizes to the message within bounds', () => {
    expect(errorWidth('')).toBe(BAR.errorMinWidth)
    expect(errorWidth('Mic in use')).toBe(BAR.errorMinWidth)
    expect(errorWidth('x'.repeat(60))).toBe(BAR.errorMaxWidth)
  })

  it('grows monotonically with the message', () => {
    const short = errorWidth('Mic in use')
    const medium = errorWidth('Secure field — Murmur cannot type here')
    expect(medium).toBeGreaterThanOrEqual(short)
  })
})

describe('BarPresenter', () => {
  it('holds an insertion long enough for the check to be seen', () => {
    const presenter = new BarPresenter()
    presenter.receive(inserted, 1000)
    presenter.receive({ state: 'idle' }, 1010)

    expect(presenter.present(1200).state).toBe('inserted')
    expect(presenter.present(1000 + BAR.insertedHoldMs + 1).state).toBe('idle')
  })

  it('holds an error for ~2.5 s even though main settles to idle at once', () => {
    const presenter = new BarPresenter()
    presenter.receive(failed, 0)
    presenter.receive({ state: 'idle' }, 5)

    expect(presenter.present(2000)).toEqual(failed)
    expect(presenter.present(BAR.errorHoldMs).state).toBe('idle')
  })

  it('lets a new utterance interrupt a lingering error', () => {
    const presenter = new BarPresenter()
    presenter.receive(failed, 0)
    presenter.receive(listening, 100)
    expect(presenter.present(120)).toEqual(listening)
  })

  it('reports when it will next change on its own', () => {
    const presenter = new BarPresenter()
    expect(presenter.expiresAt()).toBeNull()
    presenter.receive(failed, 500)
    expect(presenter.expiresAt()).toBe(500 + BAR.errorHoldMs)
  })

  it('passes ordinary states straight through', () => {
    const presenter = new BarPresenter()
    presenter.receive(listening, 0)
    expect(presenter.present(0)).toEqual(listening)
    presenter.receive(processing, 10)
    expect(presenter.present(10)).toEqual(processing)
  })
})

describe('holdMsFor', () => {
  it('only holds the two momentary states', () => {
    expect(holdMsFor(inserted)).toBe(BAR.insertedHoldMs)
    expect(holdMsFor(failed)).toBe(BAR.errorHoldMs)
    expect(holdMsFor(listening)).toBe(0)
    expect(holdMsFor({ state: 'idle' })).toBe(0)
  })
})

describe('isBarVisible', () => {
  it('follows the three visibility modes', () => {
    expect(isBarVisible('showWhileDictating', { state: 'idle' })).toBe(false)
    expect(isBarVisible('showWhileDictating', listening)).toBe(true)
    expect(isBarVisible('always', { state: 'idle' })).toBe(true)
    expect(isBarVisible('hidden', listening)).toBe(false)
  })
})

describe('the spec numbers themselves', () => {
  it('keeps the waveform inside PLAN §2.1 24–32 bars at 2 px + 2 px', () => {
    expect(BAR.waveformBars).toBeGreaterThanOrEqual(24)
    expect(BAR.waveformBars).toBeLessThanOrEqual(32)
    expect(BAR.waveformBarWidth).toBe(2)
    expect(BAR.waveformBarGap).toBe(2)
  })

  it('morphs in ~150 ms and dismisses errors in ~2.5 s', () => {
    expect(BAR.morphMs).toBe(150)
    expect(BAR.errorHoldMs).toBe(2500)
  })

  it('fits 28 bars inside the listening capsule', () => {
    const waveform = BAR.waveformBars * (BAR.waveformBarWidth + BAR.waveformBarGap)
    expect(waveform).toBeLessThan(BAR.listeningWidth)
  })
})
