import type { EnginesStatus, PermissionsStatus } from '@murmur/shared'

import type { SectionId } from '../../navigation'

/**
 * "Can I dictate right now, and if not, what do I press?" (PLAN §2.2.0)
 *
 * The Hub used to answer this question in three places and never in one: Help
 * listed permissions, Models listed engines, and a missing speech model
 * announced itself only when a dictation failed — at the moment the user was
 * least able to do anything about it. This computes the whole answer once, and
 * the Dashboard states it before anything else on the screen.
 *
 * Pure, so the rules can be tested rather than eyeballed against a machine that
 * happens to be in one state. The distinction that matters most is the one
 * between *blocked* and *degraded*: a denied microphone means dictation cannot
 * work at all, while a missing polishing model means it works and inserts the
 * raw transcript. Rendering those the same way trains people to ignore both.
 */

export type ReadinessLevel = 'checking' | 'ready' | 'degraded' | 'blocked'

export interface ReadinessIssue {
  id: string
  /** The problem, in the fewest words that still identify it. */
  label: string
  /** One sentence on what it costs. */
  detail: string
  /** Where the fix lives. */
  section: SectionId
  actionLabel: string
  blocking: boolean
}

export interface Readiness {
  level: ReadinessLevel
  /** The headline sentence. */
  headline: string
  issues: ReadinessIssue[]
}

export interface ReadinessInput {
  permissions: PermissionsStatus | null
  engines: EnginesStatus | null
  /** From settings — the selected speech model, not the loaded one. */
  sttModelId: string | null
  polishModelId: string | null
  /** True when polishing is switched off; then a missing polish model is fine. */
  polishingDisabled: boolean
}

/**
 * `unavailable` is not a problem: it is what every non-macOS build reports for
 * permissions that do not exist there. Only an outright `denied` is. `unknown`
 * means "not probed yet" and is deliberately not treated as a failure — a
 * dashboard that accuses the user of denying a permission it has not checked
 * is worse than one that waits a moment.
 */
const isDenied = (state: string): boolean => state === 'denied'

export function readiness(input: ReadinessInput): Readiness {
  const { permissions, engines, sttModelId, polishModelId, polishingDisabled } = input

  if (!permissions || !engines) {
    return { level: 'checking', headline: 'Checking your setup…', issues: [] }
  }

  const issues: ReadinessIssue[] = []

  if (isDenied(permissions.microphone)) {
    issues.push({
      id: 'microphone',
      label: 'Microphone access is off',
      detail: 'Murmur cannot hear you, so dictation does nothing at all.',
      section: 'help',
      actionLabel: 'Fix in Help',
      blocking: true,
    })
  }

  if (isDenied(permissions.accessibility)) {
    issues.push({
      id: 'accessibility',
      label: 'Accessibility access is off',
      detail: 'Murmur can hear you but cannot type the result into anything.',
      section: 'help',
      actionLabel: 'Fix in Help',
      blocking: true,
    })
  }

  if (!sttModelId) {
    issues.push({
      id: 'no-stt',
      label: 'No speech model chosen',
      detail: 'Pick one in Models — nothing can be transcribed until you do.',
      section: 'models',
      actionLabel: 'Choose a model',
      blocking: true,
    })
  } else if (engines.stt.state === 'unavailable' || engines.stt.state === 'error') {
    issues.push({
      id: 'stt-engine',
      label: 'The speech engine is not running',
      detail: engines.stt.detail || 'Its runtime could not start on this machine.',
      section: 'models',
      actionLabel: 'Open Models',
      blocking: true,
    })
  }

  // Input Monitoring is deliberately non-blocking: without it the global
  // hotkey never fires, but the menu bar can still start a dictation. Calling
  // that "blocked" would overstate it, and overstating one thing is how a
  // status panel loses the right to be believed about the next thing.
  if (isDenied(permissions.inputMonitoring)) {
    issues.push({
      id: 'input-monitoring',
      label: 'The dictation key will not work',
      detail: 'Input Monitoring is off. You can still start dictation from the menu bar.',
      section: 'help',
      actionLabel: 'Fix in Help',
      blocking: false,
    })
  }

  if (!polishingDisabled) {
    if (!polishModelId) {
      issues.push({
        id: 'no-polish',
        label: 'No polishing model chosen',
        detail: 'Transcripts go in raw — punctuation and filler words are left as spoken.',
        section: 'models',
        actionLabel: 'Choose a model',
        blocking: false,
      })
    } else if (engines.polish.state === 'unavailable' || engines.polish.state === 'error') {
      issues.push({
        id: 'polish-engine',
        label: 'The polishing engine is not running',
        detail: engines.polish.detail || 'Transcripts will be inserted unpolished.',
        section: 'models',
        actionLabel: 'Open Models',
        blocking: false,
      })
    }
  }

  const blocking = issues.filter((issue) => issue.blocking)
  if (blocking.length > 0) {
    return {
      level: 'blocked',
      headline:
        blocking.length === 1
          ? (blocking[0] as ReadinessIssue).label
          : `${blocking.length} things are stopping dictation`,
      issues,
    }
  }

  if (issues.length > 0) {
    return {
      level: 'degraded',
      headline:
        issues.length === 1
          ? (issues[0] as ReadinessIssue).label
          : `Dictation works, with ${issues.length} things worth fixing`,
      issues,
    }
  }

  return { level: 'ready', headline: 'Murmur is ready', issues: [] }
}

/**
 * The greeting.
 *
 * Local hours, and cut at 5am rather than midnight: someone dictating at 2am is
 * still having their evening, and being told "good morning" at that hour reads
 * as a machine that has not been outside.
 */
export function greeting(hour: number): string {
  if (hour >= 5 && hour < 12) return 'Good morning'
  if (hour >= 12 && hour < 18) return 'Good afternoon'
  return 'Good evening'
}
