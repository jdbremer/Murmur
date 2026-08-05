/**
 * Display formatting shared by the Hub sections.
 *
 * Pure and DOM-free so it can be unit-tested — these functions decide what a
 * 4.47 GB download and a three-week-old dictation look like, and both are the
 * kind of thing that silently regresses into "4470000000 bytes" or "NaN".
 */

/** Model sizes and disk usage. Decimal units, like every download UI. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB'
  if (bytes < 1_000_000) return `${Math.max(1, Math.round(bytes / 1_000))} KB`
  if (bytes < 1_000_000_000) return `${Math.round(bytes / 1_000_000)} MB`
  return `${(bytes / 1_000_000_000).toFixed(2)} GB`
}

/** Whole numbers stay whole; averages get one decimal. */
export function formatNumber(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '—'
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

/**
 * Relative timestamps for the history feed.
 *
 * Anything older than a week gets an absolute date: "23 days ago" is a worse
 * answer than "14 Jul" once you are actually looking for something.
 */
export function formatTimestamp(ts: number, now: number = Date.now()): string {
  const elapsed = now - ts
  if (!Number.isFinite(elapsed) || elapsed < 0) return formatDate(ts)

  const minutes = Math.floor(elapsed / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`

  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`

  return formatDate(ts)
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

/** Milliseconds, as the history feed's latency chip. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  return ms < 1_000 ? `${Math.round(ms)} ms` : `${(ms / 1_000).toFixed(1)} s`
}

/** `["en"]` → `English`; `["multi"]` → `Multilingual`. */
export function formatLanguages(languages: readonly string[]): string {
  if (languages.length === 0) return '—'
  if (languages.includes('multi')) return 'Multilingual'
  const names = new Intl.DisplayNames(undefined, { type: 'language' })
  return languages
    .map((tag) => {
      try {
        return names.of(tag) ?? tag
      } catch {
        return tag
      }
    })
    .join(', ')
}
