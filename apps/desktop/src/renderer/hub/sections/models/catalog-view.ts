import type { HardwareFit, ModelEntry, ModelKind } from '@murmur/shared'

/**
 * Turning the catalog into the list on screen (PLAN §8).
 *
 * Seventeen models across two kinds is past the point where a flat list is a
 * choice — it is a wall — so this is the search, the sort and the "what should
 * I pick" answer, all pure so the ordering can be tested rather than trusted.
 *
 * The important one is {@link bestForMachine}. Every other model manager makes
 * the user compare quantisation labels and memory tiers; this picks the answer
 * and shows its working, which is the difference between a catalog and a
 * recommendation.
 */

export type ModelSort = 'best' | 'name' | 'size'

export interface CatalogViewOptions {
  entries: readonly ModelEntry[]
  kind: ModelKind
  /** Catalog model id → fit badge for this machine. */
  fits: Readonly<Record<string, HardwareFit>>
  query?: string
  sort?: ModelSort
  installedIds?: ReadonlySet<string>
  /** Hide anything not already on disk. */
  installedOnly?: boolean
}

/** How good a fit is, for sorting. Higher is better. */
const FIT_RANK: Record<HardwareFit, number> = {
  runsWell: 2,
  tight: 1,
  notRecommended: 0,
}

/**
 * Search across the fields a person would actually type.
 *
 * Includes the organisation and the licence, because "IBM" and "MIT" are both
 * real things someone narrows by — the licence in particular is the first
 * filter anyone in a regulated environment applies.
 */
function matches(entry: ModelEntry, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  return [entry.displayName, entry.org, entry.license, entry.quant, entry.id, ...entry.languages]
    .join(' ')
    .toLowerCase()
    .includes(needle)
}

export function catalogView(options: CatalogViewOptions): ModelEntry[] {
  const {
    entries,
    kind,
    fits,
    query = '',
    sort = 'best',
    installedIds,
    installedOnly = false,
  } = options

  const filtered = entries.filter(
    (entry) =>
      entry.kind === kind &&
      matches(entry, query) &&
      (!installedOnly || installedIds?.has(entry.id) === true),
  )

  const rank = (entry: ModelEntry): number => FIT_RANK[fits[entry.id] ?? 'notRecommended']

  return [...filtered].sort((a, b) => {
    if (sort === 'name') return a.displayName.localeCompare(b.displayName)
    if (sort === 'size') return a.sizeBytes - b.sizeBytes

    // "Best" is a real ordering, not a synonym for the file's order:
    // what is already installed, then what fits this machine, then the
    // publisher's recommendation, then the most capable of what is left.
    const installedDelta =
      Number(installedIds?.has(b.id) ?? false) - Number(installedIds?.has(a.id) ?? false)
    if (installedDelta !== 0) return installedDelta

    const fitDelta = rank(b) - rank(a)
    if (fitDelta !== 0) return fitDelta

    const recommendedDelta = Number(Boolean(b.recommended)) - Number(Boolean(a.recommended))
    if (recommendedDelta !== 0) return recommendedDelta

    // Bigger wants more memory, and among models that all run well here, more
    // memory is a decent proxy for better.
    if (b.ramTierGb !== a.ramTierGb) return b.ramTierGb - a.ramTierGb
    return a.displayName.localeCompare(b.displayName)
  })
}

/**
 * The one model to suggest for this machine and this kind, or null when
 * nothing in the catalog fits it.
 *
 * Deliberately prefers the *largest* model that still runs well rather than
 * the smallest that technically loads: someone who has 32 GB should be offered
 * the model that uses it. `recommended` is the catalog's own per-tier default
 * and breaks the tie — several models can run well on a big machine, and only
 * one of them is the publisher's pick for that tier.
 *
 * Falls back to a `tight` fit rather than returning nothing, because "nothing
 * is suitable" is a worse answer than "this one, and here is the caveat" — the
 * caller renders the fit badge either way.
 */
export function bestForMachine(
  entries: readonly ModelEntry[],
  kind: ModelKind,
  fits: Readonly<Record<string, HardwareFit>>,
): ModelEntry | null {
  const ofKind = entries.filter((entry) => entry.kind === kind)
  if (ofKind.length === 0) return null

  const pick = (fit: HardwareFit): ModelEntry | null => {
    const candidates = ofKind.filter((entry) => fits[entry.id] === fit)
    if (candidates.length === 0) return null
    const recommended = candidates.filter((entry) => entry.recommended)
    const pool = recommended.length > 0 ? recommended : candidates
    return (
      [...pool].sort(
        (a, b) => b.ramTierGb - a.ramTierGb || a.displayName.localeCompare(b.displayName),
      )[0] ?? null
    )
  }

  return pick('runsWell') ?? pick('tight') ?? null
}

/**
 * Bytes per second, smoothed, from a stream of cumulative progress readings.
 *
 * The raw deltas between two IPC messages are far too noisy to print — a
 * chunk boundary or a scheduler hiccup swings them by an order of magnitude,
 * and a number that jumps between 400 KB/s and 40 MB/s twice a second is one
 * nobody can read. An exponential moving average settles quickly enough to be
 * useful within a second and slowly enough to be legible.
 *
 * Deliberately not a running average from the start of the download: that
 * reports the past rather than the present, so a connection that drops to a
 * crawl keeps advertising the speed it had five minutes ago, and the ETA it
 * produces is a lie that gets worse the longer you look at it.
 */
export class DownloadRate {
  /** How much of the new reading to believe. Fitted by feel, not derived. */
  static readonly SMOOTHING = 0.3
  /** Ignore samples closer together than this; the delta is mostly noise. */
  static readonly MIN_INTERVAL_MS = 250

  #bytesPerSecond: number | null = null
  #lastBytes: number | null = null
  #lastAt = 0

  sample(receivedBytes: number, atMs: number): void {
    const previousBytes = this.#lastBytes
    const previousAt = this.#lastAt

    if (previousBytes === null) {
      this.#lastBytes = receivedBytes
      this.#lastAt = atMs
      return
    }

    const elapsed = atMs - previousAt
    if (elapsed < DownloadRate.MIN_INTERVAL_MS) return

    // A resume starts a new file and can go backwards. Re-baseline rather than
    // reporting a negative speed.
    if (receivedBytes < previousBytes) {
      this.#bytesPerSecond = null
      this.#lastBytes = receivedBytes
      this.#lastAt = atMs
      return
    }

    const instant = ((receivedBytes - previousBytes) / elapsed) * 1_000
    this.#bytesPerSecond =
      this.#bytesPerSecond === null
        ? instant
        : this.#bytesPerSecond + (instant - this.#bytesPerSecond) * DownloadRate.SMOOTHING

    this.#lastBytes = receivedBytes
    this.#lastAt = atMs
  }

  get bytesPerSecond(): number | null {
    return this.#bytesPerSecond
  }

  /** Milliseconds left, or null when there is nothing to base one on. */
  remainingMs(receivedBytes: number, totalBytes: number): number | null {
    const rate = this.#bytesPerSecond
    if (rate === null || rate <= 0 || totalBytes <= 0) return null
    const left = totalBytes - receivedBytes
    if (left <= 0) return 0
    return (left / rate) * 1_000
  }

  reset(): void {
    this.#bytesPerSecond = null
    this.#lastBytes = null
    this.#lastAt = 0
  }
}

/**
 * "about 2 minutes left". Deliberately coarse: a countdown accurate to the
 * second on a number this uncertain reads as precision the estimate does not
 * have, and watching it tick is worse than not knowing.
 */
export function formatRemaining(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms)) return null
  const seconds = Math.round(ms / 1_000)
  if (seconds <= 5) return 'almost done'
  if (seconds < 60) return `about ${Math.max(10, Math.round(seconds / 10) * 10)} seconds left`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `about ${minutes} minute${minutes === 1 ? '' : 's'} left`
  const hours = Math.round(minutes / 60)
  return `about ${hours} hour${hours === 1 ? '' : 's'} left`
}

/** "4.2 MB/s". Null when there is no measurement yet. */
export function formatRate(bytesPerSecond: number | null): string | null {
  if (bytesPerSecond === null || bytesPerSecond <= 0) return null
  if (bytesPerSecond < 1_000_000) return `${Math.round(bytesPerSecond / 1_000)} KB/s`
  return `${(bytesPerSecond / 1_000_000).toFixed(1)} MB/s`
}
