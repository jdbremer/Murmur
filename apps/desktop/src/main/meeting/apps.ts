/**
 * Which applications count as "a meeting is happening" (PLAN §18.2).
 *
 * Substring matching, same shape as `dictation/app-category.ts`, and for a
 * reason that only shows up once you look at what CoreAudio actually reports:
 * **the process holding the audio is a helper, not the app.** Teams appears as
 * `com.microsoft.teams2.modulehost` and three separate
 * `com.microsoft.teams2.helper` processes; Slack as
 * `com.tinyspeck.slackmacgap.helper`. There is no `com.microsoft.teams` row at
 * all, so an equality check would match nothing.
 */

export interface MeetingApp {
  /** Bundle-id prefix, lower-cased. */
  pattern: string
  name: string
  /**
   * True when the app is a browser. Browsers cannot be trusted on bundle id
   * alone — Google Meet in Chrome is indistinguishable from any other tab —
   * so they additionally require a window title that looks like a meeting.
   */
  browser?: boolean
}

export const MEETING_APPS: readonly MeetingApp[] = Object.freeze([
  { pattern: 'us.zoom.xos', name: 'Zoom' },
  { pattern: 'com.microsoft.teams', name: 'Teams' },
  { pattern: 'com.cisco.webexmeetingsapp', name: 'Webex' },
  { pattern: 'cisco-systems.spark', name: 'Webex' },
  { pattern: 'com.tinyspeck.slackmacgap', name: 'Slack' },
  { pattern: 'com.hnc.discord', name: 'Discord' },
  { pattern: 'com.apple.facetime', name: 'FaceTime' },
  { pattern: 'com.google.chrome', name: 'Chrome', browser: true },
  { pattern: 'com.apple.safari', name: 'Safari', browser: true },
  { pattern: 'com.microsoft.edge', name: 'Edge', browser: true },
  { pattern: 'company.thebrowser.browser', name: 'Arc', browser: true },
  { pattern: 'com.brave.browser', name: 'Brave', browser: true },
])

/**
 * Murmur's own audio process.
 *
 * Excluding "our own pid" is not enough and would have been a real bug: the
 * process that holds Murmur's microphone is an Electron *renderer* helper
 * (`com.murmur.app.helper`), not the main process, so Murmur would have
 * detected itself as a meeting every time the mic went warm.
 */
export const SELF_PREFIX = 'com.murmur.app'

/** Window titles that mean a browser tab really is in a call. */
const MEETING_TITLES = [
  'meet.google.com',
  'google meet',
  'zoom.us',
  'teams.microsoft.com',
  'microsoft teams',
  'webex',
  'whereby',
  'gather',
  'around.co',
]

export function matchMeetingApp(bundleId: string | null): MeetingApp | null {
  if (!bundleId) return null
  const normalised = bundleId.toLowerCase()
  if (normalised.startsWith(SELF_PREFIX)) return null
  for (const app of MEETING_APPS) {
    if (normalised.includes(app.pattern)) return app
  }
  return null
}

export function titleLooksLikeMeeting(title: string | null): boolean {
  if (!title) return false
  const lower = title.toLowerCase()
  return MEETING_TITLES.some((needle) => lower.includes(needle))
}

/**
 * A readable meeting name from a window title.
 *
 * Browsers append their own chrome — `Weekly Sync - Google Meet - Google
 * Chrome` — which nobody wants as a file name.
 */
export function titleToMeetingName(title: string, appName: string): string {
  const parts = title
    .split(/\s+[-—|]\s+/)
    .map((part) => part.trim())
    .filter(Boolean)
  const dropped = parts.filter(
    (part) => !titleLooksLikeMeeting(part) && part.toLowerCase() !== appName.toLowerCase(),
  )
  const best = dropped[0] ?? parts[0] ?? appName
  return best.length > 1 ? best : appName
}
