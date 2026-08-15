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

/** Whole-number percentage for a download row; never NaN, never >100. */
export function downloadPercent(receivedBytes: number, totalBytes: number): number {
  if (!(totalBytes > 0)) return 0
  return Math.min(100, Math.round((receivedBytes / totalBytes) * 100))
}

/** The engine ids, as a person would say them. */
export function engineLabel(engine: string): string {
  switch (engine) {
    case 'whisper-cpp':
      return 'whisper.cpp'
    case 'llama-cpp':
      return 'llama.cpp'
    case 'onnx-runtime':
      return 'ONNX Runtime'
    case 'external':
      return 'external endpoint'
    default:
      return engine
  }
}

/** Wall-clock time for the history gutter: "4:05 pm". */
export function formatClock(ts: number): string {
  return new Date(ts)
    .toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    .toLowerCase()
}

/**
 * The history feed's date headers: Today, Yesterday, then real dates.
 *
 * Compared by local calendar day, not by elapsed hours — 11 pm yesterday is
 * "Yesterday" even though it was two hours ago.
 */
export function formatDayLabel(ts: number, now: number = Date.now()): string {
  const day = new Date(ts)
  const today = new Date(now)
  const sameDay = (a: Date, b: Date): boolean =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()

  if (sameDay(day, today)) return 'Today'
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  if (sameDay(day, yesterday)) return 'Yesterday'
  return day.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })
}

/** Group a reverse-chronological list under its date headers, order kept. */
export function groupByDay<T extends { ts: number }>(
  items: readonly T[],
  now: number = Date.now(),
): { label: string; items: T[] }[] {
  const groups: { label: string; items: T[] }[] = []
  for (const item of items) {
    const label = formatDayLabel(item.ts, now)
    const last = groups[groups.length - 1]
    if (last && last.label === label) last.items.push(item)
    else groups.push({ label, items: [item] })
  }
  return groups
}
