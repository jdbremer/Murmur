import { z } from 'zod'

/**
 * Notes — the Scratchpad's storage (PLAN §2.2.7).
 *
 * A place to put a thought that is not already an app you had open. Reached
 * from the Bar's hover cluster, which opens a small floating window you can
 * dictate straight into: the note window is an ordinary focusable window, so it
 * is the frontmost app and the existing clipboard-paste injector fills it with
 * no new pipeline code.
 *
 * ## These are documents, not history
 *
 * Everything else Murmur stores as text — dictations, meeting transcripts — is
 * a *record* of something that happened, and is swept by the retention policy
 * for exactly that reason. A note is something the user wrote and expects to
 * find later. `historyRetention` therefore does not touch this table, and the
 * only thing that deletes a note is the user deleting it.
 *
 * Plain text rather than rich text, deliberately. A rich-text editor is a large
 * dependency and a serialisation format to own forever; Markdown in a textarea
 * is what the rest of this app is, and it is what a transcript pastes into
 * cleanly.
 */

export const NoteSchema = z.object({
  id: z.string().min(1),
  /**
   * The note's title. Derived from the first line when the user has not set
   * one, which is what {@link deriveNoteTitle} is for — an untitled note in a
   * list is unfindable, and asking for a title before a thought is written is
   * the fastest way to lose the thought.
   */
  title: z.string().max(200),
  body: z.string().max(1_000_000),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  /** Pinned notes sort first, whatever their age. */
  pinned: z.boolean(),
})
export type Note = z.infer<typeof NoteSchema>

export const NoteDraftSchema = z.object({
  title: z.string().max(200).default(''),
  body: z.string().max(1_000_000).default(''),
})
export type NoteDraft = z.infer<typeof NoteDraftSchema>

/** Sparse update. Omitted fields are left alone. */
export const NotePatchSchema = z
  .object({
    title: z.string().max(200),
    body: z.string().max(1_000_000),
    pinned: z.boolean(),
  })
  .partial()
export type NotePatch = z.infer<typeof NotePatchSchema>

export const NoteQuerySchema = z.object({
  /** Full-text query against title and body; empty = everything. */
  search: z.string().default(''),
  limit: z.number().int().positive().max(500).default(200),
})
export type NoteQuery = z.infer<typeof NoteQuerySchema>

export const NoteListSchema = z.object({
  notes: z.array(NoteSchema),
  total: z.number().int().nonnegative(),
})
export type NoteList = z.infer<typeof NoteListSchema>

/** How long an untitled note's derived title may run before it is cut. */
export const NOTE_TITLE_MAX = 60

/**
 * A title for a note that has not been given one.
 *
 * The first non-empty line, trimmed of Markdown heading marks and cut at a word
 * boundary. Derived at read time rather than written into the row, so the title
 * keeps up with a note the user is still typing — storing it would need a write
 * per keystroke to stay true, and would go stale the moment one was missed.
 */
export function deriveNoteTitle(note: Pick<Note, 'title' | 'body'>): string {
  if (note.title.trim()) return note.title.trim()

  const firstLine = note.body
    .split('\n')
    // `\s+`, not `\s*`: Markdown requires a space after the hashes, so
    // "#nohash" is a tag the user wrote and must survive intact.
    .map((line) => line.replace(/^#{1,6}\s+/, '').trim())
    .find((line) => line.length > 0)

  if (!firstLine) return 'Untitled note'
  if (firstLine.length <= NOTE_TITLE_MAX) return firstLine

  // Cut at the last space before the limit, so a title never ends mid-word.
  const cut = firstLine.slice(0, NOTE_TITLE_MAX)
  const lastSpace = cut.lastIndexOf(' ')
  return `${(lastSpace > NOTE_TITLE_MAX / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`
}
