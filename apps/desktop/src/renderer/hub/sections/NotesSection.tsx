import { useState } from 'react'

import { deriveNoteTitle, type Note } from '@murmur/shared'

import {
  Badge,
  Button,
  EmptyState,
  ErrorCard,
  LoadingState,
  Section,
  TextInput,
} from '../../components/Section'
import { formatTimestamp } from '../../format'
import { useNotes } from '../../hooks/useNotes'

/**
 * Scratchpad (PLAN §2.2.7) — the floating window's other half.
 *
 * The floating window is for *capture*: one button on the Bar, and a thought
 * has somewhere to go. This is for everything after that — finding a note from
 * three weeks ago, pinning the one you keep coming back to, throwing away the
 * six that were only ever a phone number.
 *
 * Search runs through the same FTS5 index the history feed uses. Editing opens
 * the floating window rather than being duplicated here: two editors over one
 * document is how a document gets a conflict.
 */
export function NotesSection(): React.JSX.Element {
  const [search, setSearch] = useState('')
  const { notes, error, refresh } = useNotes(search)

  const open = (noteId: string | null): void => {
    void window.murmur.notes.openWindow({ noteId })
  }

  const remove = async (note: Note): Promise<void> => {
    if (!window.confirm(`Delete “${deriveNoteTitle(note)}”? This cannot be undone.`)) return
    await window.murmur.notes.remove({ id: note.id })
    await refresh()
  }

  const togglePin = async (note: Note): Promise<void> => {
    await window.murmur.notes.update({ id: note.id, patch: { pinned: !note.pinned } })
  }

  return (
    <Section
      title="Scratchpad"
      description="Your notes. Kept until you delete them — the history retention window does not touch these."
      actions={<Button onClick={() => open(null)}>New note</Button>}
    >
      {error ? <ErrorCard>{error}</ErrorCard> : null}

      <div className="mb-5">
        <TextInput
          value={search}
          onChange={setSearch}
          ariaLabel="Search notes"
          placeholder="Search your notes…"
        />
      </div>

      {notes === null ? (
        <LoadingState label="Loading your notes…" />
      ) : notes.length === 0 ? (
        <EmptyState>
          {search
            ? `Nothing matches “${search}”.`
            : 'No notes yet. Hover the pill and press the note button, or use New note above — then hold your dictation key and speak.'}
        </EmptyState>
      ) : (
        <div className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
          {notes.map((note) => (
            <div
              key={note.id}
              className="group flex items-start gap-4 px-4 py-3 transition-colors duration-150 hover:bg-canvas/60"
            >
              <button
                type="button"
                onClick={() => open(note.id)}
                className="min-w-0 flex-1 text-left"
              >
                <span className="flex items-center gap-2">
                  <span className="truncate text-[13px] font-medium text-ink">
                    {deriveNoteTitle(note)}
                  </span>
                  {note.pinned ? <Badge tone="accent">Pinned</Badge> : null}
                </span>
                {/* One line of the body, so a list of similar titles is still
                    tellable apart at a glance. */}
                <span className="mt-0.5 block truncate text-[12px] text-ink-muted">
                  {firstBodyLine(note) || 'Empty note'}
                </span>
              </button>

              <span className="shrink-0 pt-px text-[12px] text-ink-faint">
                {formatTimestamp(note.updatedAt)}
              </span>

              <div className="flex shrink-0 items-center gap-2 opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover:opacity-100">
                <Button onClick={() => void togglePin(note)}>
                  {note.pinned ? 'Unpin' : 'Pin'}
                </Button>
                <Button onClick={() => void remove(note)} variant="danger">
                  Delete
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </Section>
  )
}

/** The first line of body text that is not the line already used as the title. */
function firstBodyLine(note: Note): string {
  const lines = note.body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  // When the title was derived from the body, the first line is already shown
  // above; the preview should be the *next* thing the note says.
  return (note.title.trim() ? lines[0] : lines[1]) ?? ''
}
