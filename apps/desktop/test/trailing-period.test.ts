import { describe, expect, it } from 'vitest'

import { isMessagingApp } from '../src/main/dictation/app-category'
import { stripTrailingPeriod } from '../src/main/dictation/trailing-period'

const chat = { messaging: true, formality: 'casual' as const }

describe('stripTrailingPeriod', () => {
  it('drops the full stop on a casual chat message', () => {
    expect(stripTrailingPeriod('On my way.', chat)).toBe('On my way')
  })

  it('keeps it when the tone is formal', () => {
    expect(stripTrailingPeriod('On my way.', { messaging: true, formality: 'formal' })).toBe(
      'On my way.',
    )
  })

  it('keeps it outside a messaging app', () => {
    // The whole point of the separate app list: a casual *note* is still prose.
    expect(stripTrailingPeriod('On my way.', { messaging: false, formality: 'casual' })).toBe(
      'On my way.',
    )
  })

  it('leaves other terminal punctuation alone', () => {
    expect(stripTrailingPeriod('Are you coming?', chat)).toBe('Are you coming?')
    expect(stripTrailingPeriod('See you there!', chat)).toBe('See you there!')
  })

  it('never eats an ellipsis', () => {
    expect(stripTrailingPeriod('I mean...', chat)).toBe('I mean...')
    expect(stripTrailingPeriod('well…', chat)).toBe('well…')
  })

  it('leaves an abbreviation its period', () => {
    expect(stripTrailingPeriod('bring snacks, drinks, etc.', chat)).toBe(
      'bring snacks, drinks, etc.',
    )
    expect(stripTrailingPeriod('the usual suspects, i.e.', chat)).toBe('the usual suspects, i.e.')
  })

  it('leaves an initial alone', () => {
    expect(stripTrailingPeriod('signed, J.', chat)).toBe('signed, J.')
  })

  it('does not touch structured output', () => {
    // A list or a dictated "new paragraph": the last line's stop is not a
    // message sign-off.
    const list = 'Grabbing:\n\n- milk\n- bread.'
    expect(stripTrailingPeriod(list, chat)).toBe(list)
  })

  it('only removes the final stop, leaving earlier sentences punctuated', () => {
    expect(stripTrailingPeriod('Running late. Be there in ten.', chat)).toBe(
      'Running late. Be there in ten',
    )
  })

  it('is a no-op on empty text', () => {
    expect(stripTrailingPeriod('', chat)).toBe('')
  })
})

describe('isMessagingApp', () => {
  it('matches the chat apps', () => {
    for (const id of [
      'com.apple.MobileSMS',
      'net.whatsapp.WhatsApp',
      'com.tinyspeck.slackmacgap',
    ]) {
      expect(isMessagingApp(id)).toBe(true)
    }
  })

  it('does not match long-form apps that share a tone category', () => {
    // Notes is `personal` and Chrome is `work`, but neither is a chat — this is
    // the distinction the separate list exists to draw.
    for (const id of ['com.apple.notes', 'com.google.Chrome', 'com.apple.mail', 'notion.id']) {
      expect(isMessagingApp(id)).toBe(false)
    }
  })

  it('handles a missing bundle id', () => {
    expect(isMessagingApp(null)).toBe(false)
  })
})
