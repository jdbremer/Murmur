import { useEffect, useRef, useState } from 'react'

import { relativeDay, type AskConversation, type AskSearchHit } from '@murmur/shared'

import { useNow } from './useNow'

/**
 * The conversation rail (PLAN §2.2.9).
 *
 * Ask stopped being a lookup the moment it kept its answers: a thread about the
 * migration is a piece of work you come back to, and coming back is only useful
 * if you can find it. Hence a list ordered by when each was last used, and a
 * search over what was *said* rather than over the titles — after a few weeks
 * the thing anybody remembers is a phrase from the answer, never the title they
 * did not choose.
 */

export function Rail({
  conversations,
  activeId,
  busy,
  collapsed,
  onToggle,
  onOpen,
  onNew,
  onRename,
  onDelete,
  onSearch,
}: {
  conversations: readonly AskConversation[]
  activeId: string | null
  busy: boolean
  /** Folded to a slim strip. Persisted in settings, like the Hub sidebar. */
  collapsed: boolean
  onToggle: () => void
  onOpen: (id: string) => void
  onNew: () => void
  onRename: (id: string, title: string) => void
  onDelete: (id: string) => void
  onSearch: (query: string) => Promise<AskSearchHit[]>
}): React.JSX.Element {
  const now = useNow()
  const [query, setQuery] = useState('')
  const [renaming, setRenaming] = useState<string | null>(null)
  /**
   * The last search that came back, tagged with the query it answered.
   *
   * Tagged rather than bare, so which results to show is *derived* from the
   * current query instead of being cleared by an effect. Without the tag,
   * clearing the box and typing something new would leave the previous query's
   * hits on screen for the length of the debounce — results attributed to a
   * search that never returned them.
   */
  const [hits, setHits] = useState<{ query: string; results: AskSearchHit[] } | null>(null)

  const trimmed = query.trim()

  // Debounced, and guarded by a sequence number: a slow request for "mi" must
  // not land after the fast one for "migration" and overwrite it.
  const sequence = useRef(0)
  useEffect(() => {
    if (!trimmed) return
    const ticket = ++sequence.current
    const timer = setTimeout(() => {
      void onSearch(trimmed)
        .then((results) => {
          if (ticket === sequence.current) setHits({ query: trimmed, results })
        })
        .catch(() => undefined)
    }, 140)
    return () => clearTimeout(timer)
  }, [trimmed, onSearch])

  const showing = trimmed && hits?.query === trimmed ? hits.results : null
  const rows: { conversation: AskConversation; snippet?: string }[] = showing
    ? showing.map((hit) => ({ conversation: hit.conversation, snippet: hit.snippet }))
    : conversations.map((conversation) => ({ conversation }))

  if (collapsed) {
    return (
      <aside className="hidden shrink-0 flex-col items-center gap-1.5 border-r border-line pb-3 pr-3 pt-4 @2xl:flex">
        <RailToggle collapsed onToggle={onToggle} />
        <button
          type="button"
          onClick={onNew}
          disabled={busy}
          title="Start a new conversation"
          aria-label="New conversation"
          className="grid size-[30px] place-items-center rounded-lg border border-line bg-surface text-ink-muted transition-colors duration-150 hover:border-ink-faint hover:text-ink disabled:opacity-40"
        >
          <PlusIcon />
        </button>
        {/* How much is folded away, so the strip is information, not a scar. */}
        <span
          className="pt-1 text-[10px] font-medium text-ink-faint tabular-nums"
          title={`${conversations.length} conversation${conversations.length === 1 ? '' : 's'}`}
        >
          {conversations.length}
        </span>
      </aside>
    )
  }

  return (
    <aside className="hidden w-[212px] shrink-0 flex-col gap-2.5 border-r border-line pb-3 pr-4 pt-4 @2xl:flex">
      <div className="flex items-center gap-1.5">
        <RailToggle collapsed={false} onToggle={onToggle} />
        <SearchField value={query} onChange={setQuery} />
        <button
          type="button"
          onClick={onNew}
          disabled={busy}
          title="Start a new conversation"
          aria-label="New conversation"
          className="grid size-[30px] shrink-0 place-items-center rounded-lg border border-line bg-surface text-ink-muted transition-colors duration-150 hover:border-ink-faint hover:text-ink disabled:opacity-40"
        >
          <PlusIcon />
        </button>
      </div>

      {rows.length === 0 ? (
        <p className="px-1 pt-2 text-[11.5px] leading-relaxed text-ink-faint">
          {trimmed ? 'No conversation mentions that.' : 'Your conversations will be listed here.'}
        </p>
      ) : (
        <ul className="-mr-1 min-h-0 flex-1 space-y-0.5 overflow-y-auto overscroll-y-contain pr-1">
          {rows.map(({ conversation, snippet }) => (
            <li key={conversation.id}>
              {renaming === conversation.id ? (
                <RenameField
                  initial={conversation.title}
                  onCommit={(title) => {
                    setRenaming(null)
                    if (title && title !== conversation.title) onRename(conversation.id, title)
                  }}
                />
              ) : (
                <Row
                  conversation={conversation}
                  snippet={snippet}
                  active={conversation.id === activeId}
                  now={now}
                  onOpen={() => onOpen(conversation.id)}
                  onRename={() => setRenaming(conversation.id)}
                  onDelete={() => onDelete(conversation.id)}
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </aside>
  )
}

function SearchField({
  value,
  onChange,
}: {
  value: string
  onChange: (value: string) => void
}): React.JSX.Element {
  return (
    <div className="relative min-w-0 flex-1">
      <svg
        viewBox="0 0 24 24"
        aria-hidden="true"
        className="pointer-events-none absolute left-2 top-1/2 size-[13px] -translate-y-1/2 text-ink-faint"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      >
        <path d="M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM16 16l5 5" />
      </svg>
      <input
        type="text"
        value={value}
        aria-label="Search your conversations"
        placeholder="Search"
        onChange={(event) => onChange(event.target.value)}
        className="h-[30px] w-full rounded-lg border border-line bg-surface pl-[26px] pr-2 text-[12px] text-ink outline-none transition-[border-color,box-shadow] duration-150 placeholder:text-ink-faint focus:border-accent focus:ring-2 focus:ring-accent/15"
      />
    </div>
  )
}

function Row({
  conversation,
  snippet,
  active,
  now,
  onOpen,
  onRename,
  onDelete,
}: {
  conversation: AskConversation
  snippet: string | undefined
  active: boolean
  /** Passed in rather than read here, so the row renders purely. */
  now: number
  onOpen: () => void
  onRename: () => void
  onDelete: () => void
}): React.JSX.Element {
  return (
    <div
      className={[
        'group relative flex flex-col gap-0.5 rounded-lg px-2.5 py-2 transition-colors duration-150',
        active ? 'bg-surface-sunken' : 'hover:bg-surface-sunken/60',
      ].join(' ')}
    >
      <button
        type="button"
        onClick={onOpen}
        // Double-click to rename: a menu for two actions is more chrome than
        // the actions are worth, and renaming a thread is rare enough that
        // discovering it through the tooltip is fine.
        onDoubleClick={onRename}
        title={`${conversation.title}\nDouble-click to rename`}
        aria-current={active ? 'true' : undefined}
        className="min-w-0 text-left outline-none"
      >
        <span
          className={`block truncate text-[12.5px] leading-snug ${active ? 'font-medium text-ink' : 'text-ink-muted'}`}
        >
          {conversation.title || 'Untitled'}
        </span>
        {snippet ? (
          <span className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-ink-faint">
            {snippet}
          </span>
        ) : (
          <span className="mt-0.5 block text-[10.5px] text-ink-faint">
            {relativeDay(conversation.updatedAt, now)}
          </span>
        )}
      </button>

      <button
        type="button"
        onClick={onDelete}
        aria-label={`Delete "${conversation.title}"`}
        title="Delete this conversation"
        // Revealed on hover and on keyboard focus — a control that only exists
        // for a pointer is a control a keyboard user does not have.
        className="absolute right-1.5 top-1.5 grid size-5 place-items-center rounded-md text-ink-faint opacity-0 transition-[opacity,color] duration-150 hover:text-danger focus-visible:opacity-100 group-hover:opacity-100"
      >
        <svg
          viewBox="0 0 24 24"
          aria-hidden="true"
          className="size-[12px]"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
        >
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
    </div>
  )
}

function RenameField({
  initial,
  onCommit,
}: {
  initial: string
  onCommit: (title: string) => void
}): React.JSX.Element {
  const [value, setValue] = useState(initial)
  const input = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    input.current?.select()
  }, [])

  return (
    <input
      ref={input}
      type="text"
      value={value}
      autoFocus
      aria-label="Conversation name"
      onChange={(event) => setValue(event.target.value)}
      // Blur commits as well as Enter: clicking away from a half-typed rename
      // and losing it is the kind of small betrayal people remember.
      onBlur={() => onCommit(value.trim())}
      onKeyDown={(event) => {
        if (event.key === 'Enter') onCommit(value.trim())
        if (event.key === 'Escape') onCommit('')
      }}
      className="w-full rounded-lg border border-accent bg-surface px-2.5 py-2 text-[12.5px] text-ink outline-none ring-2 ring-accent/15"
    />
  )
}

function RailToggle({
  collapsed,
  onToggle,
}: {
  collapsed: boolean
  onToggle: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={collapsed ? 'Show the conversation list' : 'Hide the conversation list'}
      aria-expanded={!collapsed}
      title={collapsed ? 'Show conversations' : 'Hide conversations'}
      className="grid size-[30px] shrink-0 place-items-center rounded-lg text-ink-faint transition-colors duration-150 hover:bg-ink/[0.05] hover:text-ink"
    >
      <svg
        viewBox="0 0 24 24"
        aria-hidden="true"
        className="size-[15px]"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM9 5v14" />
        <path d={collapsed ? 'm13.5 9.5 3 2.5-3 2.5' : 'm16.5 9.5-3 2.5 3 2.5'} />
      </svg>
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
      strokeWidth="2"
      strokeLinecap="round"
    >
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}
