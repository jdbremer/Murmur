/**
 * `getUserMedia` rejections, translated into something a user can act on.
 *
 * Kept in its own DOM-free module so it can be unit-tested: the strings end up
 * in front of the user verbatim (the orchestrator turns an `audio.status`
 * error into the Bar's `mic-unavailable` message), which makes them worth
 * pinning down in a test rather than eyeballing once.
 *
 * "NotAllowedError" is technically accurate and completely useless; naming the
 * System Settings pane is the whole point of this function.
 */
export function describeMicError(error: unknown): string {
  const name = error instanceof Error ? error.name : ''
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Microphone access was denied. Grant it in System Settings › Privacy & Security › Microphone.'
    case 'NotFoundError':
      return 'No microphone was found.'
    case 'NotReadableError':
      return 'The microphone is in use by another app.'
    case 'OverconstrainedError':
      return 'The selected microphone is no longer available. Pick another in Settings.'
    default:
      return error instanceof Error && error.message
        ? `Could not open the microphone: ${error.message}`
        : 'Could not open the microphone.'
  }
}
