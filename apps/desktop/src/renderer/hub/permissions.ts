import type { PermissionKind } from '@murmur/shared'

/**
 * The three macOS permissions Murmur asks for, and what it does *not* do with
 * each (PLAN §2.4, §4).
 *
 * Shared by onboarding and the Help panel so the two can never drift — the copy
 * a user reads while deciding must be the same copy they can go back and check.
 * PLAN §2.4 is explicit that each screen states what is not done; a tool that
 * taps the keyboard and types into other apps has to be specific about that in
 * its own words, not in a privacy policy.
 */
export interface PermissionCopy {
  kind: PermissionKind
  title: string
  /** Why Murmur needs it, in one sentence. */
  why: string
  /** What it deliberately does not do with it. */
  notDone: string
  /** What stops working if it is skipped. */
  ifSkipped: string
}

export const PERMISSIONS: readonly PermissionCopy[] = [
  {
    kind: 'microphone',
    title: 'Microphone',
    why: 'To hear what you dictate. The audio is transcribed on this machine and discarded straight afterwards unless you turn on retention.',
    notDone:
      'The stream stays warm for a few minutes around dictations so the first syllable is never clipped, then closes. Warm audio lives in a rolling ~300 ms buffer that is continuously overwritten — nothing is recorded to disk by default, and nothing ever leaves this machine.',
    ifSkipped: 'Without it Murmur cannot hear you, and dictation does nothing at all.',
  },
  {
    kind: 'accessibility',
    title: 'Accessibility',
    why: 'To type the finished text into whatever app your cursor is in, by pasting it the way you would.',
    notDone:
      'Murmur does not read the contents of your screen or other apps’ windows. It looks up which app is frontmost — the bundle id, nothing else — to pick a tone.',
    ifSkipped:
      'Without it the text cannot be inserted; you would have to paste every dictation yourself.',
  },
  {
    kind: 'inputMonitoring',
    title: 'Input Monitoring',
    why: 'To notice your dictation key being held anywhere on the system, including fn, which no app-level shortcut can see.',
    notDone:
      'The key tap is listen-only and matches one key: the one you chose. No other keystroke is read, stored or sent anywhere — the code that does this is a few lines and open to read.',
    ifSkipped:
      'Without it the global hotkey never fires; you can still start dictation from the menu bar.',
  },
]

export function permissionCopy(kind: PermissionKind): PermissionCopy {
  const found = PERMISSIONS.find((permission) => permission.kind === kind)
  if (!found) throw new Error(`No copy for permission "${kind}"`)
  return found
}
