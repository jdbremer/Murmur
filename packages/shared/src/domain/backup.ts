import { z } from 'zod'

import { DictationRecordSchema, type DictationRecord } from './dictation'
import { DictionaryEntrySchema, type DictionaryEntry } from './dictionary'
import { deriveNoteTitle, NoteSchema, type Note } from './note'
import { SnippetSchema, type Snippet } from './snippet'

/**
 * Getting your data out (PLAN §10.5).
 *
 * Murmur's whole argument is that your dictations never leave your machine.
 * That argument has a hole in it if they cannot leave your machine *when you
 * want them to*: data you can only read inside one app is not really yours, it
 * is hostage in a nicer prison. Export is the other half of the local-first
 * promise, not a nice-to-have bolted on the side.
 *
 * Everything here is a pure function from records to a string, so the shape of
 * a CSV cell containing a comma, a quote and a newline is decided once and
 * tested — rather than being discovered by a spreadsheet three months from now.
 */

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

export const HISTORY_EXPORT_FORMATS = ['json', 'csv', 'md', 'txt'] as const
export const HistoryExportFormatSchema = z.enum(HISTORY_EXPORT_FORMATS)
export type HistoryExportFormat = z.infer<typeof HistoryExportFormatSchema>

/**
 * One CSV field, RFC 4180.
 *
 * Dictations are prose: they contain commas constantly, quotation marks often,
 * and newlines whenever someone dictated a list. All three break a naive
 * `join(',')`, and the failure is silent — the file opens, the columns are just
 * wrong from row 40 onwards.
 *
 * A leading `=`, `+`, `-` or `@` is prefixed with an apostrophe as well. That
 * is not about CSV at all: spreadsheets treat those as the start of a formula,
 * so a transcript beginning "=- so anyway" becomes a broken cell at best and,
 * in the classic CSV-injection case, something that runs.
 */
export function csvField(value: string): string {
  const dangerous = /^[=+\-@\t\r]/.test(value)
  const escaped = value.replace(/"/g, '""')
  const needsQuotes = dangerous || /[",\n\r]/.test(value)
  const body = dangerous ? `'${escaped}` : escaped
  return needsQuotes ? `"${body}"` : body
}

const CSV_COLUMNS = [
  'timestamp',
  'iso',
  'text',
  'raw_text',
  'app',
  'app_category',
  'duration_ms',
  'stt_model',
  'polish_model',
] as const

export function historyToCsv(records: readonly DictationRecord[]): string {
  const rows = records.map((record) =>
    [
      String(record.ts),
      new Date(record.ts).toISOString(),
      record.polishedText ?? record.rawText,
      record.rawText,
      record.appName ?? record.appBundleId ?? '',
      record.appCategory,
      String(record.durationMs),
      record.sttModelId ?? '',
      record.polishModelId ?? '',
    ]
      .map(csvField)
      .join(','),
  )
  // CRLF, which is what RFC 4180 says and what Excel expects.
  return [CSV_COLUMNS.join(','), ...rows].join('\r\n') + '\r\n'
}

/** Day headers and a paragraph per dictation, in the order they were said. */
export function historyToMarkdown(
  records: readonly DictationRecord[],
  title = 'Dictations',
): string {
  const lines = [`# ${title}`, '']
  let currentDay = ''

  // Oldest first: a document is read forwards, unlike a feed.
  for (const record of [...records].sort((a, b) => a.ts - b.ts)) {
    const date = new Date(record.ts)
    const day = date.toLocaleDateString(undefined, {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    })
    if (day !== currentDay) {
      if (currentDay) lines.push('')
      lines.push(`## ${day}`, '')
      currentDay = day
    }
    const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    const where = record.appName ? ` · ${record.appName}` : ''
    lines.push(`**${time}**${where}`, '', record.polishedText ?? record.rawText, '')
  }

  return lines.join('\n').trimEnd() + '\n'
}

/** Just the words, one dictation per paragraph. */
export function historyToText(records: readonly DictationRecord[]): string {
  return (
    [...records]
      .sort((a, b) => a.ts - b.ts)
      .map((record) => record.polishedText ?? record.rawText)
      .join('\n\n')
      .trimEnd() + '\n'
  )
}

export function historyToJson(records: readonly DictationRecord[]): string {
  return JSON.stringify(records, null, 2) + '\n'
}

export function serializeHistory(
  records: readonly DictationRecord[],
  format: HistoryExportFormat,
): string {
  switch (format) {
    case 'csv':
      return historyToCsv(records)
    case 'md':
      return historyToMarkdown(records)
    case 'txt':
      return historyToText(records)
    case 'json':
      return historyToJson(records)
  }
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

/**
 * A note as a Markdown file, with its metadata in front matter.
 *
 * Front matter rather than a JSON sidecar because the result has to be useful
 * in something that is not Murmur — Obsidian, a git repo, a plain text editor —
 * which is the entire point of exporting.
 */
export function noteToMarkdown(note: Note): string {
  const title = deriveNoteTitle(note)
  const lines = [
    '---',
    `title: ${yamlString(title)}`,
    `created: ${new Date(note.createdAt).toISOString()}`,
    `updated: ${new Date(note.updatedAt).toISOString()}`,
  ]
  if (note.pinned) lines.push('pinned: true')
  lines.push('---', '')
  // The title is only repeated as a heading when it was typed rather than
  // derived — otherwise the first line of the body appears twice.
  if (note.title.trim()) lines.push(`# ${note.title.trim()}`, '')
  lines.push(note.body.trimEnd())
  return lines.join('\n').trimEnd() + '\n'
}

/** Quote only when the value could be mistaken for YAML syntax. */
function yamlString(value: string): string {
  const clean = value.replace(/\r?\n/g, ' ').trim()
  return /^[\w][\w .,'()-]*$/.test(clean) ? clean : JSON.stringify(clean)
}

/**
 * Windows device names, which cannot be used as a filename even with an
 * extension. A note exported as `con.md` is not something the user will ever
 * work out for themselves.
 */
const RESERVED = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`),
])

/**
 * A filename for a note, safe on every platform Murmur ships to.
 *
 * Windows is the strict one: it forbids `\ / : * ? " < > |` and rejects
 * trailing dots and spaces, on top of the reserved names above.
 */
export function noteFileName(note: Note, index: number): string {
  const base = deriveNoteTitle(note)
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
    .replace(/[. ]+$/, '')

  const safe = base.length > 0 && !RESERVED.has(base.toLowerCase()) ? base : `note-${index + 1}`
  return `${safe}.md`
}

/** Make a list of names unique by suffixing repeats, preserving order. */
export function uniqueFileNames(names: readonly string[]): string[] {
  const seen = new Map<string, number>()
  return names.map((name) => {
    const key = name.toLowerCase()
    const count = seen.get(key) ?? 0
    seen.set(key, count + 1)
    if (count === 0) return name
    const dot = name.lastIndexOf('.')
    const stem = dot === -1 ? name : name.slice(0, dot)
    const extension = dot === -1 ? '' : name.slice(dot)
    return `${stem} (${count + 1})${extension}`
  })
}

// ---------------------------------------------------------------------------
// Full backup
// ---------------------------------------------------------------------------

/**
 * The version of the backup *format*, not of the app.
 *
 * A restore has to be able to say "this file is from a newer Murmur than the
 * one you are running" rather than half-importing it, which is why the number
 * lives in the file and is checked before anything is written.
 */
export const BACKUP_VERSION = 1

export const BackupSchema = z.object({
  murmurBackup: z.literal(true),
  version: z.number().int().positive(),
  /** ISO 8601, for the human reading the file. */
  createdAt: z.string(),
  /** The app version that wrote it — diagnostics only, never a gate. */
  appVersion: z.string().default(''),
  dictionary: z.array(DictionaryEntrySchema).default([]),
  snippets: z.array(SnippetSchema).default([]),
  notes: z.array(NoteSchema).default([]),
  /** Empty when the user backed up their setup without their transcripts. */
  history: z.array(DictationRecordSchema).default([]),
  /**
   * Loosely typed on purpose: settings gain fields every release, and a restore
   * that rejected a backup for containing a key this build has since dropped
   * would fail exactly when it is needed most. The settings store validates and
   * defaults on the way back in.
   */
  settings: z.record(z.string(), z.unknown()).nullable().default(null),
})
export type Backup = z.infer<typeof BackupSchema>

export interface BackupInput {
  createdAt: number
  appVersion: string
  dictionary: readonly DictionaryEntry[]
  snippets: readonly Snippet[]
  notes: readonly Note[]
  history: readonly DictationRecord[]
  settings: Record<string, unknown> | null
}

export function buildBackup(input: BackupInput): Backup {
  return {
    murmurBackup: true,
    version: BACKUP_VERSION,
    createdAt: new Date(input.createdAt).toISOString(),
    appVersion: input.appVersion,
    dictionary: [...input.dictionary],
    snippets: [...input.snippets],
    notes: [...input.notes],
    history: [...input.history],
    settings: input.settings,
  }
}

export type BackupReadResult =
  | { ok: true; backup: Backup }
  | { ok: false; reason: 'not-a-backup' | 'too-new' | 'malformed'; detail: string }

/**
 * Parse a file the user picked, refusing anything this build cannot honour.
 *
 * Three distinct failures, because they need three distinct sentences: the
 * wrong file entirely, a backup from a future version, and a backup that is
 * the right shape but corrupt. "Import failed" for all three tells the user
 * nothing about what to do next.
 */
export function readBackup(raw: unknown): BackupReadResult {
  const looksRight =
    typeof raw === 'object' &&
    raw !== null &&
    (raw as { murmurBackup?: unknown }).murmurBackup === true

  if (!looksRight) {
    return { ok: false, reason: 'not-a-backup', detail: 'That file is not a Murmur backup.' }
  }

  const version = (raw as { version?: unknown }).version
  if (typeof version === 'number' && version > BACKUP_VERSION) {
    return {
      ok: false,
      reason: 'too-new',
      detail: `That backup was written by a newer version of Murmur (format ${version}). Update Murmur and try again.`,
    }
  }

  const parsed = BackupSchema.safeParse(raw)
  if (!parsed.success) {
    return {
      ok: false,
      reason: 'malformed',
      detail: 'That is a Murmur backup but it could not be read — it may be truncated.',
    }
  }

  return { ok: true, backup: parsed.data }
}

/** What a restore is about to do, so the user can be asked before it does it. */
export const BackupSummarySchema = z.object({
  dictionary: z.number().int().nonnegative(),
  snippets: z.number().int().nonnegative(),
  notes: z.number().int().nonnegative(),
  history: z.number().int().nonnegative(),
  settings: z.boolean(),
  createdAt: z.string(),
  appVersion: z.string(),
})
export type BackupSummary = z.infer<typeof BackupSummarySchema>

export function summarizeBackup(backup: Backup): BackupSummary {
  return {
    dictionary: backup.dictionary.length,
    snippets: backup.snippets.length,
    notes: backup.notes.length,
    history: backup.history.length,
    settings: backup.settings !== null,
    createdAt: backup.createdAt,
    appVersion: backup.appVersion,
  }
}

function stamp(at: number): string {
  const date = new Date(at)
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-')
}

/** `Murmur backup 2026-08-23.json` — sortable, and obvious in a Downloads folder. */
export function backupFileName(at: number): string {
  return `Murmur backup ${stamp(at)}.json`
}

export function historyExportFileName(at: number, format: HistoryExportFormat): string {
  return `Murmur dictations ${stamp(at)}.${format}`
}
