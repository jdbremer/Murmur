import { describe, expect, it } from 'vitest'

import {
  createEnginesStatus,
  createUnavailablePermissionsStatus,
  type EnginesStatus,
  type PermissionsStatus,
} from '@murmur/shared'

import {
  greeting,
  readiness,
  type ReadinessInput,
} from '../src/renderer/hub/sections/dashboard/readiness'

const granted: PermissionsStatus = {
  microphone: 'granted',
  accessibility: 'granted',
  inputMonitoring: 'granted',
}

const running = (): EnginesStatus => {
  const status = createEnginesStatus()
  return {
    stt: { ...status.stt, state: 'ready', modelId: 'whisper-small-en' },
    polish: { ...status.polish, state: 'ready', modelId: 'gemma-3-1b' },
  }
}

const input = (overrides: Partial<ReadinessInput> = {}): ReadinessInput => ({
  permissions: granted,
  engines: running(),
  sttModelId: 'whisper-small-en',
  polishModelId: 'gemma-3-1b',
  polishingDisabled: false,
  ...overrides,
})

describe('readiness', () => {
  it('says so when everything is in place', () => {
    const result = readiness(input())
    expect(result.level).toBe('ready')
    expect(result.issues).toEqual([])
  })

  it('waits rather than accusing while the probes are still out', () => {
    expect(readiness(input({ permissions: null })).level).toBe('checking')
    expect(readiness(input({ engines: null })).level).toBe('checking')
    expect(readiness(input({ permissions: null })).issues).toEqual([])
  })

  it('treats "unknown" as not-yet-checked, not as denied', () => {
    // A dashboard that accuses the user of refusing a permission it has not
    // probed is worse than one that says nothing for a moment.
    const unknown: PermissionsStatus = {
      microphone: 'unknown',
      accessibility: 'unknown',
      inputMonitoring: 'unknown',
    }
    expect(readiness(input({ permissions: unknown })).level).toBe('ready')
  })

  it('treats "unavailable" as fine — that is every non-macOS build', () => {
    const result = readiness(input({ permissions: createUnavailablePermissionsStatus() }))
    expect(result.level).toBe('ready')
  })

  describe('blocking', () => {
    it('a denied microphone stops everything', () => {
      const result = readiness(input({ permissions: { ...granted, microphone: 'denied' } }))
      expect(result.level).toBe('blocked')
      expect(result.headline).toBe('Microphone access is off')
      expect(result.issues[0]?.section).toBe('help')
    })

    it('a denied Accessibility permission stops everything too', () => {
      expect(readiness(input({ permissions: { ...granted, accessibility: 'denied' } })).level).toBe(
        'blocked',
      )
    })

    it('no speech model stops everything, and points at Models', () => {
      const result = readiness(input({ sttModelId: null }))
      expect(result.level).toBe('blocked')
      expect(result.issues[0]?.section).toBe('models')
    })

    it('reports a dead speech engine with the engine’s own detail', () => {
      const engines = running()
      const result = readiness(
        input({
          engines: {
            ...engines,
            stt: { ...engines.stt, state: 'unavailable', detail: 'whisper-server not found' },
          },
        }),
      )
      expect(result.level).toBe('blocked')
      expect(result.issues[0]?.detail).toBe('whisper-server not found')
    })

    it('does not also complain about the engine when no model is chosen', () => {
      // One cause, one line. "No model chosen" and "engine not running" are the
      // same fact twice, and a list that says it twice reads as two problems.
      const engines = running()
      const result = readiness(
        input({
          sttModelId: null,
          engines: { ...engines, stt: { ...engines.stt, state: 'idle' } },
        }),
      )
      expect(result.issues.filter((issue) => issue.blocking)).toHaveLength(1)
    })

    it('counts the blockers in the headline when there is more than one', () => {
      const result = readiness(
        input({ permissions: { ...granted, microphone: 'denied' }, sttModelId: null }),
      )
      expect(result.headline).toBe('2 things are stopping dictation')
    })
  })

  describe('degraded', () => {
    it('a missing hotkey permission degrades rather than blocks — the menu bar still works', () => {
      const result = readiness(input({ permissions: { ...granted, inputMonitoring: 'denied' } }))
      expect(result.level).toBe('degraded')
      expect(result.issues[0]?.blocking).toBe(false)
    })

    it('a missing polishing model degrades — the raw transcript still lands', () => {
      const result = readiness(input({ polishModelId: null }))
      expect(result.level).toBe('degraded')
      expect(result.issues[0]?.id).toBe('no-polish')
    })

    it('says nothing about polishing when polishing is switched off', () => {
      const engines = running()
      const result = readiness(
        input({
          polishModelId: null,
          polishingDisabled: true,
          engines: { ...engines, polish: { ...engines.polish, state: 'unavailable' } },
        }),
      )
      expect(result.level).toBe('ready')
    })

    it('a blocker outranks any number of smaller problems', () => {
      const result = readiness(
        input({
          permissions: { ...granted, microphone: 'denied', inputMonitoring: 'denied' },
          polishModelId: null,
        }),
      )
      expect(result.level).toBe('blocked')
      // The smaller ones are still listed — they are not gone, just outranked.
      expect(result.issues.length).toBe(3)
    })
  })
})

describe('greeting', () => {
  it('runs morning, afternoon, evening', () => {
    expect(greeting(8)).toBe('Good morning')
    expect(greeting(14)).toBe('Good afternoon')
    expect(greeting(21)).toBe('Good evening')
  })

  it('is still evening at 2am — the day turns at 5, not at midnight', () => {
    expect(greeting(2)).toBe('Good evening')
    expect(greeting(4)).toBe('Good evening')
    expect(greeting(5)).toBe('Good morning')
  })

  it('covers every hour', () => {
    for (let hour = 0; hour < 24; hour += 1) expect(greeting(hour)).toMatch(/^Good /)
  })
})
