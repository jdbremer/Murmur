import { describe, expect, it } from 'vitest'

import { DICTATION_ERROR_LABEL, type DictationEvent } from '@murmur/shared'

import {
  BAR,
  BAR_BACKGROUND,
  BAR_ERROR_BACKGROUND,
  BarPresenter,
  describeBar,
  describeNub,
  errorWidth,
  flourishFor,
  holdMsFor,
  isBarVisible,
  NUB,
} from '../src/renderer/bar/visual'

/**
 * The Bar is built on a machine with no display, so its geometry is asserted
 * rather than eyeballed. Every number below traces to PLAN §2.1.
 */

const listening: DictationEvent = {
  state: 'listening',
  handsFree: false,
  level: 0.5,
  command: false,
}
const processing: DictationEvent = {
  state: 'processing',
  stage: 'transcribing',
  command: false,
}
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
    expect(
      describeBar({ state: 'processing', stage: 'polishing', command: false }).ariaLabel,
    ).toContain('Polishing')
  })

  it('pulses a check for an insertion', () => {
    const visual = describeBar(inserted)
    expect(visual.shape).toBe('check')
    expect(visual.ariaLabel).toBe('Inserted 27 characters')
  })

  it('tints warm red and shows the short label on failure', () => {
    const visual = describeBar(failed)
    expect(visual.shape).toBe('message')
    expect(visual.background).toBe(BAR_ERROR_BACKGROUND)
    expect(visual.label).toBe(DICTATION_ERROR_LABEL['no-speech'])
    // The long form is not lost — it is what assistive tech reads out.
    expect(visual.ariaLabel).toBe(failed.message)
  })

  it('never widens the pill for a long message, whatever its source', () => {
    // Regression: the pill used to render `event.message`, so a failure that
    // carried an instruction ("…Pick one in the Hub.") or an unbounded engine
    // string grew the capsule until it truncated away the actionable half.
    const wordy: DictationEvent = {
      state: 'error',
      code: 'stt-failed',
      message: 'No speech-to-text model is ready. Pick one in the Hub.',
    }
    const unbounded: DictationEvent = {
      state: 'error',
      code: 'unknown',
      message: `sidecar refused the request: ${'x'.repeat(400)}`,
    }
    expect(describeBar(wordy).width).toBe(BAR.errorMinWidth)
    expect(describeBar(unbounded).width).toBe(BAR.errorMinWidth)
  })

  it('keeps every error label short enough to leave the pill at its minimum', () => {
    // The whole point of the code→label map: no failure can grow the capsule.
    for (const label of Object.values(DICTATION_ERROR_LABEL)) {
      expect(errorWidth(label)).toBe(BAR.errorMinWidth)
    }
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

  it('glows only in the states that earn it', () => {
    expect(describeBar({ state: 'idle' }).glow).toBeNull()
    expect(describeBar(processing).glow).toBeNull()
    expect(describeBar({ state: 'inserting' }).glow).toBeNull()
    expect(describeBar(listening).glow).toContain('rgba(129,140,248')
    expect(describeBar(inserted).glow).toContain('rgba(110,231,168')
    expect(describeBar(failed).glow).toContain('rgba(248,113,113')
  })

  it('keeps the idle state silent for screen readers, and announces the rest', () => {
    expect(describeBar({ state: 'idle' }).announce).toBe(false)
    for (const event of [listening, processing, inserted, failed]) {
      expect(describeBar(event).announce).toBe(true)
    }
  })
})

describe('describeNub', () => {
  it('is the pill in polar coordinates — same shapes, same colours, same words', () => {
    for (const event of [{ state: 'idle' } as const, listening, processing, inserted, failed]) {
      const pill = describeBar(event)
      const orb = describeNub(event)
      expect(orb.shape).toBe(pill.shape)
      expect(orb.background).toBe(pill.background)
      expect(orb.border).toBe(pill.border)
      expect(orb.glow).toBe(pill.glow)
      expect(orb.label).toBe(pill.label)
      expect(orb.ariaLabel).toBe(pill.ariaLabel)
      expect(orb.announce).toBe(pill.announce)
    }
  })

  it('grows enough to read as listening, and not enough to be an event', () => {
    const idle = describeNub({ state: 'idle' }).radius
    const heard = describeNub(listening).radius
    expect(idle).toBe(NUB.idleRadius)
    expect(heard).toBe(NUB.activeRadius)
    // Both bounds are the design, and the upper one is the harder-won half:
    // earlier versions nearly tripled, and the growth itself became the event
    // — something lunged out of the corner on every key press. Big enough to
    // be unmistakable at a glance, small enough to stay furniture.
    expect(heard).toBeGreaterThan(idle * 1.5)
    expect(heard).toBeLessThan(idle * 2.1)
  })

  it('holds one size for every state but idle', () => {
    // The disc is entered once and left once. Sizing each state separately —
    // as the pill does, because it has a width to spend — made the corner of
    // the screen breathe in and out four times per utterance.
    const active = [listening, processing, { state: 'inserting' } as const, inserted, failed]
    for (const event of active) {
      expect(describeNub(event).radius).toBe(NUB.activeRadius)
      expect(describeNub(event, true).radius).toBe(NUB.activeRadius + NUB.hoverGrowth)
    }
    expect(describeNub({ state: 'idle' }).radius).toBe(NUB.idleRadius)
  })

  it('never grows past the window it is drawn in', () => {
    // The window is 320 × 300 (main/windows/bar-layout.ts) and the orb grows
    // out of a corner of it, so a radius near either dimension would clip.
    for (const event of [{ state: 'idle' } as const, listening, processing, inserted, failed]) {
      for (const hovered of [false, true]) {
        expect(describeNub(event, hovered).radius).toBeLessThanOrEqual(NUB.maxRadius)
      }
    }
    expect(NUB.maxRadius).toBeLessThan(300)
  })

  it('grows on hover, like the pill widens', () => {
    expect(describeNub(listening, true).radius).toBe(NUB.activeRadius + NUB.hoverGrowth)
    expect(describeNub(listening, true).shape).toBe(describeNub(listening).shape)
  })

  it('keeps the fan hidden until the orb is big enough to reveal it', () => {
    // The canvas is fixed-size and clipped by the disc, so the idle orb must be
    // smaller than the fan's inner radius or the rays peek out while nothing is
    // happening — and larger than the idle dots, or there is nothing to see.
    expect(NUB.idleRadius).toBeLessThan(NUB.fanRadius)
    expect(NUB.idleRadius).toBeGreaterThan(NUB.idleDotRadius + 2)
    // …and the active orb must clear the longest ray, or the fan is cropped.
    expect(NUB.activeRadius).toBeGreaterThan(NUB.fanRadius + NUB.rayMaxLength)
    // The canvas has to cover the largest disc it is ever clipped by.
    expect(NUB.canvas).toBeGreaterThanOrEqual(NUB.activeRadius + NUB.hoverGrowth)
  })

  it('keeps the corner state lights inside the smallest disc they can appear on', () => {
    // The dots sit 4 px and 11 px from the corner (Nub.tsx) and are 5 px across.
    // An idle orb is the smallest they ever have to fit inside.
    const furthest = Math.hypot(11 + 5, 4 + 5)
    expect(furthest).toBeLessThan(NUB.idleRadius)
  })

  it('carries the meeting-recording light, exactly as the pill does', () => {
    expect(describeNub(listening, false, true).recording).toBe(true)
    expect(describeNub(listening).recording).toBe(false)
  })
})

describe('flourishFor', () => {
  it('rings once on the way into listening and once on the way out', () => {
    expect(flourishFor('idle', 'listening')).toBe('start')
    expect(flourishFor('listening', 'processing')).toBe('stop')
    expect(flourishFor('listening', 'idle')).toBe('stop')
  })

  it('stays silent for every transition the user already has a signal for', () => {
    expect(flourishFor('processing', 'inserting')).toBeNull()
    expect(flourishFor('inserting', 'inserted')).toBeNull()
    expect(flourishFor('inserted', 'idle')).toBeNull()
    expect(flourishFor('processing', 'error')).toBeNull()
  })

  it('does not re-ring while listening carries on', () => {
    // `listening` re-fires with every level update; a ring per frame would be
    // a strobe rather than a flourish.
    expect(flourishFor('listening', 'listening')).toBeNull()
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

  it('settles to idle after the hold even though main never emits the idle', () => {
    // Regression: the machine's RESTING_STATE moves to idle silently when it
    // emits `inserted`/`error` — no trailing idle event arrives. The presenter
    // must not fall back to the stale pre-momentary event, or the pill reads
    // "Inserting…" forever after every successful dictation.
    const presenter = new BarPresenter()
    presenter.receive(listening, 0)
    presenter.receive({ state: 'processing', stage: 'transcribing', command: false }, 100)
    presenter.receive({ state: 'inserting' }, 200)
    presenter.receive(inserted, 300)

    expect(presenter.present(400).state).toBe('inserted')
    expect(presenter.present(300 + BAR.insertedHoldMs + 1).state).toBe('idle')
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

  /**
   * The interior shifts left by half `controlsWidth` so it stays centred in
   * what is left of the capsule. Shifting by half `hoverWidth` instead — the
   * growth rather than the footprint — put it 9px off-centre, which is exactly
   * the kind of thing that is easy to see and hard to name.
   *
   * Both numbers describe the controls, so a fourth button would move them
   * together and nothing here would catch a drift. This asserts the geometry
   * they are both derived from.
   */
  it('derives the controls footprint from the buttons that make it up', () => {
    const buttons = 3
    const buttonSize = 18
    const gap = 3
    const inset = 6
    expect(BAR.controlsWidth).toBe(buttons * buttonSize + (buttons - 1) * gap + inset)
  })

  it('leaves the capsule wider than the controls need, so they do not crowd it', () => {
    expect(BAR.hoverWidth).toBeGreaterThan(BAR.controlsWidth)
  })
})
