/**
 * The sentence to actually show someone.
 *
 * Electron wraps anything thrown inside an IPC handler before it reaches the
 * renderer, so a carefully worded message arrives as:
 *
 *   Error invoking remote method 'data.restore': Error: That file is not a
 *   Murmur backup.
 *
 * Every character before "That" is plumbing. Showing it does not help the user
 * and does not help a bug report either — the channel name is already in the
 * logs. This strips the wrapper and any stacked `Error:` prefixes, and leaves
 * everything else exactly as it was written.
 */
const IPC_WRAPPER = /^Error invoking remote method '[^']*':\s*/
const ERROR_PREFIX = /^(?:[A-Za-z]*Error):\s*/

export function errorMessage(cause: unknown): string {
  const raw = cause instanceof Error ? cause.message : String(cause)

  let message = raw.replace(IPC_WRAPPER, '')
  // `Error: Error: …` happens when a handler rethrows; peel every layer.
  let previous = ''
  while (message !== previous) {
    previous = message
    message = message.replace(ERROR_PREFIX, '')
  }

  const trimmed = message.trim()
  // Never return nothing: a blank toast is worse than an unhelpful one.
  return trimmed.length > 0 ? trimmed : 'Something went wrong.'
}
