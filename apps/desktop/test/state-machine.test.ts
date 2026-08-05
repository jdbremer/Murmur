import { describe, expect, it, vi } from 'vitest'

import type { DictationEvent } from '@murmur/shared'

import { DictationStateMachine } from '../src/main/dictation/state-machine'

const silent = { log: () => undefined }

function collect(machine: DictationStateMachine): DictationEvent[] {
  const events: DictationEvent[] = []
  machine.on('event', (event) => events.push(event))
  return events
}

describe('DictationStateMachine', () => {
  it('starts idle', () => {
    const machine = new DictationStateMachine(silent)
    expect(machine.state).toBe('idle')
    expect(machine.getState()).toEqual({ state: 'idle' })
  })

  it('runs the happy path and settles back to idle', () => {
    const machine = new DictationStateMachine(silent)
    const events = collect(machine)

    expect(machine.startListening()).toBe(true)
    expect(machine.state).toBe('listening')
    expect(machine.startProcessing('transcribing')).toBe(true)
    expect(machine.startProcessing('polishing')).toBe(true)
    expect(machine.startInserting()).toBe(true)
    expect(machine.finishInserted(31, 'paste')).toBe(true)

    // `inserted` is momentary: the machine rests at idle straight away.
    expect(machine.state).toBe('idle')
    expect(events.map((event) => event.state)).toEqual([
      'listening',
      'processing',
      'processing',
      'inserting',
      'inserted',
    ])
  })

  it('allows the sub-state moves that happen in place', () => {
    const machine = new DictationStateMachine(silent)
    machine.startListening(false)
    // Hands-free latches mid-utterance.
    expect(machine.startListening(true)).toBe(true)
    machine.startProcessing('transcribing')
    // The transcribing → polishing hand-off stays inside `processing`.
    expect(machine.startProcessing('polishing')).toBe(true)
    expect(machine.state).toBe('processing')
  })

  it('refuses illegal transitions instead of throwing', () => {
    const machine = new DictationStateMachine(silent)
    const invalid = vi.fn()
    machine.on('invalidTransition', invalid)

    // Nothing to insert while idle.
    expect(machine.startInserting()).toBe(false)
    expect(machine.state).toBe('idle')
    expect(invalid).toHaveBeenCalledTimes(1)
    expect(invalid.mock.calls[0]?.[0]).toMatchObject({ from: 'idle', to: 'inserting' })

    // Nor can listening jump straight to inserted.
    machine.startListening()
    expect(machine.finishInserted(3)).toBe(false)
    expect(machine.state).toBe('listening')

    // And an insertion cannot be reported twice.
    machine.startProcessing()
    machine.startInserting()
    expect(machine.finishInserted(3)).toBe(true)
    expect(machine.finishInserted(3)).toBe(false)
  })

  it('emits state pairs only when the resting state moves', () => {
    const machine = new DictationStateMachine(silent)
    const transitions: [string, string][] = []
    machine.on('state', (next, previous) => transitions.push([previous, next]))

    machine.startListening()
    machine.startProcessing('transcribing')
    machine.startProcessing('polishing') // same resting state — no `state` event
    machine.startInserting()

    expect(transitions).toEqual([
      ['idle', 'listening'],
      ['listening', 'processing'],
      ['processing', 'inserting'],
    ])
  })

  it('cancels from any state', () => {
    const machine = new DictationStateMachine(silent)
    machine.startListening()
    machine.startProcessing()

    const events = collect(machine)
    expect(machine.reset()).toBe(true)
    expect(machine.state).toBe('idle')
    expect(events).toEqual([{ state: 'idle' }])

    // Already idle: nothing to do, no spurious event.
    expect(machine.reset()).toBe(false)
  })

  it('surfaces errors from any working state and returns to idle', () => {
    const machine = new DictationStateMachine(silent)
    machine.startListening()
    expect(machine.fail('secure-input', 'Secure field — can’t type here')).toBe(true)
    expect(machine.state).toBe('idle')
    expect(machine.getState()).toMatchObject({ state: 'error', code: 'secure-input' })
  })

  it('validates dispatched events', () => {
    const machine = new DictationStateMachine(silent)
    expect(() => machine.dispatch({ state: 'nonsense' } as never)).toThrowError()
  })

  it('hands out copies, not internal state', () => {
    const machine = new DictationStateMachine(silent)
    machine.startListening(true)
    const snapshot = machine.getState()
    expect(snapshot).toMatchObject({ state: 'listening', handsFree: true })
    expect(machine.getState()).not.toBe(snapshot)
  })
})
