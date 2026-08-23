import { useEffect, useMemo, useRef, useState } from 'react'

import { ALL_SECTIONS } from '../Sidebar'
import { useNavigate, type SectionId } from '../navigation'
import { useToast } from '../components/ToastHost'
import { rankBy } from './match'

/**
 * The command palette (PLAN §2.2.8) — ⌘K.
 *
 * The Hub had no keyboard shortcuts at all. Not one: every one of thirteen
 * sections was a mouse trip to the sidebar, which is a strange thing for an app
 * whose entire premise is that reaching for the mouse is the slow part.
 *
 * Scope is deliberately narrow. It goes places and it runs the handful of
 * things that are one-shot and safe — it does not delete, download or dictate
 * into anything. A palette that can do everything is a palette you have to read
 * before pressing Enter, and one you have to read is slower than the sidebar it
 * replaced.
 */

export interface Command {
  id: string
  title: string
  /** Groups the results; also the only label a result carries. */
  group: string
  /** Words someone might type that are not in the title. */
  keywords?: readonly string[] | undefined
  run: () => void
}

/** Where the sidebar's own labels come from, so the two can never drift. */
const SECTION_KEYWORDS: Partial<Record<SectionId, readonly string[]>> = {
  dashboard: ['home', 'start', 'overview'],
  history: ['transcripts', 'log', 'past', 'search'],
  insights: ['stats', 'numbers', 'streak', 'words'],
  notes: ['scratchpad', 'jot'],
  dictionary: ['words', 'vocabulary', 'spelling', 'names'],
  snippets: ['expansion', 'shortcut', 'macro'],
  style: ['tone', 'polish', 'formality'],
  meetings: ['call', 'record', 'zoom'],
  transcribe: ['file', 'audio', 'video', 'mp3', 'upload'],
  models: ['download', 'whisper', 'engine', 'gguf'],
  vibeCoding: ['code', 'editor', 'ide'],
  settings: ['preferences', 'hotkey', 'microphone', 'theme'],
  help: ['permissions', 'support', 'troubleshoot'],
}

export function CommandPalette(): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const navigate = useNavigate()
  const toast = useToast()

  const inputRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLUListElement | null>(null)
  /** Where focus was before the palette took it. */
  const restoreRef = useRef<HTMLElement | null>(null)

  const commands = useMemo<Command[]>(
    () => buildCommands(navigate, (message) => toast.show({ message, tone: 'positive' })),
    [navigate, toast],
  )

  const results = useMemo(() => rankBy(commands, query).slice(0, MAX_RESULTS), [commands, query])

  // ⌘K / Ctrl+K anywhere, and Escape to leave.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        // Reset here rather than in an effect on `open`: an effect that sets
        // state the moment it runs is a second render for no reason, and the
        // palette flashes its previous query for that frame.
        if (open) {
          setOpen(false)
        } else {
          setQuery('')
          setActive(0)
          setOpen(true)
        }
        return
      }
      if (event.key === 'Escape' && open) {
        event.preventDefault()
        setOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  // Focus in on open, and back where it came from on close. Without the
  // restore, closing the palette drops focus onto <body> and the next Tab
  // starts from the top of the window.
  useEffect(() => {
    if (open) {
      restoreRef.current = document.activeElement as HTMLElement | null
      // After paint, or the input does not exist yet to focus.
      const id = window.requestAnimationFrame(() => inputRef.current?.focus())
      return () => window.cancelAnimationFrame(id)
    }
    restoreRef.current?.focus?.()
    return undefined
  }, [open])

  // Keep the highlighted row in view when arrowing past the fold.
  useEffect(() => {
    const list = listRef.current
    const row = list?.children[active] as HTMLElement | undefined
    row?.scrollIntoView({ block: 'nearest' })
  }, [active])

  if (!open) return null

  const move = (delta: number): void => {
    if (results.length === 0) return
    setActive((current) => (current + delta + results.length) % results.length)
  }

  const runActive = (): void => {
    const command = results[active]
    if (!command) return
    setOpen(false)
    command.run()
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center bg-ink/20 px-4 pt-[12vh] backdrop-blur-[2px]"
      // A click on the backdrop is a dismissal; a click inside is not.
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) setOpen(false)
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="elev-3 w-full max-w-lg overflow-hidden rounded-2xl border border-line bg-surface-raised"
      >
        <div className="flex items-center gap-2.5 border-b border-line px-4 has-[:focus-visible]:border-accent">
          <svg
            viewBox="0 0 24 24"
            aria-hidden="true"
            className="size-[15px] shrink-0 text-ink-faint"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
          >
            <path d="M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM16 16l5 5" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            value={query}
            role="combobox"
            aria-expanded="true"
            aria-controls="command-results"
            aria-activedescendant={results[active] ? `command-${results[active].id}` : undefined}
            aria-label="Search commands"
            placeholder="Go anywhere, do anything…"
            onChange={(event) => {
              setQuery(event.target.value)
              setActive(0)
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                move(1)
              } else if (event.key === 'ArrowUp') {
                event.preventDefault()
                move(-1)
              } else if (event.key === 'Enter') {
                event.preventDefault()
                runActive()
              } else if (event.key === 'Home') {
                setActive(0)
              } else if (event.key === 'End') {
                setActive(Math.max(0, results.length - 1))
              }
            }}
            // The row it sits in carries the focus treatment instead — an outline
            // around a transparent, full-width input reads as a box drawn over the
            // divider rather than as a focused field.
            className="w-full bg-transparent py-3.5 text-[14px] text-ink outline-none focus-visible:outline-none placeholder:text-ink-faint"
          />
        </div>

        {results.length === 0 ? (
          <p className="px-4 py-8 text-center text-[13px] text-ink-muted">
            Nothing matches “{query}”.
          </p>
        ) : (
          <ul
            ref={listRef}
            id="command-results"
            role="listbox"
            aria-label="Commands"
            className="max-h-[52vh] overflow-y-auto p-1.5"
          >
            {results.map((command, index) => (
              <li
                key={command.id}
                id={`command-${command.id}`}
                role="option"
                aria-selected={index === active}
                // The keyboard owns selection; the pointer follows it rather
                // than fighting it, so moving the mouse over the list does not
                // undo where the arrow keys have got to until it actually moves.
                onMouseMove={() => setActive(index)}
                onClick={() => {
                  setOpen(false)
                  command.run()
                }}
                className={[
                  'flex cursor-pointer items-center justify-between gap-3 rounded-lg px-3 py-2 text-[13px]',
                  index === active ? 'bg-ink/[0.07] text-ink' : 'text-ink-muted',
                ].join(' ')}
              >
                <span className="truncate">{command.title}</span>
                <span className="shrink-0 text-[11px] uppercase tracking-[0.06em] text-ink-faint">
                  {command.group}
                </span>
              </li>
            ))}
          </ul>
        )}

        <div className="flex items-center gap-3 border-t border-line px-4 py-2 text-[11px] text-ink-faint">
          <span>
            <kbd>↑</kbd> <kbd>↓</kbd> to move
          </span>
          <span>
            <kbd>↵</kbd> to run
          </span>
          <span>
            <kbd>esc</kbd> to close
          </span>
        </div>
      </div>
    </div>
  )
}

/** Enough to scroll through, few enough that the list is still a list. */
const MAX_RESULTS = 12

function buildCommands(
  navigate: (section: SectionId) => void,
  announce: (message: string) => void,
): Command[] {
  const goTo: Command[] = ALL_SECTIONS.map((section) => ({
    id: `go-${section.id}`,
    title: section.label,
    group: 'Go to',
    keywords: SECTION_KEYWORDS[section.id],
    run: () => navigate(section.id),
  }))

  const actions: Command[] = [
    {
      id: 'new-note',
      title: 'New note',
      group: 'Do',
      keywords: ['scratchpad', 'write', 'jot'],
      run: () => void window.murmur.notes.openWindow({ noteId: null }),
    },
    {
      id: 'check-updates',
      title: 'Check for updates',
      group: 'Do',
      keywords: ['version', 'upgrade', 'release'],
      run: () => {
        void window.murmur.app.checkForUpdate()
        announce('Checking for updates…')
      },
    },
    {
      id: 'theme-light',
      title: 'Switch to the light theme',
      group: 'Do',
      keywords: ['appearance', 'dark', 'mode'],
      run: () => void window.murmur.settings.set({ appearance: 'light' }),
    },
    {
      id: 'theme-dark',
      title: 'Switch to the dark theme',
      group: 'Do',
      keywords: ['appearance', 'light', 'mode'],
      run: () => void window.murmur.settings.set({ appearance: 'dark' }),
    },
    {
      id: 'theme-system',
      title: 'Match the system theme',
      group: 'Do',
      keywords: ['appearance', 'auto'],
      run: () => void window.murmur.settings.set({ appearance: 'system' }),
    },
  ]

  return [...goTo, ...actions]
}
