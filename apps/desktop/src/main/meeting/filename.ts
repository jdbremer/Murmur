import { existsSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

/**
 * Turns a meeting title into a safe, unique file name (PLAN §18.2).
 *
 * The title is **untrusted input** — it comes from a window title belonging to
 * another application, or from a calendar event, neither of which we control.
 * A title of `../../../.zshrc` must not become a path, and one containing a
 * NUL or a newline must not become a file name at all. The containment check
 * at the end mirrors `models/storage.ts`'s `resolveModelPath` for the same
 * reason: sanitising the string is the first line of defence, and asserting the
 * resolved path is still inside the folder is the one that actually holds.
 */

/** Reserved on Windows regardless of extension; harmless to avoid everywhere. */
const RESERVED = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9',
])

/** Leaves room for the date prefix, a dedupe suffix and the extension. */
const MAX_TITLE_CHARS = 80

export function sanitizeTitle(title: string): string {
  const cleaned = Array.from(title.normalize('NFC'))
    // Path separators, the Windows-illegal set, and every control character.
    // Done by code point so an astral character is never cut in half.
    .map((ch) => {
      const code = ch.codePointAt(0) ?? 0
      if (code < 0x20 || code === 0x7f) return ' '
      if ('/\\:*?"<>|'.includes(ch)) return ' '
      return ch
    })
    .join('')
    .replace(/\s+/g, ' ')
    // A leading dot hides the file; a trailing dot or space is stripped by
    // Windows anyway, which would silently change the name we recorded.
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '')

  const capped = capped80(cleaned)
  if (!capped) return 'Meeting'
  if (RESERVED.has(capped.toLowerCase())) return `${capped} meeting`
  return capped
}

function capped80(value: string): string {
  const points = Array.from(value)
  if (points.length <= MAX_TITLE_CHARS) return value
  return points
    .slice(0, MAX_TITLE_CHARS)
    .join('')
    .replace(/[.\s]+$/, '')
}

/** `2026-08-06 1430` in local time — meetings are a local-calendar thing. */
export function stamp(at: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  const date = `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}`
  return `${date} ${p(at.getHours())}${p(at.getMinutes())}`
}

/**
 * Full path for a new transcript, guaranteed unique and inside `folder`.
 *
 * `exists` is injectable so the dedupe loop can be tested without a disk.
 */
export function transcriptPath(
  folder: string,
  title: string,
  at: Date,
  exists: (path: string) => boolean = existsSync,
): string {
  const base = `${stamp(at)} ${sanitizeTitle(title)}`
  const root = resolve(folder)

  for (let n = 1; n < 1000; n += 1) {
    const name = n === 1 ? `${base}.md` : `${base} (${n}).md`
    const candidate = resolve(join(root, name))

    // Belt and braces: sanitizeTitle already removed separators, so reaching
    // here with an escaping path means the sanitiser regressed.
    if (candidate !== join(root, name) || !isInside(root, candidate)) {
      throw new Error(`Refusing to write a transcript outside ${root}`)
    }
    if (!exists(candidate)) return candidate
  }

  throw new Error(`Could not find a free transcript name for "${base}"`)
}

function isInside(root: string, candidate: string): boolean {
  const prefix = root.endsWith(sep) ? root : root + sep
  return candidate.startsWith(prefix)
}
