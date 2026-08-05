/**
 * What the renderer is allowed to know about the machine.
 *
 * The renderer has no Node and no `process`, and it should not gain a new IPC
 * channel just to ask what OS it is on. The user-agent string is enough for the
 * two decisions that depend on it — whether to offer System Settings deep links
 * at all, and whether to warn about the built-in double-`fn` dictation
 * conflict — and taking a string parameter keeps both testable.
 */

export type Platform = 'mac' | 'windows' | 'linux' | 'unknown'

export function detectPlatform(userAgent: string): Platform {
  if (/Mac OS X|Macintosh/i.test(userAgent)) return 'mac'
  if (/Windows/i.test(userAgent)) return 'windows'
  if (/Linux|X11|CrOS/i.test(userAgent)) return 'linux'
  return 'unknown'
}

export function isMacPlatform(userAgent: string = navigatorUserAgent()): boolean {
  return detectPlatform(userAgent) === 'mac'
}

/**
 * Where Murmur keeps everything (PLAN §9).
 *
 * Shown in Help so that "it is all on your machine" is a claim with a path
 * attached. It mirrors what `app.getPath('userData')` resolves to for the app
 * name main sets at boot.
 */
export function dataLocation(platform: Platform = detectPlatform(navigatorUserAgent())): string {
  switch (platform) {
    case 'mac':
      return '~/Library/Application Support/Murmur'
    case 'windows':
      return '%APPDATA%\\Murmur'
    default:
      return '~/.config/Murmur'
  }
}

function navigatorUserAgent(): string {
  return typeof navigator === 'undefined' ? '' : navigator.userAgent
}
