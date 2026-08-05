import type { HardwareFit, HardwareReport, HotkeyKey, ModelEntry } from '@murmur/shared'

import type { Platform } from '../../lib/platform'

/**
 * First-run sequence (PLAN §2.4) — the decisions, without the pixels.
 *
 * Which screens exist, in what order, and which pair of models a given machine
 * should be offered. Pure so that the branch a user actually walks (does the
 * double-`fn` warning appear? does an 8 GB Mac get the 2.4 GB polish model?) is
 * asserted in tests rather than discovered on someone's laptop.
 */

export type OnboardingStepId =
  | 'welcome'
  | 'microphone'
  | 'accessibility'
  | 'inputMonitoring'
  | 'models'
  | 'tutorial'
  | 'dictationConflict'
  | 'done'

export interface StepContext {
  platform: Platform
  hotkeyKey: HotkeyKey
}

/**
 * The screens, in order.
 *
 * The macOS built-in dictation conflict screen is conditional twice over: the
 * setting only exists on macOS, and it only collides when the user's key *is*
 * `fn` (PLAN §2.4.7, §4 "Conflict").
 */
export function buildSteps(context: StepContext): OnboardingStepId[] {
  const steps: OnboardingStepId[] = [
    'welcome',
    'microphone',
    'accessibility',
    'inputMonitoring',
    'models',
    'tutorial',
  ]
  if (context.platform === 'mac' && context.hotkeyKey === 'fn') steps.push('dictationConflict')
  steps.push('done')
  return steps
}

export function stepIndex(steps: readonly OnboardingStepId[], step: OnboardingStepId): number {
  return steps.indexOf(step)
}

export function nextStep(
  steps: readonly OnboardingStepId[],
  step: OnboardingStepId,
): OnboardingStepId {
  const index = stepIndex(steps, step)
  if (index < 0) return steps[0] ?? 'welcome'
  return steps[Math.min(index + 1, steps.length - 1)] ?? step
}

export function previousStep(
  steps: readonly OnboardingStepId[],
  step: OnboardingStepId,
): OnboardingStepId {
  const index = stepIndex(steps, step)
  if (index <= 0) return steps[0] ?? 'welcome'
  return steps[index - 1] ?? step
}

export function isLastStep(steps: readonly OnboardingStepId[], step: OnboardingStepId): boolean {
  return stepIndex(steps, step) === steps.length - 1
}

/** "Step 3 of 8" — progress, stated plainly. */
export function progressLabel(steps: readonly OnboardingStepId[], step: OnboardingStepId): string {
  const index = stepIndex(steps, step)
  return `Step ${Math.max(1, index + 1)} of ${steps.length}`
}

/** Steps a user may walk past without doing anything (PLAN §2.4: skippable, with a warning). */
export function isSkippable(step: OnboardingStepId): boolean {
  return (
    step === 'microphone' ||
    step === 'accessibility' ||
    step === 'inputMonitoring' ||
    step === 'models' ||
    step === 'tutorial'
  )
}

// ---------------------------------------------------------------------------
// Starter models
// ---------------------------------------------------------------------------

/** PLAN §17.2 / §14: one opinionated pair per hardware tier. */
const RECOMMENDED_PAIR = {
  stt: 'whisper-large-v3-turbo-q5_0',
  polish: 'gemma-3-4b-it-qat-q4_0',
} as const
const LOW_RAM_PAIR = { stt: 'whisper-small-en', polish: 'gemma-3-1b-it-qat-q4_0' } as const
/** Tier C (PLAN §14): the smallest thing that works, with polishing off. */
const MINIMAL_PAIR = { stt: 'whisper-tiny-en', polish: null } as const

export interface StarterOption {
  id: 'recommended' | 'smaller'
  title: string
  description: string
  sttId: string | null
  polishId: string | null
  /** Resolved catalog entries, in download order. */
  entries: ModelEntry[]
  /** Combined on-disk size of everything in this option. */
  totalBytes: number
}

/**
 * What to offer on the model-picking screen: one recommended pair for this
 * machine, and one smaller alternative.
 *
 * The choice is driven by the hardware advisor's own verdict rather than a
 * second copy of the RAM thresholds — if `hardware.fits` says the 16 GB pair is
 * not recommended here, it is not what we recommend.
 */
export function starterOptions(
  hardware: HardwareReport | null,
  catalog: readonly ModelEntry[],
): StarterOption[] {
  const fits = (id: string): HardwareFit => hardware?.fits[id] ?? 'runsWell'
  const comfortable = (id: string | null): boolean => id === null || fits(id) === 'runsWell'

  const bigPairFits = comfortable(RECOMMENDED_PAIR.stt) && comfortable(RECOMMENDED_PAIR.polish)
  const recommended = bigPairFits ? RECOMMENDED_PAIR : LOW_RAM_PAIR
  const smaller = bigPairFits ? LOW_RAM_PAIR : MINIMAL_PAIR

  const options: StarterOption[] = []

  const first = buildOption(
    'recommended',
    'Recommended for this Mac',
    bigPairFits
      ? 'The multilingual quality bar, plus the polishing model that rewrites best at this size.'
      : 'Sized for this machine’s memory: fast English transcription and a small polishing model.',
    recommended,
    catalog,
  )
  if (first) options.push(first)

  const second = buildOption(
    'smaller',
    'Smaller',
    smaller.polish === null
      ? 'The lightest option: a tiny English model with polishing off. You can turn polishing on later.'
      : 'Less disk and less memory, at some cost in accuracy. Everything can be changed later.',
    smaller,
    catalog,
  )
  if (second && second.sttId !== first?.sttId) options.push(second)

  return options
}

function buildOption(
  id: StarterOption['id'],
  title: string,
  description: string,
  pair: { stt: string; polish: string | null },
  catalog: readonly ModelEntry[],
): StarterOption | null {
  const stt = resolve(catalog, pair.stt, 'stt')
  const polish = pair.polish === null ? null : resolve(catalog, pair.polish, 'polish')
  if (!stt) return null

  const entries = polish ? [stt, polish] : [stt]
  return {
    id,
    title,
    description,
    sttId: stt.id,
    polishId: polish?.id ?? null,
    entries,
    totalBytes: entries.reduce((sum, entry) => sum + entry.sizeBytes, 0),
  }
}

/**
 * Find a catalog entry by id, falling back to the smallest model of that kind.
 *
 * The catalog is updatable independently of the app (PLAN §8), so an id
 * hard-coded here can legitimately disappear. Onboarding must still offer
 * *something* rather than showing an empty screen on a fresh install.
 */
function resolve(
  catalog: readonly ModelEntry[],
  id: string,
  kind: 'stt' | 'polish',
): ModelEntry | null {
  const exact = catalog.find((entry) => entry.id === id)
  if (exact) return exact
  const sameKind = catalog
    .filter((entry) => entry.kind === kind)
    .sort((left, right) => left.sizeBytes - right.sizeBytes)
  return sameKind[0] ?? null
}
