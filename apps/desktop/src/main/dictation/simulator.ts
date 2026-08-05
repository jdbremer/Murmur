import type { DictationStateMachine } from './state-machine'

/**
 * Development-only stand-in for a real utterance.
 *
 * Registered behind `debug.simulateDictation` in unpackaged builds so the Bar's
 * states can be built and reviewed without a microphone, a model or the native
 * hotkey tap — none of which exist until Stage 2. It drives the same state
 * machine and the same events the real loop will.
 */

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

export interface SimulateOptions {
  /** How long to "listen" before transcribing. */
  listenMs?: number
  /** Roughly the STT budget from PLAN §7.3. */
  transcribeMs?: number
  polishMs?: number
  insertMs?: number
  /** Finish with the error state instead of a successful insertion. */
  fail?: boolean
}

export async function simulateDictation(
  machine: DictationStateMachine,
  options: SimulateOptions = {},
): Promise<void> {
  const {
    listenMs = 1400,
    transcribeMs = 500,
    polishMs = 450,
    insertMs = 200,
    fail = false,
  } = options

  machine.reset()
  if (!machine.startListening(false)) return
  await sleep(listenMs)

  machine.startProcessing('transcribing')
  await sleep(transcribeMs)

  machine.startProcessing('polishing')
  await sleep(polishMs)

  if (fail) {
    machine.fail('no-speech', "Didn't catch that")
    await sleep(800)
    machine.reset()
    return
  }

  machine.startInserting()
  await sleep(insertMs)
  machine.finishInserted('We should ship it on Wednesday.'.length, 'paste')

  await sleep(900)
  machine.reset()
}
