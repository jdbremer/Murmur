import { describe, expect, it } from 'vitest'

import type { HardwareFit, ModelEntry } from '@murmur/shared'

import {
  bestForMachine,
  catalogView,
  DownloadRate,
  formatRate,
  formatRemaining,
} from '../src/renderer/hub/sections/models/catalog-view'

const entry = (overrides: Partial<ModelEntry> & Pick<ModelEntry, 'id'>): ModelEntry => ({
  kind: 'stt',
  engine: 'whisper-cpp',
  displayName: overrides.id,
  org: 'OpenAI',
  origin: 'US',
  license: 'MIT',
  sizeBytes: 500_000_000,
  ramTierGb: 8,
  languages: ['en'],
  quant: 'q5_0',
  files: [{ url: 'https://example.com/f', sha256: 'a'.repeat(64), bytes: 1, filename: 'f' }],
  ...overrides,
})

const CATALOG: ModelEntry[] = [
  entry({ id: 'tiny', displayName: 'Whisper Tiny', ramTierGb: 4, sizeBytes: 80_000_000 }),
  entry({
    id: 'small',
    displayName: 'Whisper Small',
    ramTierGb: 8,
    sizeBytes: 500_000_000,
    recommended: true,
  }),
  entry({
    id: 'turbo',
    displayName: 'Whisper Turbo',
    ramTierGb: 16,
    sizeBytes: 900_000_000,
    recommended: true,
  }),
  entry({ id: 'huge', displayName: 'Whisper Huge', ramTierGb: 32, sizeBytes: 3_000_000_000 }),
  entry({
    id: 'gemma',
    kind: 'polish',
    displayName: 'Gemma 3 4B',
    org: 'Google',
    license: 'Gemma',
    ramTierGb: 16,
    recommended: true,
  }),
  entry({
    id: 'granite',
    kind: 'polish',
    displayName: 'Granite 3.3 2B',
    org: 'IBM',
    license: 'Apache-2.0',
    ramTierGb: 8,
  }),
]

const fits = (overrides: Record<string, HardwareFit> = {}): Record<string, HardwareFit> => ({
  tiny: 'runsWell',
  small: 'runsWell',
  turbo: 'runsWell',
  huge: 'notRecommended',
  gemma: 'runsWell',
  granite: 'runsWell',
  ...overrides,
})

describe('catalogView', () => {
  it('shows only the requested kind', () => {
    const ids = catalogView({ entries: CATALOG, kind: 'polish', fits: fits() }).map((e) => e.id)
    expect(ids).toEqual(expect.arrayContaining(['gemma', 'granite']))
    expect(ids).not.toContain('turbo')
  })

  it('puts what is installed first, whatever else is true of it', () => {
    const view = catalogView({
      entries: CATALOG,
      kind: 'stt',
      fits: fits(),
      installedIds: new Set(['huge']),
    })
    // `huge` does not even run well here, but it is on disk, so it is the one
    // the user can actually use right now.
    expect(view[0]?.id).toBe('huge')
  })

  it('then orders by fit, so nothing unusable outranks something usable', () => {
    const view = catalogView({ entries: CATALOG, kind: 'stt', fits: fits({ small: 'tight' }) })
    const ids = view.map((e) => e.id)
    expect(ids.indexOf('turbo')).toBeLessThan(ids.indexOf('small'))
    expect(ids.indexOf('small')).toBeLessThan(ids.indexOf('huge'))
  })

  it('prefers the catalog’s own recommendation among equally good fits', () => {
    const view = catalogView({ entries: CATALOG, kind: 'stt', fits: fits({ huge: 'runsWell' }) })
    // huge (32 GB tier) is bigger, but turbo is the publisher's pick.
    expect(view[0]?.id).toBe('turbo')
  })

  it('sorts by name and by size on demand', () => {
    const byName = catalogView({ entries: CATALOG, kind: 'stt', fits: fits(), sort: 'name' })
    expect(byName.map((e) => e.displayName)).toEqual([
      'Whisper Huge',
      'Whisper Small',
      'Whisper Tiny',
      'Whisper Turbo',
    ])
    const bySize = catalogView({ entries: CATALOG, kind: 'stt', fits: fits(), sort: 'size' })
    expect(bySize[0]?.id).toBe('tiny')
    expect(bySize[bySize.length - 1]?.id).toBe('huge')
  })

  it('searches the name, the publisher and the licence', () => {
    const byOrg = catalogView({ entries: CATALOG, kind: 'polish', fits: fits(), query: 'IBM' })
    expect(byOrg.map((e) => e.id)).toEqual(['granite'])

    // The first filter anyone in a regulated environment applies.
    const byLicence = catalogView({
      entries: CATALOG,
      kind: 'polish',
      fits: fits(),
      query: 'apache',
    })
    expect(byLicence.map((e) => e.id)).toEqual(['granite'])

    const byName = catalogView({ entries: CATALOG, kind: 'stt', fits: fits(), query: 'turbo' })
    expect(byName.map((e) => e.id)).toEqual(['turbo'])
  })

  it('ignores case and surrounding whitespace in the query', () => {
    expect(
      catalogView({ entries: CATALOG, kind: 'stt', fits: fits(), query: '  TURBO ' }),
    ).toHaveLength(1)
  })

  it('an empty query filters nothing', () => {
    expect(catalogView({ entries: CATALOG, kind: 'stt', fits: fits(), query: '   ' })).toHaveLength(
      4,
    )
  })

  it('can narrow to what is already on disk', () => {
    const view = catalogView({
      entries: CATALOG,
      kind: 'stt',
      fits: fits(),
      installedIds: new Set(['small']),
      installedOnly: true,
    })
    expect(view.map((e) => e.id)).toEqual(['small'])
  })

  it('does not mutate the catalog it was handed', () => {
    const before = CATALOG.map((e) => e.id)
    catalogView({ entries: CATALOG, kind: 'stt', fits: fits(), sort: 'size' })
    expect(CATALOG.map((e) => e.id)).toEqual(before)
  })
})

describe('bestForMachine', () => {
  it('offers the most capable model that still runs well', () => {
    expect(bestForMachine(CATALOG, 'stt', fits())?.id).toBe('turbo')
  })

  it('breaks a tie with the catalog’s per-tier recommendation', () => {
    // Both run well; only one is the publisher's pick for its tier.
    expect(bestForMachine(CATALOG, 'stt', fits({ huge: 'runsWell' }))?.id).toBe('turbo')
  })

  it('falls back to a tight fit rather than offering nothing', () => {
    // "Nothing is suitable" is a worse answer than "this one, with a caveat" —
    // the caller still renders the fit badge.
    const poor = fits({ tiny: 'tight', small: 'notRecommended', turbo: 'notRecommended' })
    expect(bestForMachine(CATALOG, 'stt', poor)?.id).toBe('tiny')
  })

  it('returns null only when nothing of that kind fits at all', () => {
    const hopeless = fits({
      tiny: 'notRecommended',
      small: 'notRecommended',
      turbo: 'notRecommended',
    })
    expect(bestForMachine(CATALOG, 'stt', hopeless)).toBeNull()
  })

  it('returns null for a kind the catalog has none of', () => {
    expect(bestForMachine([], 'polish', {})).toBeNull()
  })
})

describe('DownloadRate', () => {
  it('has no answer from a single reading', () => {
    const rate = new DownloadRate()
    rate.sample(0, 0)
    expect(rate.bytesPerSecond).toBeNull()
    expect(rate.remainingMs(0, 1_000)).toBeNull()
  })

  it('measures the first interval directly', () => {
    const rate = new DownloadRate()
    rate.sample(0, 0)
    rate.sample(1_000_000, 1_000)
    expect(rate.bytesPerSecond).toBeCloseTo(1_000_000, -3)
  })

  it('smooths rather than tracking every jitter', () => {
    const rate = new DownloadRate()
    rate.sample(0, 0)
    rate.sample(1_000_000, 1_000)
    // A single 10x spike must not become the reported speed.
    rate.sample(11_000_000, 2_000)
    expect(rate.bytesPerSecond).toBeLessThan(5_000_000)
    expect(rate.bytesPerSecond).toBeGreaterThan(1_000_000)
  })

  it('ignores samples too close together to mean anything', () => {
    const rate = new DownloadRate()
    rate.sample(0, 0)
    rate.sample(1_000_000, 1_000)
    const settled = rate.bytesPerSecond
    rate.sample(1_000_010, 1_050)
    expect(rate.bytesPerSecond).toBe(settled)
  })

  it('re-baselines instead of reporting a negative speed when a download restarts', () => {
    const rate = new DownloadRate()
    rate.sample(5_000_000, 0)
    rate.sample(9_000_000, 1_000)
    expect(rate.bytesPerSecond).toBeGreaterThan(0)
    rate.sample(0, 2_000)
    expect(rate.bytesPerSecond).toBeNull()
  })

  it('estimates what is left from the current speed, not the average since the start', () => {
    const rate = new DownloadRate()
    rate.sample(0, 0)
    rate.sample(1_000_000, 1_000)
    const left = rate.remainingMs(1_000_000, 5_000_000)
    expect(left).not.toBeNull()
    expect((left as number) / 1_000).toBeCloseTo(4, 0)
  })

  it('reports zero rather than a negative time once it is over', () => {
    const rate = new DownloadRate()
    rate.sample(0, 0)
    rate.sample(1_000_000, 1_000)
    expect(rate.remainingMs(2_000_000, 1_000_000)).toBe(0)
  })

  it('forgets everything on reset', () => {
    const rate = new DownloadRate()
    rate.sample(0, 0)
    rate.sample(1_000_000, 1_000)
    rate.reset()
    expect(rate.bytesPerSecond).toBeNull()
  })
})

describe('formatRemaining', () => {
  it('has nothing to say without an estimate', () => {
    expect(formatRemaining(null)).toBeNull()
    expect(formatRemaining(Number.POSITIVE_INFINITY)).toBeNull()
  })

  it('rounds coarsely, because the estimate is coarse', () => {
    expect(formatRemaining(3_000)).toBe('almost done')
    expect(formatRemaining(37_000)).toBe('about 40 seconds left')
    expect(formatRemaining(150_000)).toBe('about 3 minutes left')
    expect(formatRemaining(60_000)).toBe('about 1 minute left')
    expect(formatRemaining(7_200_000)).toBe('about 2 hours left')
  })

  it('never says "0 seconds left"', () => {
    for (let ms = 0; ms < 60_000; ms += 700) {
      expect(formatRemaining(ms)).not.toMatch(/\b0 /)
    }
  })
})

describe('formatRate', () => {
  it('switches units where a human would', () => {
    expect(formatRate(450_000)).toBe('450 KB/s')
    expect(formatRate(4_200_000)).toBe('4.2 MB/s')
  })

  it('says nothing rather than zero', () => {
    expect(formatRate(null)).toBeNull()
    expect(formatRate(0)).toBeNull()
  })
})
