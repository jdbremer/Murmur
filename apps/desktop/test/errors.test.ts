import { describe, expect, it } from 'vitest'

import { errorMessage } from '../src/renderer/lib/errors'

describe('errorMessage', () => {
  it('unwraps what Electron adds on the way out of an IPC handler', () => {
    // The sentence the handler wrote is the only part worth showing.
    expect(
      errorMessage(
        new Error(
          "Error invoking remote method 'data.restore': Error: That file is not a Murmur backup.",
        ),
      ),
    ).toBe('That file is not a Murmur backup.')
  })

  it('peels a rethrown error’s stacked prefixes', () => {
    expect(errorMessage(new Error('Error: Error: Disk full.'))).toBe('Disk full.')
  })

  it('handles the typed error classes too', () => {
    expect(errorMessage(new TypeError('x is not a function'))).toBe('x is not a function')
  })

  it('leaves an ordinary message exactly as written', () => {
    const written = 'Murmur needs Accessibility permission to type.'
    expect(errorMessage(new Error(written))).toBe(written)
  })

  it('does not mangle a message that merely mentions an error', () => {
    expect(errorMessage(new Error('The engine reported Error 42 and stopped.'))).toBe(
      'The engine reported Error 42 and stopped.',
    )
  })

  it('copes with something that is not an Error at all', () => {
    expect(errorMessage('plain string')).toBe('plain string')
    expect(errorMessage({ toString: () => 'weird' })).toBe('weird')
  })

  it('never returns an empty string', () => {
    // A blank toast is worse than an unhelpful one.
    expect(errorMessage(new Error(''))).toBe('Something went wrong.')
    expect(errorMessage(new Error('Error:'))).toBe('Something went wrong.')
    expect(errorMessage(undefined)).toBe('undefined')
  })
})
