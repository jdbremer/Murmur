import { describe, expect, it } from 'vitest'

import { fromMediaAccessStatus } from '../src/main/permissions'

/**
 * Microphone state mapping (PLAN §4).
 *
 * The native addon reports a constant `unknown` for the microphone and its
 * `request` is a no-op, so this mapping over Electron's `getMediaAccessStatus`
 * is the only thing that tells the Hub the truth. Getting it wrong is not
 * cosmetic: a state of `granted` when access is actually denied means the user
 * is told everything is fine while dictation silently records nothing.
 */

describe('fromMediaAccessStatus', () => {
  it('maps granted through', () => {
    expect(fromMediaAccessStatus('granted')).toBe('granted')
  })

  it('treats restricted as denied, not as unknown', () => {
    // `restricted` is MDM/parental policy: the user cannot grant it by asking,
    // so surfacing it as "not checked yet" would send them to a prompt that
    // will never appear. It is a no, and the UI should say so.
    expect(fromMediaAccessStatus('restricted')).toBe('denied')
    expect(fromMediaAccessStatus('denied')).toBe('denied')
  })

  it('maps not-determined to unknown, so the Hub still offers to ask', () => {
    expect(fromMediaAccessStatus('not-determined')).toBe('unknown')
  })

  it('never invents a grant for a state it does not recognise', () => {
    // A future macOS state must degrade to "ask", never to "granted".
    for (const unexpected of ['', 'limited', 'provisional', 'whatever']) {
      expect(fromMediaAccessStatus(unexpected)).toBe('unknown')
    }
  })
})
