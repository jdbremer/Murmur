import type { MurmurNative } from '@murmur/shared'

/**
 * Vibe coding: reading the editor you are dictating into (PLAN §18.3).
 *
 * Two things come out of it, and they are separate features with separate
 * switches:
 *
 *  - **Variable recognition** — the identifiers on screen become recognition
 *    context, so `useCallback` and `barBounds` come back spelled that way
 *    instead of as "use callback" and "bar bounds".
 *  - **File tagging** — a spoken filename becomes the real one, and in Cursor
 *    and Windsurf gets an `@` so their chat attaches the file.
 *
 * ## The privacy shape, because this is the exception to Murmur's usual promise
 *
 * Every other thing this app learns about the app you are dictating into is a
 * bundle id. This reads the text of the focused editor, and that is a real
 * expansion of scope — so it is gated four ways, and every gate is here rather
 * than in the native layer, which cannot see any of them:
 *
 *  1. **Off by default.** `settings.vibeCoding.variableRecognition` starts
 *     false and nothing calls into native until it is true.
 *  2. **An allowlist of three apps.** VS Code, Cursor, Windsurf. Not "editors",
 *     not "apps whose window title ends in .ts" — three bundle ids.
 *  3. **Nothing is stored.** The extracted terms live in the cache below, in
 *     memory, for seconds. No row, no file, no log line — the extraction result
 *     is never passed to the logger at any level.
 *  4. **Secure fields are refused** by the native call itself, before anything
 *     crosses into JS.
 *
 * The user still has to turn on their IDE's own Screen Reader Accessibility
 * Mode for any of this to return anything: VS Code and its forks draw the
 * editor on a canvas. Murmur does not, and cannot, turn that on for them.
 */

/**
 * The three IDEs, by bundle id. Substring-matched like `app-category.ts`, so
 * per-channel builds (Cursor Nightly, a Windsurf beta) are covered.
 */
const IDE_PATTERNS: readonly { pattern: string; id: SupportedIde }[] = Object.freeze([
  { pattern: 'com.microsoft.vscode', id: 'vscode' },
  // Cursor ships through ToDesktop, hence the opaque id.
  { pattern: 'com.todesktop.230313mzl4w4u92', id: 'cursor' },
  { pattern: 'com.exafunction.windsurf', id: 'windsurf' },
])

export type SupportedIde = 'vscode' | 'cursor' | 'windsurf'

export const IDE_LABEL: Record<SupportedIde, string> = {
  vscode: 'VS Code',
  cursor: 'Cursor',
  windsurf: 'Windsurf',
}

/**
 * Builds excluded even though they match a pattern above.
 *
 * VS Code Insiders is `com.microsoft.VSCodeInsiders`, which contains the
 * release channel's id as a prefix — so the substring matching that makes the
 * list short would sweep it in. It has to be named here because its
 * screen-reader mode does not expose the editor the way the release build's
 * does, and listing it would ship a feature that silently returns nothing.
 */
const IDE_DENY: readonly string[] = Object.freeze(['com.microsoft.vscodeinsiders'])

/**
 * Which IDE is in front, or `null` for everything else in the world.
 *
 * The one function that decides whether the editor read may happen at all.
 */
export function ideForBundleId(bundleId: string | null): SupportedIde | null {
  if (!bundleId) return null
  const normalised = bundleId.toLowerCase()
  if (IDE_DENY.some((denied) => normalised.includes(denied))) return null
  for (const { pattern, id } of IDE_PATTERNS) {
    if (normalised.includes(pattern)) return id
  }
  return null
}

/** File tagging only works where the chat understands `@file` — not in VS Code. */
export function supportsFileTagging(ide: SupportedIde): boolean {
  return ide === 'cursor' || ide === 'windsurf'
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/** How much of the editor is read. Enough for a screenful and its imports. */
export const CODE_CONTEXT_MAX_CHARS = 20_000

/**
 * How many identifiers are kept.
 *
 * Bounded because they end up in Whisper's `initial_prompt`, which is charged
 * against the model's context window — `buildInitialPrompt` caps by characters
 * as well, but sending it 4,000 terms to throw 3,900 away is waste at the point
 * in the pipeline that can least afford it.
 */
export const CODE_CONTEXT_MAX_TERMS = 96

/**
 * Language keywords, which are never worth biasing towards: the decoder already
 * knows "function" and "return", and spending prompt budget on them displaces
 * the project-specific names that are the entire point.
 */
const KEYWORDS = new Set(
  (
    'abstract as async await bool boolean break byte case catch char class const constructor ' +
    'continue debugger declare default defer delete do double else enum export extends false ' +
    'final finally float fn for from func function get global go goto if implements import in ' +
    'instanceof int interface is let long map match mod module mut namespace new nil none not ' +
    'null number object or override package private protected pub public raise readonly record ' +
    'ref return sealed select self set short static str string struct super switch synchronized ' +
    'this throw throws trait true try type typeof union unsafe use using val var virtual void ' +
    'when where while with yield'
  ).split(' '),
)

/** Extensions worth recognising as filenames. */
const SOURCE_EXTENSIONS = new Set(
  (
    'ts tsx js jsx mjs cjs py rb go rs java kt kts swift m mm c h cc cpp hpp cs php scala sh ' +
    'bash zsh sql json yaml yml toml ini xml html css scss md mdx vue svelte astro gradle ' +
    'dockerfile lock cfg conf env proto graphql prisma tf'
  ).split(' '),
)

export interface CodeContext {
  /** Identifiers, most frequent first, capped. */
  terms: string[]
  /** Filenames seen in the text, in their real spelling. */
  files: string[]
}

export const EMPTY_CODE_CONTEXT: CodeContext = Object.freeze({ terms: [], files: [] })

/**
 * Pull identifiers and filenames out of a chunk of source.
 *
 * Language-agnostic on purpose. A real parser would be better at this and would
 * also mean carrying a grammar per language, keeping them current, and failing
 * closed on anything unlisted — for a feature whose output is a *hint* to a
 * speech decoder. Frequency-ranked tokens are the right amount of machinery.
 *
 * Multi-word identifiers are contributed **whole and split**: `barBounds`
 * biases the decoder towards hearing that word, and "bar", "bounds" help it
 * hear the pieces when the user says them separately.
 */
export function extractCodeContext(text: string, maxTerms = CODE_CONTEXT_MAX_TERMS): CodeContext {
  const frequency = new Map<string, number>()
  const files: string[] = []
  const seenFiles = new Set<string>()

  // Filenames first, and removed from the identifier pass: `index.ts` should
  // not also contribute a bare "ts".
  const withoutFiles = text.replace(/\b([\w-]+)\.([A-Za-z][\w]{0,9})\b/g, (match, _name, ext) => {
    if (!SOURCE_EXTENSIONS.has(String(ext).toLowerCase())) return match
    const key = match.toLowerCase()
    if (!seenFiles.has(key)) {
      seenFiles.add(key)
      files.push(match)
    }
    return ' '
  })

  for (const token of withoutFiles.match(/[A-Za-z_$][\w$]*/g) ?? []) {
    // One-character names carry no spelling worth biasing towards, and `i`
    // would out-rank every real identifier in the file.
    if (token.length < 3) continue

    const compound = token.includes('_') || /[a-z][A-Z]/.test(token)
    if (!compound && KEYWORDS.has(token.toLowerCase())) continue

    bump(frequency, token)
    if (!compound) continue
    for (const part of splitIdentifier(token)) {
      if (part.length >= 3 && !KEYWORDS.has(part.toLowerCase())) bump(frequency, part)
    }
  }

  const terms = [...frequency.entries()]
    // Frequency first, then longest: with a flat histogram — which is most of a
    // file — the longer name is the one a decoder is more likely to mangle.
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .slice(0, maxTerms)
    .map(([term]) => term)

  return { terms, files }
}

function bump(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1)
}

/** `barBounds` / `bar_bounds` / `BarBounds` → `['bar', 'bounds']`. */
export function splitIdentifier(identifier: string): string[] {
  return (
    identifier
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      // `HTTPServer` → `HTTP Server`, not `H T T P Server`.
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .split(/[\s_$]+/)
      .filter((part) => part.length > 0)
  )
}

// ---------------------------------------------------------------------------
// File tagging
// ---------------------------------------------------------------------------

/**
 * Turn spoken filenames into real ones.
 *
 * "index dot ts" → `index.ts`, and in Cursor and Windsurf `@index.ts`, which is
 * what makes their chat attach the file. Matching is against files actually
 * seen in the editor, never against a guess: rewriting "brief dot txt" into a
 * file that does not exist would put a broken reference in the user's message.
 *
 * Spoken forms handled, in the order a person actually says them:
 *
 *  - `index dot ts` — the "dot" spelled out, which is what STT produces;
 *  - `index.ts` — already correct, only needing the `@` and the real casing;
 *  - `cursor formatting` — the split form of `cursorFormatting.ts`, so a
 *    camelCase filename can be said as words.
 */
export function applyFileTags(
  text: string,
  files: readonly string[],
  options: { at: boolean },
): { text: string; tagged: number } {
  if (files.length === 0) return { text, tagged: 0 }

  let out = text
  let tagged = 0

  // Longest first, so `useNotes.ts` wins over `notes.ts` on the same phrase.
  const ordered = [...files].sort((a, b) => b.length - a.length)

  for (const file of ordered) {
    const dot = file.lastIndexOf('.')
    if (dot <= 0) continue
    const stem = file.slice(0, dot)
    const extension = file.slice(dot + 1)
    const words = splitIdentifier(stem)
    if (words.length === 0) continue

    // `\s*` between the words and around "dot": the polish model may have
    // joined or split them, and it capitalises whatever opens a sentence.
    // `-` last in the class: between `\s` and `_` it reads as a range, which
    // `u` mode rejects outright rather than quietly mis-parsing.
    const spokenStem = words.map(escapeRegExp).join('[\\s_-]*')
    const pattern = new RegExp(
      `(?<![\\p{L}\\p{N}@.])${spokenStem}\\s*(?:\\.|\\bdot\\b)\\s*${escapeRegExp(extension)}(?![\\p{L}\\p{N}.])`,
      'giu',
    )

    out = out.replace(pattern, () => {
      tagged += 1
      return options.at ? `@${file}` : file
    })
  }

  return { text: out, tagged }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ---------------------------------------------------------------------------
// The reader
// ---------------------------------------------------------------------------

/** How long an extraction is reused before the editor is read again. */
export const CODE_CONTEXT_TTL_MS = 4_000

export interface CodeContextReaderOptions {
  native: () => MurmurNative
  /** Both halves of the feature, read fresh per utterance. */
  settings: () => { variableRecognition: boolean; fileTagging: boolean }
  now?: () => number
}

/**
 * Reads the focused editor, with the gates applied and a short-lived cache.
 *
 * The cache exists because this runs at hotkey-down, synchronously, on the JS
 * thread: someone dictating three short instructions in a row into the same
 * file should pay for one accessibility round trip, not three. It holds exactly
 * one entry — the app you are in — in memory, for {@link CODE_CONTEXT_TTL_MS},
 * and is dropped whenever the frontmost app changes.
 *
 * Nothing it holds is ever written anywhere.
 */
export class CodeContextReader {
  readonly #options: CodeContextReaderOptions
  readonly #now: () => number
  #cache: { bundleId: string; at: number; context: CodeContext } | null = null

  constructor(options: CodeContextReaderOptions) {
    this.#options = options
    this.#now = options.now ?? Date.now
  }

  /**
   * Context for the app in front, or empty when any gate says no.
   *
   * Returns `EMPTY_CODE_CONTEXT` rather than null for every refusal — off,
   * not an IDE, no permission, screen-reader mode not enabled — because the
   * caller does the same thing in all four cases and a distinction it cannot
   * act on is a branch waiting to be got wrong.
   */
  read(bundleId: string | null): CodeContext {
    const ide = ideForBundleId(bundleId)
    if (ide === null) return EMPTY_CODE_CONTEXT

    const settings = this.#options.settings()
    if (!settings.variableRecognition && !settings.fileTagging) return EMPTY_CODE_CONTEXT

    const now = this.#now()
    const cached = this.#cache
    if (cached && cached.bundleId === bundleId && now - cached.at < CODE_CONTEXT_TTL_MS) {
      return cached.context
    }

    const native = this.#options.native()
    if (typeof native.readFocusedEditorText !== 'function') return EMPTY_CODE_CONTEXT

    const result = native.readFocusedEditorText(CODE_CONTEXT_MAX_CHARS)
    if (!result.ok || !result.text) return EMPTY_CODE_CONTEXT

    const context = extractCodeContext(result.text)
    this.#cache = { bundleId: bundleId!, at: now, context }
    return context
  }

  /** Drop the cache — on a settings change, or when the feature is turned off. */
  forget(): void {
    this.#cache = null
  }

  /**
   * One probe for the Vibe coding setup card.
   *
   * Reports *whether* the editor can be read and roughly how much was found —
   * never the text, and never the identifiers. The card's job is to tell the
   * user whether Screen Reader Mode is on; showing them their own code back
   * would be a strange way to do it, and would put source into a renderer that
   * has no business holding any.
   */
  probe(bundleId: string | null): {
    ide: SupportedIde | null
    readable: boolean
    symbolCount: number
    detail: string
  } {
    const ide = ideForBundleId(bundleId)
    if (ide === null) {
      return {
        ide: null,
        readable: false,
        symbolCount: 0,
        detail: 'Bring VS Code, Cursor or Windsurf to the front and check again.',
      }
    }

    const native = this.#options.native()
    if (typeof native.readFocusedEditorText !== 'function') {
      return {
        ide,
        readable: false,
        symbolCount: 0,
        detail: 'Reading the editor is macOS-only for now.',
      }
    }

    const result = native.readFocusedEditorText(CODE_CONTEXT_MAX_CHARS)
    if (!result.ok || !result.text) {
      return {
        ide,
        readable: false,
        symbolCount: 0,
        detail: `${IDE_LABEL[ide]} is not exposing its editor text. Run “Toggle Screen Reader Accessibility Mode” from its command palette, click into a file, and check again.`,
      }
    }

    const context = extractCodeContext(result.text)
    return {
      ide,
      readable: true,
      symbolCount: context.terms.length,
      detail: `Reading ${IDE_LABEL[ide]} — ${context.terms.length} names from the open file.`,
    }
  }
}
