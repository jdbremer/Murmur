import { systemPreferences } from 'electron'

import type { PermissionKind, PermissionState, PermissionsStatus } from '@murmur/shared'

import { native } from './native'
import { createLogger } from './logging'

/**
 * Permissions, composed from the two places that actually know.
 *
 * The native addon owns Accessibility and Input Monitoring — those are
 * `AXIsProcessTrusted` / `CGPreflightListenEventAccess`, with no Electron
 * equivalent. It deliberately does **not** own the microphone: it reports a
 * constant `unknown` and its `request` is a no-op, on the reasoning that
 * `getUserMedia` in the capture renderer is the authoritative source.
 *
 * That reasoning leaves a hole. `getUserMedia` only runs when the capture
 * renderer warms, so a user who opens Help and asks for the microphone gets no
 * prompt, no state change, and — because macOS only lists an app under
 * Privacy & Security → Microphone once it has *asked* — no entry in System
 * Settings to grant it from either. The permission is unreachable from the UI.
 *
 * Electron exposes exactly the two calls that close it, so use them on darwin
 * and leave every other platform reporting what native says.
 */

const log = createLogger('permissions')

/** macOS media-access states → our four-state vocabulary. Exported for tests. */
export function fromMediaAccessStatus(status: string): PermissionState {
  switch (status) {
    case 'granted':
      return 'granted'
    case 'denied':
    case 'restricted':
      return 'denied'
    case 'not-determined':
      return 'unknown'
    default:
      return 'unknown'
  }
}

/**
 * Last raw value from macOS, logged when it changes.
 *
 * The four-state vocabulary collapses `denied` and `restricted` into one, and
 * they need completely different advice: a denial the user can reverse in
 * System Settings, a restriction they cannot (it is MDM policy, and the app
 * will not even appear in the Privacy pane). Keeping the raw string in the log
 * is what makes a "the microphone just does not work" report diagnosable.
 */
let lastRawMicrophoneStatus: string | null = null

export function checkPermissions(): PermissionsStatus {
  const status = native().permissions.check()
  if (process.platform !== 'darwin') return status

  try {
    const raw = systemPreferences.getMediaAccessStatus('microphone')
    if (raw !== lastRawMicrophoneStatus) {
      lastRawMicrophoneStatus = raw
      log.info(`microphone access status: ${raw}`)
    }
    return { ...status, microphone: fromMediaAccessStatus(raw) }
  } catch (error) {
    log.warn('reading microphone access status failed:', error)
    return status
  }
}

export async function requestPermission(kind: PermissionKind): Promise<PermissionsStatus> {
  if (kind === 'microphone' && process.platform === 'darwin') {
    try {
      // Triggers the real TCC prompt the first time, and is the call that
      // registers Murmur in System Settings so a denial can be reversed there.
      // Already-denied returns false without re-prompting — macOS only ever
      // asks once — which is why the Hub pairs this with an "Open Settings"
      // deep link rather than treating false as final.
      const granted = await systemPreferences.askForMediaAccess('microphone')
      log.info(`microphone access ${granted ? 'granted' : 'not granted'}`)
    } catch (error) {
      log.warn('requesting microphone access failed:', error)
    }
    return checkPermissions()
  }

  await native().permissions.request(kind)
  return checkPermissions()
}
