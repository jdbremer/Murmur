import { useCallback, useEffect, useRef, useState } from 'react'

import { deriveNoteTitle, type HotkeyKey, type Note } from '@murmur/shared'

import { useNotes } from '../hooks/useNotes'
import { NoteList } from '../components/NoteList'

/**
 * The Scratchpad window (PLAN §2.2.7), matching the reference product's
 * scratchpad: a full-width header with the note's title and a new-note "+",
 * a collapsible icon rail on the left (toggle · new note · search), the note
 * itself on a raised card, a "fn to dictate" hint in the empty state, and a
 * floating black Copy pill.
 *
 * Dictating into it needs no new pipeline code: this is an ordinary focusable
 * window, so it is the frontmost app and the existing clipboard-paste injector
 * fills the textarea exactly as it would any other editor.
 *
 * ## Why the editor's text is a *draft*, not a copy
 *
 * `draft` holds the user's unsaved keystrokes and nothing else; the displayed
 * text falls back to the stored note whenever there is no draft for it. That
 * removes the usual copy-into-state-on-select effect — which fights every
 * refresh the autosave itself triggers — and means an edit arriving from
 * elsewhere (a dictation landing, the Hub deleting the note) shows up
 * immediately, right up until the moment the user starts typing over it.
 */

/**
 * How long after the last keystroke the note is written.
 *
 * Long enough that ordinary typing is one write per pause rather than one per
 * character; short enough that closing the window a moment after typing cannot
 * lose the sentence. The flush on blur and unmount below covers the rest.
 */
const AUTOSAVE_MS = 400

/** How the hotkey reads in the empty-state badge. Unmappable keys show a mic. */
const HOTKEY_HINT: Partial<Record<HotkeyKey, string>> = {
  fn: 'fn',
  rightCmd: '⌘',
  rightOpt: '⌥',
  rightCtrl: 'ctrl',
  capsLock: 'caps',
}

export function Scratchpad(): React.JSX.Element {
  const [search, setSearch] = useState('')
  const { notes, refresh } = useNotes(search)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [draft, setDraft] = useState<{ id: string; text: string } | null>(null)
  const [saving, setSaving] = useState(false)
  /** The rail starts as icons only, like the reference; the toggle opens it. */
  const [railOpen, setRailOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const [hotkeyKey, setHotkeyKey] = useState<HotkeyKey>('fn')

  const editorRef = useRef<HTMLTextAreaElement | null>(null)
  const searchRef = useRef<HTMLInputElement | null>(null)

  // Derived rather than stored: with no explicit selection the newest note is
  // the one on screen, and that stays true as notes arrive without an effect
  // racing the render to say so.
  const activeId = selectedId ?? notes?.[0]?.id ?? null
  const active = notes?.find((note) => note.id === activeId) ?? null
  const body = draft?.id === activeId ? draft.text : (active?.body ?? '')

  useEffect(() => {
    const apply = (settings: { hotkey: { key: HotkeyKey } }): void => {
      setHotkeyKey(settings.hotkey.key)
    }
    void window.murmur.settings.get().then(apply).catch(noop)
    return window.murmur.settings.subscribe(apply)
  }, [])

  const open = useCallback((note: Note) => {
    setSelectedId(note.id)
    editorRef.current?.focus()
  }, [])

  const create = useCallback(async () => {
    const note = await window.murmur.notes.create({ title: '', body: '' })
    setSelectedId(note.id)
    setDraft(null)
    await refresh()
    editorRef.current?.focus()
  }, [refresh])

  // -- autosave -------------------------------------------------------------
  // The pending write lives in a ref as well as in state: the flush has to be
  // able to run from a blur or an unmount, where the latest render's `draft` is
  // no longer reachable.
  const pending = useRef<{ id: string; text: string } | null>(null)

  const flush = useCallback(async () => {
    const write = pending.current
    if (!write) return
    pending.current = null
    setSaving(true)
    try {
      await window.murmur.notes.update({ id: write.id, patch: { body: write.text } })
    } finally {
      setSaving(false)
    }
  }, [])

  const edit = (text: string): void => {
    if (activeId === null) return
    setDraft({ id: activeId, text })
    pending.current = { id: activeId, text }
  }

  // Main says which note to show when this window is opened from the Hub or the
  // Bar. Without it the `activeId` fallback picks whichever note sorts first —
  // always the newest — so clicking a three-week-old note in the Hub raised
  // this window on a different document.
  //
  // `flush` has empty deps and therefore a stable identity, so this subscribes
  // once despite listing it.
  useEffect(
    () =>
      window.murmur.notes.onSelect(({ id }) => {
        // Whatever is half-typed belongs to the note being left, and the
        // autosave debounce has not fired yet.
        void flush()
        setDraft(null)
        setSelectedId(id)
        editorRef.current?.focus()
      }),
    [flush],
  )

  useEffect(() => {
    if (draft === null) return
    const timer = setTimeout(() => void flush(), AUTOSAVE_MS)
    return () => clearTimeout(timer)
  }, [draft, flush])

  // A note half-written when the window loses focus or closes is the exact case
  // autosave exists for, and a debounce is the exact thing that loses it.
  useEffect(() => {
    const onLeave = (): void => void flush()
    window.addEventListener('beforeunload', onLeave)
    window.addEventListener('blur', onLeave)
    return () => {
      window.removeEventListener('beforeunload', onLeave)
      window.removeEventListener('blur', onLeave)
      void flush()
    }
  }, [flush])

  const copy = async (): Promise<void> => {
    if (!body.trim()) return
    await window.murmur.app.copyText({ text: body })
    setCopied(true)
    setTimeout(() => setCopied(false), 1_400)
  }

  const hint = HOTKEY_HINT[hotkeyKey] ?? null

  return (
    <div className="flex h-full flex-col bg-canvas text-ink">
      {/* Full-width header, and the window's drag handle. pl-20 clears the
          inset traffic lights on macOS. */}
      <header className="notes-drag flex h-11 shrink-0 items-center gap-2 pl-20 pr-3">
        {/* The wordmark's glyph — same as the Hub sidebar. */}
        <svg
          viewBox="0 0 24 24"
          aria-hidden="true"
          className="size-[15px] shrink-0 text-ink"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
        >
          <path d="M4 10.5v3M8 8v8M12 5v14M16 8v8M20 10.5v3" />
        </svg>

        <span className="min-w-0 truncate text-[14px] font-semibold tracking-tight">
          {active ? deriveNoteTitle(active) : 'Untitled'}
        </span>

        <button
          type="button"
          aria-label="New note"
          title="New note"
          onClick={() => void create()}
          className="notes-no-drag grid size-7 shrink-0 place-items-center rounded-lg text-ink-muted transition-colors duration-150 hover:bg-surface hover:text-ink"
        >
          <PlusIcon />
        </button>

        <span aria-live="polite" className="ml-auto text-[11px] text-ink-faint">
          {saving ? 'Saving…' : ''}
        </span>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* The rail: icons only until opened, exactly like the reference. */}
        <aside
          className="flex shrink-0 flex-col gap-1 overflow-hidden py-2 pl-2 transition-[width] duration-200 ease-out"
          style={{ width: railOpen ? 224 : 48 }}
        >
          <RailButton
            label={railOpen ? 'Collapse Notes' : 'Expand Notes'}
            open={railOpen}
            onClick={() => setRailOpen((current) => !current)}
          >
            <path d="M4.5 5h15a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM9.5 5v14" />
          </RailButton>

          <RailButton label="New note" open={railOpen} onClick={() => void create()}>
            <path d="M5 6.5A1.5 1.5 0 0 1 6.5 5H11M17.7 4.3a1.6 1.6 0 0 1 2.3 2.3l-7.3 7.3-3 .7.7-3zM19 13v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 17.5v-11" />
          </RailButton>

          {railOpen ? (
            <div className="px-1 pt-1">
              <div className="flex items-center gap-2 border-b border-line pb-2">
                <SearchIcon className="size-[15px] shrink-0 text-ink-faint" />
                <input
                  ref={searchRef}
                  type="text"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search notes…"
                  aria-label="Search notes"
                  className="w-full bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-faint"
                />
              </div>
            </div>
          ) : (
            <RailButton
              label="Search notes"
              open={false}
              onClick={() => {
                setRailOpen(true)
                // Focus once the rail has painted its expanded layout.
                setTimeout(() => searchRef.current?.focus(), 120)
              }}
            >
              <path d="M10.5 4a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13zM15.5 15.5 20 20" />
            </RailButton>
          )}

          {railOpen ? (
            <div className="min-h-0 flex-1 overflow-y-auto px-1 pt-1.5">
              {notes !== null && notes.length === 0 ? (
                <p className="py-8 text-center text-[13px] text-ink-muted">No notes yet</p>
              ) : (
                <NoteList notes={notes} activeId={activeId} onOpen={open} />
              )}
            </div>
          ) : null}
        </aside>

        {/* The note, on its raised card. */}
        <main className="relative min-w-0 flex-1 p-2 pl-1">
          <div className="relative h-full overflow-hidden rounded-xl border border-line bg-surface shadow-sm">
            {activeId === null ? (
              <EmptyHint hint={hint} />
            ) : (
              <>
                <textarea
                  ref={editorRef}
                  value={body}
                  onChange={(event) => edit(event.target.value)}
                  spellCheck
                  aria-label="Note"
                  className="h-full w-full resize-none bg-transparent p-5 text-[14px] leading-relaxed text-ink outline-none"
                />
                {/* The dictation hint sits beside the caret while the note is
                    empty — the reference's "fn to dictate". */}
                {body === '' ? <EmptyHint hint={hint} inset /> : null}
              </>
            )}

            <button
              type="button"
              onClick={() => void copy()}
              disabled={!body.trim()}
              className="notes-copy absolute bottom-4 right-4 flex items-center gap-2 rounded-full px-4 py-2.5 text-[13px] font-medium text-white transition-[transform,opacity] duration-150 hover:scale-[1.03] active:scale-[0.97] disabled:opacity-40"
            >
              <svg
                viewBox="0 0 24 24"
                aria-hidden="true"
                className="size-[15px]"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.9"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M9 9h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1zM6 15H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v1" />
              </svg>
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        </main>
      </div>
    </div>
  )
}

/** "fn — to dictate", offset so it never sits under the caret. */
function EmptyHint({
  hint,
  inset = false,
}: {
  hint: string | null
  inset?: boolean
}): React.JSX.Element {
  return (
    <div
      className={`pointer-events-none flex items-center gap-2.5 text-ink-faint ${
        inset ? 'absolute left-8 top-5' : 'h-full justify-center'
      }`}
    >
      <span className="grid size-7 place-items-center rounded-full bg-canvas text-[11px] font-semibold text-ink-muted ring-1 ring-line">
        {hint ?? '🎙'}
      </span>
      <span className="text-[15px]">to dictate</span>
    </div>
  )
}

function RailButton({
  label,
  open,
  onClick,
  children,
}: {
  label: string
  /** Expanded rail shows the label beside the icon; collapsed shows icon only. */
  open: boolean
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="flex h-9 shrink-0 items-center gap-2.5 whitespace-nowrap rounded-lg px-2 text-[13px] font-medium text-ink-muted transition-colors duration-150 hover:bg-surface hover:text-ink"
    >
      <svg
        viewBox="0 0 24 24"
        aria-hidden="true"
        className="size-[17px] shrink-0"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {children}
      </svg>
      {open ? label : null}
    </button>
  )
}

function PlusIcon(): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className="size-[15px]"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
    >
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}

function SearchIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
    >
      <path d="M10.5 4a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13zM15.5 15.5 20 20" />
    </svg>
  )
}

function noop(): void {
  /* a fire-and-forget IPC failure is not actionable here */
}
