import { deriveNoteTitle, type Note } from '@murmur/shared'

import { Spinner } from './Section'
import { formatTimestamp } from '../format'

/**
 * The note list, shared by the Scratchpad window and the Hub's Notes section.
 *
 * One component in two places because the two are genuinely the same list —
 * the only difference is how much room it has, which `compact` covers. A second
 * implementation would drift on the thing that matters most here: which note
 * the user is looking at.
 */
export function NoteList({
  notes,
  activeId,
  onOpen,
  compact = false,
}: {
  /** `null` while loading — distinct from an empty array, which means none. */
  notes: Note[] | null
  activeId?: string | null
  onOpen: (note: Note) => void
  compact?: boolean
}): React.JSX.Element {
  if (notes === null) {
    return (
      <div className="grid place-items-center py-6" role="status">
        <Spinner />
      </div>
    )
  }

  if (notes.length === 0) {
    return (
      <p
        className={`px-2 py-4 text-center text-ink-muted ${compact ? 'text-[11px]' : 'text-[13px]'}`}
      >
        No notes.
      </p>
    )
  }

  return (
    <ul className={compact ? 'space-y-0.5' : 'space-y-1.5'}>
      {notes.map((note) => (
        <li key={note.id}>
          <button
            type="button"
            onClick={() => onOpen(note)}
            aria-current={note.id === activeId ? 'true' : undefined}
            className={[
              'w-full rounded-lg px-2 py-1.5 text-left transition-colors duration-150',
              note.id === activeId
                ? 'bg-accent-soft text-accent'
                : 'text-ink-muted hover:bg-surface hover:text-ink',
            ].join(' ')}
          >
            <span
              className={`block truncate font-medium ${compact ? 'text-[11.5px]' : 'text-[13px]'}`}
            >
              {note.pinned ? '📌 ' : ''}
              {deriveNoteTitle(note)}
            </span>
            <span
              className={`block truncate text-ink-faint ${compact ? 'text-[10px]' : 'text-[11px]'}`}
            >
              {formatTimestamp(note.updatedAt)}
            </span>
          </button>
        </li>
      ))}
    </ul>
  )
}
