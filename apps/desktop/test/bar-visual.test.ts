import { describe, expect, it } from 'vitest'

import { DICTATION_ERROR_LABEL, type DictationEvent } from '@murmur/shared'

import {
  BAR,
  BAR_BACKGROUND,
  BAR_ERROR_BACKGROUND,
  BAR_IDLE_BACKGROUND,
  BarPresenter,
  CLUSTER,
  describeBar,
  describeCluster,
  errorWidth,
  holdMsFor,
  HOVER_ZONE,
  isBarVisible,
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
  it('rests as a thin, translucent, outlined sliver', () => {
    const visual = describeBar({ state: 'idle' })
    expect(visual.width).toBe(BAR.idleWidth)
    expect(visual.height).toBe(BAR.idleHeight)
    expect(visual.shape).toBe('dots')
    // The ring is the idle statement: translucent fill, bright outline —
    // never the active capsule's near-solid black.
    expect(visual.background).toBe(BAR_IDLE_BACKGROUND)
    expect(visual.background).not.toBe(BAR_BACKGROUND)
  })

  it('grows only when it has something to show', () => {
    // The sliver is an indicator; every other state is showing the user
    // something and gets the taller capsule.
    expect(describeBar({ state: 'idle' }).height).toBe(BAR.idleHeight)
    for (const event of [
      listening,
      processing,
      { state: 'inserting' } as const,
      inserted,
      failed,
    ]) {
      expect(describeBar(event).height).toBe(BAR.activeHeight)
    }
  })

  it('expands with a waveform while listening', () => {
    const visual = describeBar(listening)
    expect(visual.width).toBe(BAR.listeningWidth)
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

  it('never exceeds the Bar window width, even for a long error', () => {
    const long = { ...failed, message: 'x'.repeat(200) } satisfies DictationEvent
    expect(describeBar(long).width).toBeLessThanOrEqual(BAR.maxWidth)
    expect(describeBar(long).width).toBeLessThanOrEqual(360)
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

  it('keeps the waveform inside the thinner capsule', () => {
    expect(BAR.waveformMaxHeight).toBeLessThan(BAR.activeHeight)
  })

  it('gives the cluster buttons a real click target', () => {
    // The old design put 18px glyphs inside the capsule, under every platform's
    // minimum target size. Nothing in the cluster may go back below ~32px —
    // 34 is the tuned value, sized against the reference by eye.
    expect(CLUSTER.chipSize).toBeGreaterThanOrEqual(32)
  })

  it('keeps the swap choreography inside a blink', () => {
    // Hover UI that makes the pointer wait reads as broken, not premium — and
    // the exit must never outlast the entrance: dismissals are always faster.
    expect(CLUSTER.fadeMs).toBeLessThanOrEqual(200)
    expect(CLUSTER.leaveMs).toBeLessThanOrEqual(CLUSTER.fadeMs)
  })

  it('waits for hover intent, and forgives more than it demands', () => {
    // Instant-open reads as touchy: every pointer crossing the screen bottom
    // played the swap. The open delay filters pass-throughs; the close grace
    // must be at least as long, because losing UI you were using is worse
    // than briefly keeping UI you are done with.
    expect(CLUSTER.openDelayMs).toBeGreaterThanOrEqual(100)
    expect(CLUSTER.openDelayMs).toBeLessThanOrEqual(200)
    expect(CLUSTER.closeGraceMs).toBeGreaterThanOrEqual(CLUSTER.openDelayMs)
  })

  it('keeps the hover zone bigger than anything drawn inside it', () => {
    // The zone is what stops the swap flickering; if the row or its tooltip
    // could reach past it, moving along the buttons would drop the hover.
    for (const event of [
      { state: 'idle' } as const,
      listening,
      { ...listening, handsFree: true },
    ]) {
      const spec = describeCluster(event)
      expect(spec.width).toBeLessThanOrEqual(HOVER_ZONE.width)
      expect(spec.height + CLUSTER.tooltipGap + CLUSTER.tooltipHeight).toBeLessThan(
        HOVER_ZONE.height,
      )
    }
  })
})

describe('describeCluster', () => {
  const actions = (spec: ReturnType<typeof describeCluster>): string[] =>
    spec.chips.map((chip) => chip.action)

  it('offers the launcher set at rest', () => {
    expect(actions(describeCluster({ state: 'idle' }))).toEqual([
      'dictate',
      'scratchpad',
      'mic',
      'hub',
    ])
  })

  it('offers Stop only for hands-free, where a click can honestly end it', () => {
    const spec = describeCluster({ ...listening, handsFree: true })
    expect(actions(spec)).toEqual(['stop', 'cancel', 'mic'])
    expect(spec.chips[0]!.label).toBe('Stop')
  })

  it('offers Cancel — never Stop — while a held key is the thing listening', () => {
    // There is no "stop and keep" for a key the user is physically holding:
    // the way to end that is to let go. A Stop button that quietly meant
    // Cancel would misdescribe what the click does.
    const spec = describeCluster(listening)
    expect(actions(spec)).toEqual(['cancel', 'mic'])
    expect(spec.chips[0]!.tone).toBe('destructive')
  })

  it('offers Cancel while transcribing and inserting', () => {
    for (const event of [processing, { state: 'inserting' } as const]) {
      expect(actions(describeCluster(event))).toEqual(['cancel', 'mic'])
    }
  })

  it('falls back to the launcher for the momentary states — they are already over', () => {
    for (const event of [inserted, failed]) {
      expect(describeCluster(event).chips[0]!.action).toBe('dictate')
    }
  })

  it('measures itself from its own buttons', () => {
    const spec = describeCluster({ state: 'idle' })
    expect(spec.width).toBe(4 * CLUSTER.chipSize + 3 * CLUSTER.gap)
    expect(spec.height).toBe(CLUSTER.chipSize)
  })

  it('names every button — the tooltip is the only place the words appear', () => {
    for (const event of [{ state: 'idle' } as const, listening, processing]) {
      for (const chip of describeCluster(event).chips) {
        expect(chip.label.length).toBeGreaterThan(0)
      }
    }
  })
})
