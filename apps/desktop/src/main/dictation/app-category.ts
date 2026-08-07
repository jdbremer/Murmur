import type { AppCategory } from '@murmur/shared'

/**
 * Bundle id → tone category (PLAN §2.2.3).
 *
 * Captured at hotkey-**down**, not at insert time: by the time text is ready the
 * user may have switched apps, and the tone should match where they were
 * speaking *into*.
 *
 * In its own module — rather than next to the injector that uses it — so the
 * orchestrator can import it without pulling in Electron's `clipboard`, which is
 * what keeps the whole dictation loop unit-testable outside Electron.
 *
 * Substring matching keeps the table small: `com.tinyspeck` covers every Slack
 * build, `com.microsoft.outlook` covers the whole suite. Unknown apps land in
 * `other`, which has its own tone profile — the mapping is a convenience, not a
 * requirement, and the Style section lets the user override any of it.
 */
const CATEGORY_PATTERNS: readonly { pattern: string; category: AppCategory }[] = Object.freeze([
  { pattern: 'com.apple.mail', category: 'email' },
  { pattern: 'com.microsoft.outlook', category: 'email' },
  { pattern: 'com.readdle.smartemail', category: 'email' },
  { pattern: 'com.superhuman', category: 'email' },
  { pattern: 'com.mimestream', category: 'email' },
  { pattern: 'com.tinyspeck', category: 'work' },
  { pattern: 'com.microsoft.teams', category: 'work' },
  { pattern: 'notion.id', category: 'work' },
  { pattern: 'com.linear', category: 'work' },
  { pattern: 'com.atlassian', category: 'work' },
  { pattern: 'com.github', category: 'work' },
  { pattern: 'com.google.chrome', category: 'work' },
  { pattern: 'com.hnc.discord', category: 'personal' },
  // Messages.app has shipped as `com.apple.MobileSMS` since it replaced iChat.
  { pattern: 'com.apple.mobilesms', category: 'personal' },
  { pattern: 'net.whatsapp', category: 'personal' },
  { pattern: 'org.telegram', category: 'personal' },
  { pattern: 'com.apple.notes', category: 'personal' },
])

export function categoryForBundleId(bundleId: string | null): AppCategory {
  if (!bundleId) return 'other'
  const normalised = bundleId.toLowerCase()
  for (const { pattern, category } of CATEGORY_PATTERNS) {
    if (normalised.includes(pattern)) return category
  }
  return 'other'
}

/**
 * Chat apps, where a message ending in a full stop reads as curt.
 *
 * A *separate* list rather than a reuse of the categories above, because the
 * two questions are genuinely different. `personal` covers Notes and `work`
 * covers Chrome and Notion — long-form writing where a closing full stop is
 * simply correct punctuation. Keying the trailing-period rule on category
 * would strip it from a paragraph of notes, which is a typo, not a style.
 *
 * Deliberately narrow: this list only grows when an app is somewhere people
 * send short messages to each other.
 */
const MESSAGING_PATTERNS: readonly string[] = Object.freeze([
  'com.apple.mobilesms',
  'net.whatsapp',
  'org.telegram',
  'com.hnc.discord',
  'com.tinyspeck',
  'com.microsoft.teams',
  'com.signal',
  'com.facebook.archon', // Messenger
])

export function isMessagingApp(bundleId: string | null): boolean {
  if (!bundleId) return false
  const normalised = bundleId.toLowerCase()
  return MESSAGING_PATTERNS.some((pattern) => normalised.includes(pattern))
}
