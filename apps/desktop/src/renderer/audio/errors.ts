/**
 * Turning `getUserMedia` failures into something a user can act on.
 *
 * The orchestrator renders any capture failure as the Bar's `mic-unavailable`
 * error and shows the message verbatim, so the message *is* the error UI. PLAN
 * §15.5: every error message names a next action. A raw
 * "NotReadableError: Could not start audio source" names none.
 */

export type CaptureErrorCode =
  /** The user (or an MDM profile) has not granted microphone access. */
  | 'permission-denied'
  /** Another process holds the device — Zoom, Teams, a stuck helper. */
  | 'mic-in-use'
  /** No input device at all, or the chosen one has vanished. */
  | 'no-device'
  /** The page cannot use the API here (no secure context, no worklet support). */
  | 'unsupported'
  | 'unknown'

export interface CaptureError {
  code: CaptureErrorCode
  /** One sentence, safe to show, ending in what to do next. */
  message: string
}

/**
 * Classify a thrown value. Accepts anything: this runs in a `catch`, and a
 * `DOMException` is only the most likely shape, not a guaranteed one.
 */
export function classifyCaptureError(cause: unknown): CaptureError {
  const name = errorName(cause)
  const detail = errorMessage(cause)

  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return {
        code: 'permission-denied',
        message:
          'Microphone access is blocked. Allow it in System Settings › Privacy & Security › Microphone, then try again.',
      }
    case 'NotFoundError':
      return {
        code: 'no-device',
        message: 'No microphone was found. Connect one and try again.',
      }
    case 'OverconstrainedError':
      return {
        code: 'no-device',
        message:
          'The selected microphone is no longer available. Pick another one in Settings › Microphone.',
      }
    case 'NotReadableError':
    case 'AbortError':
      return {
        code: 'mic-in-use',
        message:
          'The microphone is in use by another app. Close it (or release the mic there) and try again.',
      }
    case 'TypeError':
      return {
        code: 'unsupported',
        message: `Microphone capture is unavailable in this window: ${detail}`,
      }
    default:
      return {
        code: 'unknown',
        message: `The microphone could not be opened: ${detail}`,
      }
  }
}

function errorName(cause: unknown): string {
  if (typeof cause === 'object' && cause !== null && 'name' in cause) {
    const name = (cause as { name: unknown }).name
    if (typeof name === 'string') return name
  }
  return ''
}

function errorMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message || cause.name
  if (typeof cause === 'string') return cause
  return String(cause)
}
