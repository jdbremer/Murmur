import { useRef, useState } from 'react'

import { deriveNoteTitle, type Note } from '@murmur/shared'

import { Badge, Button, EmptyState, ErrorCard, Section, TextInput } from '../../components/Section'
import { SkeletonList } from '../../components/Skeleton'
import { formatTimestamp } from '../../format'
import { useNotes } from '../../hooks/useNotes'
import { useFocusShortcut } from '../../hooks/useFocusShortcut'
import { useToast } from '../components/ToastHost'

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
  const toast = useToast()
  const searchRef = useRef<HTMLInputElement | null>(null)
  useFocusShortcut(searchRef)

  const open = (noteId: string | null): void => {
    void window.murmur.notes.openWindow({ noteId })
  }

  /**
   * Delete a note, reversibly.
   *
   * The confirmation dialog it replaces was the wrong instrument: notes are
   * deleted often enough that a modal in the way becomes something you dismiss
   * without reading, which is exactly when it stops protecting anything. Undo
   * protects the case the dialog was for and costs nothing the rest of the
   * time. Restoring re-creates rather than un-deletes, so the note comes back
   * with a new id — invisible here, and the pin comes back with it.
   */
  const remove = async (note: Note): Promise<void> => {
    await window.murmur.notes.remove({ id: note.id })
    await refresh()
    toast.show({
      message: `Deleted “${deriveNoteTitle(note)}”`,
      actionLabel: 'Undo',
      onAction: () => {
        void window.murmur.notes
          .create({ title: note.title, body: note.body })
          .then((restored) =>
            note.pinned
              ? window.murmur.notes.update({ id: restored.id, patch: { pinned: true } })
              : restored,
          )
          .then(() => refresh())
      },
    })
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
          inputRef={searchRef}
          value={search}
          onChange={setSearch}
          ariaLabel="Search notes"
          placeholder="Search your notes…   /"
        />
      </div>

      {notes === null ? (
        <SkeletonList label="Loading your notes…" rows={5} seed={5} />
      ) : notes.length === 0 && search ? (
        <EmptyState
          icon="search"
          title={`Nothing matches “${search}”`}
          action={<Button onClick={() => setSearch('')}>Clear search</Button>}
        >
          Search looks through the title and the body of every note.
        </EmptyState>
      ) : notes.length === 0 ? (
        <EmptyState
          icon="notes"
          title="No notes yet"
          action={
            <Button variant="primary" onClick={() => open(null)}>
              New note
            </Button>
          }
        >
          A scratchpad for the thoughts that have nowhere to go yet. Hover the pill and press the
          note button, then hold your dictation key and speak.
        </EmptyState>
      ) : (
        <div className="elev-1 divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface-raised">
          {notes.map((note) => (
            <div
              key={note.id}
              className="group flex items-start gap-4 px-4 py-3 transition-colors duration-150 hover:bg-surface-sunken/60"
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
