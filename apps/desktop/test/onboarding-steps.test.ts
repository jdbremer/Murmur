import { describe, expect, it } from 'vitest'

import type { HardwareReport, ModelEntry } from '@murmur/shared'

import {
  buildSteps,
  isLastStep,
  isSkippable,
  nextStep,
  previousStep,
  progressLabel,
  starterOptions,
} from '../src/renderer/hub/onboarding/steps'

/** A minimal catalog entry; only the fields the starter logic reads. */
function entry(id: string, kind: 'stt' | 'polish', sizeBytes: number): ModelEntry {
  return {
    id,
    kind,
    engine: kind === 'stt' ? 'whisper-cpp' : 'llama-cpp',
    displayName: id,
    org: 'Test',
    origin: 'US',
    license: 'MIT',
    sizeBytes,
    ramTierGb: 8,
    languages: ['en'],
    quant: null,
    files: [],
    recommended: false,
    notes: null,
  } as unknown as ModelEntry
}

const CATALOG: ModelEntry[] = [
  entry('whisper-large-v3-turbo-q5_0', 'stt', 574_000_000),
  entry('whisper-small-en', 'stt', 487_000_000),
  entry('whisper-tiny-en', 'stt', 77_000_000),
  entry('gemma-3-4b-it-qat-q4_0', 'polish', 2_363_000_000),
  entry('gemma-3-1b-it-qat-q4_0', 'polish', 720_000_000),
]

function hardware(fits: Record<string, 'runsWell' | 'tight' | 'notRecommended'>): HardwareReport {
  return { fits } as unknown as HardwareReport
}

describe('buildSteps', () => {
  it('adds the macOS dictation-conflict screen only for mac + fn', () => {
    expect(buildSteps({ platform: 'mac', hotkeyKey: 'fn' })).toContain('dictationConflict')
    expect(buildSteps({ platform: 'mac', hotkeyKey: 'rightCmd' })).not.toContain(
      'dictationConflict',
    )
    expect(buildSteps({ platform: 'linux', hotkeyKey: 'fn' })).not.toContain('dictationConflict')
  })

  it('always starts at welcome and ends at done', () => {
    const steps = buildSteps({ platform: 'mac', hotkeyKey: 'fn' })
    expect(steps[0]).toBe('welcome')
    expect(steps[steps.length - 1]).toBe('done')
  })
})

describe('navigation', () => {
  const steps = buildSteps({ platform: 'mac', hotkeyKey: 'fn' })

  it('walks forward and back without ever leaving the list', () => {
    expect(nextStep(steps, 'welcome')).toBe('microphone')
    expect(previousStep(steps, 'microphone')).toBe('welcome')
    expect(previousStep(steps, 'welcome')).toBe('welcome')
    expect(nextStep(steps, 'done')).toBe('done')
  })

  it('labels progress as counted by humans', () => {
    expect(progressLabel(steps, 'welcome')).toBe(`Step 1 of ${steps.length}`)
    expect(isLastStep(steps, 'done')).toBe(true)
  })

  it('lets permissions and models be skipped, but not welcome or done', () => {
    expect(isSkippable('microphone')).toBe(true)
    expect(isSkippable('models')).toBe(true)
    expect(isSkippable('welcome')).toBe(false)
    expect(isSkippable('done')).toBe(false)
  })
})

describe('starterOptions', () => {
  it('offers the recommended pair when the hardware advisor approves it', () => {
    const options = starterOptions(hardware({}), CATALOG)
    expect(options[0]?.sttId).toBe('whisper-large-v3-turbo-q5_0')
    expect(options[0]?.polishId).toBe('gemma-3-4b-it-qat-q4_0')
    expect(options[1]?.sttId).toBe('whisper-small-en')
  })

  it('steps the recommendation down when the advisor says the big pair is tight', () => {
    const options = starterOptions(hardware({ 'gemma-3-4b-it-qat-q4_0': 'tight' }), CATALOG)
    expect(options[0]?.sttId).toBe('whisper-small-en')
    // The smaller option becomes the minimal pair, with polishing off.
    expect(options[1]?.sttId).toBe('whisper-tiny-en')
    expect(options[1]?.polishId).toBeNull()
  })

  it('falls back to the smallest model of a kind when a pinned id is missing', () => {
    const noTurbo = CATALOG.filter((candidate) => candidate.id !== 'whisper-large-v3-turbo-q5_0')
    const options = starterOptions(hardware({}), noTurbo)
    // The exact id is gone; something of the right kind is still offered.
    expect(options[0]?.sttId).toBe('whisper-tiny-en')
  })

  it('offers nothing rather than throwing on an empty catalog', () => {
    expect(starterOptions(null, [])).toEqual([])
  })
})
