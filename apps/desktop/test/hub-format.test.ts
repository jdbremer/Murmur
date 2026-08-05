import { describe, expect, it } from 'vitest'

import {
  absoluteTime,
  appName,
  categoryLabel,
  downloadPercent,
  engineLabel,
  firstLine,
  formatBytes,
  formatCount,
  formatDecimal,
  formatDuration,
  hardwareFitBadge,
  originFlag,
  plural,
  relativeTime,
} from '../src/renderer/lib/format'
import { dataLocation, detectPlatform, isMacPlatform } from '../src/renderer/lib/platform'

describe('formatCount', () => {
  it('groups thousands and rounds', () => {
    expect(formatCount(12_480)).toBe('12,480')
    expect(formatCount(4.6)).toBe('5')
  })

  it('shows an em dash rather than NaN', () => {
    expect(formatCount(undefined)).toBe('—')
    expect(formatCount(null)).toBe('—')
    expect(formatCount(Number.NaN)).toBe('—')
  })
})

describe('formatDecimal', () => {
  it('keeps whole numbers whole and trims the rest to one place', () => {
    expect(formatDecimal(120)).toBe('120')
    expect(formatDecimal(118.42)).toBe('118.4')
    expect(formatDecimal(undefined)).toBe('—')
  })
})

describe('formatDuration', () => {
  it('reads as m:ss', () => {
    expect(formatDuration(4200)).toBe('0:04')
    expect(formatDuration(83_000)).toBe('1:23')
    expect(formatDuration(600_000)).toBe('10:00')
  })

  it('never renders nonsense', () => {
    expect(formatDuration(-1)).toBe('0:00')
    expect(formatDuration(Number.NaN)).toBe('0:00')
  })
})

describe('formatBytes', () => {
  it('uses the unit a model card should show', () => {
    expect(formatBytes(574 * 1024 * 1024)).toBe('574 MB')
    expect(formatBytes(1.6 * 1024 * 1024 * 1024)).toBe('1.6 GB')
    expect(formatBytes(0)).toBe('0 MB')
  })

  it('drops the decimal once the number is big enough not to need it', () => {
    expect(formatBytes(2364 * 1024 * 1024)).toBe('2.3 GB')
    expect(formatBytes(120 * 1024)).toBe('120 KB')
  })

  it('handles missing values', () => {
    expect(formatBytes(undefined)).toBe('—')
    expect(formatBytes(-5)).toBe('—')
  })
})

describe('relativeTime', () => {
  const now = Date.UTC(2026, 7, 5, 12, 0, 0)

  it('walks the whole ladder', () => {
    expect(relativeTime(now - 5_000, now)).toBe('just now')
    expect(relativeTime(now - 60_000, now)).toBe('1 min ago')
    expect(relativeTime(now - 6 * 60_000, now)).toBe('6 min ago')
    expect(relativeTime(now - 60 * 60_000, now)).toBe('1 hour ago')
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe('3 hours ago')
    expect(relativeTime(now - 25 * 3_600_000, now)).toBe('Yesterday')
    expect(relativeTime(now - 4 * 86_400_000, now)).toBe('4 days ago')
  })

  it('falls back to a date once a week has passed', () => {
    const older = relativeTime(now - 30 * 86_400_000, now)
    expect(older).not.toContain('ago')
    expect(older).toMatch(/[A-Z][a-z]{2}/)
  })

  it('treats clock skew as "just now" rather than "in -3 minutes"', () => {
    expect(relativeTime(now + 60_000, now)).toBe('just now')
  })

  it('renders an absolute timestamp for the tooltip', () => {
    expect(absoluteTime(now)).toMatch(/2026/)
  })
})

describe('appName', () => {
  it('takes the recognisable tail of a bundle id', () => {
    expect(appName('com.apple.Notes')).toBe('Notes')
    expect(appName('com.tinyspeck.slackmacgap')).toBe('Slackmacgap')
  })

  it('is null when there is no app', () => {
    expect(appName(null)).toBeNull()
  })
})

describe('categoryLabel', () => {
  it('capitalises the four tone buckets', () => {
    expect(categoryLabel('personal')).toBe('Personal')
    expect(categoryLabel('work')).toBe('Work')
    expect(categoryLabel('email')).toBe('Email')
    expect(categoryLabel('other')).toBe('Other')
  })
})

describe('hardwareFitBadge', () => {
  it('gives each verdict a tone and a reason', () => {
    expect(hardwareFitBadge('runsWell').tone).toBe('positive')
    expect(hardwareFitBadge('tight').tone).toBe('warning')
    expect(hardwareFitBadge('notRecommended').tone).toBe('danger')
    for (const fit of ['runsWell', 'tight', 'notRecommended'] as const) {
      expect(hardwareFitBadge(fit).hint.length).toBeGreaterThan(20)
    }
  })
})

describe('origin and engine labels', () => {
  it('flags the only origin the policy admits', () => {
    expect(originFlag('US')).toBe('🇺🇸')
    expect(originFlag('CN')).not.toBe('🇺🇸')
  })

  it('names each runtime the way its project does', () => {
    expect(engineLabel('whisper-cpp')).toBe('whisper.cpp')
    expect(engineLabel('onnx-runtime')).toBe('ONNX Runtime')
    expect(engineLabel('llama-cpp')).toBe('llama.cpp')
    expect(engineLabel('something-else')).toBe('something-else')
  })
})

describe('downloadPercent', () => {
  it('is 0 until the total is known', () => {
    expect(downloadPercent(1000, 0)).toBe(0)
  })

  it('clamps and rounds', () => {
    expect(downloadPercent(50, 200)).toBe(25)
    expect(downloadPercent(500, 200)).toBe(100)
    expect(downloadPercent(-5, 200)).toBe(0)
  })
})

describe('plural', () => {
  it('gets the boring case right', () => {
    expect(plural(1, 'term')).toBe('1 term')
    expect(plural(3, 'term')).toBe('3 terms')
    expect(plural(0, 'term')).toBe('0 terms')
  })
})

describe('firstLine', () => {
  it('takes the first line with content', () => {
    expect(firstLine('\n\n  Hello there\nsecond')).toBe('Hello there')
    expect(firstLine('one only')).toBe('one only')
  })
})

describe('platform detection', () => {
  const mac =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Murmur/0.1.0 Chrome/140 Electron/43 Safari/537.36'
  const linux =
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Murmur/0.1.0 Chrome/140 Electron/43 Safari/537.36'
  const windows = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140 Electron/43'

  it('recognises the three platforms the plan cares about', () => {
    expect(detectPlatform(mac)).toBe('mac')
    expect(detectPlatform(linux)).toBe('linux')
    expect(detectPlatform(windows)).toBe('windows')
    expect(detectPlatform('')).toBe('unknown')
  })

  it('is only "mac" on a Mac — the deep links depend on it', () => {
    expect(isMacPlatform(mac)).toBe(true)
    expect(isMacPlatform(linux)).toBe(false)
  })

  it('names the data directory per platform (PLAN §9)', () => {
    expect(dataLocation('mac')).toBe('~/Library/Application Support/Murmur')
    expect(dataLocation('windows')).toContain('Murmur')
    expect(dataLocation('linux')).toContain('Murmur')
  })
})
