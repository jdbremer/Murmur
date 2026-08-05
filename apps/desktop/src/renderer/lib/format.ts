import type { AppCategory, HardwareFit } from '@murmur/shared'

/**
 * Every user-facing number and label in the Hub, formatted in one place.
 *
 * Pure and clock-injected (`now` is always a parameter), so the strings a user
 * will read are unit-tested rather than eyeballed — which matters on a machine
 * with no display, and matters again on the day someone changes a threshold.
 */

/** Thousands separators, so 12480 reads as a friendly headline number. */
export function formatCount(value: number | undefined | null): string {
  if (value === undefined || value === null || !Number.isFinite(value)) return '—'
  return Math.round(value).toLocaleString('en-US')
}

/** One decimal at most; whole numbers stay whole. */
export function formatDecimal(value: number | undefined | null): string {
  if (value === undefined || value === null || !Number.isFinite(value)) return '—'
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

/** `m:ss`, the shape people read durations in. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0:00'
  const totalSeconds = Math.round(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

const KIB = 1024

/** Disk sizes as the Models section shows them: "574 MB", "1.6 GB". */
export function formatBytes(bytes: number | undefined | null): string {
  if (bytes === undefined || bytes === null || !Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes === 0) return '0 MB'
  const units = ['B', 'KB', 'MB', 'GB', 'TB'] as const
  let value = bytes
  let unit = 0
  while (value >= KIB && unit < units.length - 1) {
    value /= KIB
    unit += 1
  }
  const decimals = value >= 100 || unit <= 1 ? 0 : 1
  return `${value.toFixed(decimals)} ${units[unit]}`
}

/**
 * "just now" · "6 min ago" · "3 hours ago" · "Yesterday" · "4 days ago" · a date.
 *
 * Deliberately not a library. Six branches of English beat 12 kB of Intl
 * plumbing for a feed whose oldest row is a fortnight old.
 */
export function relativeTime(timestamp: number, now: number = Date.now()): string {
  const deltaMs = now - timestamp
  if (!Number.isFinite(deltaMs)) return ''
  if (deltaMs < 0) return 'just now'

  const minutes = Math.floor(deltaMs / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes === 1) return '1 min ago'
  if (minutes < 60) return `${minutes} min ago`

  const hours = Math.floor(minutes / 60)
  if (hours === 1) return '1 hour ago'
  if (hours < 24) return `${hours} hours ago`

  const days = Math.floor(hours / 24)
  if (days === 1) return 'Yesterday'
  if (days < 7) return `${days} days ago`

  return new Date(timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

/** Absolute timestamp for the `title` attribute behind the relative one. */
export function absoluteTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
}

const CATEGORY_LABELS: Record<AppCategory, string> = {
  personal: 'Personal',
  work: 'Work',
  email: 'Email',
  other: 'Other',
}

export function categoryLabel(category: AppCategory): string {
  return CATEGORY_LABELS[category]
}

/** The bundle id, trimmed to the part a human recognises: `com.apple.Notes` → `Notes`. */
export function appName(bundleId: string | null): string | null {
  if (!bundleId) return null
  const tail = bundleId.split('.').filter(Boolean).at(-1)
  if (!tail) return bundleId
  return tail.charAt(0).toUpperCase() + tail.slice(1)
}

export interface FitBadge {
  label: string
  /** Which semantic colour the badge takes. */
  tone: 'positive' | 'warning' | 'danger'
  /** Why the badge says what it says — shown as the control's title. */
  hint: string
}

/** The hardware advisor's three verdicts, in words (PLAN §8, §14). */
export function hardwareFitBadge(fit: HardwareFit): FitBadge {
  switch (fit) {
    case 'runsWell':
      return {
        label: 'Runs well',
        tone: 'positive',
        hint: 'This machine has the memory and acceleration this model wants.',
      }
    case 'tight':
      return {
        label: 'Tight',
        tone: 'warning',
        hint: 'It will run, but close to this machine’s memory limit — expect slower first responses.',
      }
    case 'notRecommended':
      return {
        label: 'Not recommended',
        tone: 'danger',
        hint: 'This machine has less memory than the model needs; dictation would be slow or fail.',
      }
  }
}

/**
 * The origin flag the catalog's US-only policy is judged by (PLAN §8).
 *
 * Only the origins the policy can actually admit are mapped; anything else
 * falls back to the bare country code, which is the honest rendering for a
 * catalog that should never have got past validation in the first place.
 */
export function originFlag(origin: string): string {
  return origin === 'US' ? '🇺🇸' : '🏳'
}

const ENGINE_LABELS: Record<string, string> = {
  'whisper-cpp': 'whisper.cpp',
  'onnx-runtime': 'ONNX Runtime',
  'llama-cpp': 'llama.cpp',
}

/** The runtime that loads a model, in the name its own project uses. */
export function engineLabel(engine: string): string {
  return ENGINE_LABELS[engine] ?? engine
}

/** 0–100, safe when the total is unknown (a resumed download before its HEAD). */
export function downloadPercent(received: number, total: number): number {
  if (!Number.isFinite(total) || total <= 0) return 0
  return Math.max(0, Math.min(100, Math.round((received / total) * 100)))
}

/** "3 terms" / "1 term" — the boring bug that always ships. */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${formatCount(count)} ${count === 1 ? singular : pluralForm}`
}

/** First line only, for a collapsed history row. */
export function firstLine(text: string): string {
  const line = text.split('\n').find((candidate) => candidate.trim().length > 0)
  return (line ?? text).trim()
}
