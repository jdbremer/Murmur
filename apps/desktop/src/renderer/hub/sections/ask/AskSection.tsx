import { useCallback, useEffect, useReducer, useRef, useState } from 'react'

import {
  relativeDay,
  type AskCitation,
  type AskSearchHit,
  type AskSource,
  type AskState,
} from '@murmur/shared'

import { Skeleton } from '../../../components/Skeleton'
import { surfaceClasses } from '../../../design/elevation'
import { useReducedMotion } from '../../../hooks/useReducedMotion'
import { useSettings } from '../../../hooks/useSettings'
import { useToast } from '../../components/ToastHost'
import { useNavigate, type SectionId } from '../../navigation'
import { Rail } from './Rail'
import { useNow } from './useNow'
import {
  INITIAL_THREAD,
  isBusy,
  splitAnswer,
  splitBlocks,
  statusLabel,
  threadReducer,
  type ThreadState,
} from './thread'

/**
 * Ask — grounded chat over everything Murmur already stored (PLAN §2.2.9).
 *
 * The layout borrows its grammar from Claude's desktop chat, deliberately: a
 * narrow centred reading column, the user's words in a quiet rounded bubble on
 * the right, the answer as plain prose with no bubble and no avatar, and a
 * floating composer the thread dissolves behind. That grammar carries a claim
 * worth making — the answer is a *document being written for you*, not a
 * correspondent talking back — and it is the honest framing for a 1B–4B model,
 * which is not being asked to know things but to read them.
 *
 * What stays Murmur's own: the citation chips and source cards under every
 * answer (a cloud chat has nothing to cite; this one always does), the corpus
 * stats in the opening, and the waveform mark as the thinking indicator.
 *
 * There is no section header. The other sections open with a title and a
 * paragraph because they are *pages*; a chat is a surface, and a block of
 * static text pinning down its top quarter would push the conversation below
 * it forever. The title lives in an sr-only heading (the pane's
 * `aria-labelledby` still needs it), the explanation lives in the empty state
 * and the composer's caption, and the one control the header held — New —
 * floats over the thread instead.
 */

export function AskSection(): React.JSX.Element {
  const [state, dispatch] = useReducer(threadReducer, INITIAL_THREAD)
  const [draft, setDraft] = useState('')
  const { settings, update } = useSettings()
  const railCollapsed = settings?.askRailCollapsed ?? false

  // The chat's scroll is owned here, not by the pane: `App.tsx` gives this
  // section the full height (`FILL_SECTIONS`), the header holds still, and
  // only this scroller moves. Owning it here rather than in `Thread` is what
  // lets the fade, the floating composer and the jump pill sit *beside* the
  // scroller instead of scrolling away with the content.
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const endRef = useRef<HTMLDivElement | null>(null)
  const composerRef = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    let active = true
    void window.murmur.ask
      .state()
      .then((loaded) => {
        if (active) dispatch({ type: 'loaded', state: loaded })
      })
      .catch(() => undefined)

    const unsubscribe = window.murmur.ask.subscribe((event) => {
      if (active) dispatch({ type: 'event', event })
    })

    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  const busy = isBusy(state.status)
  const total = state.counts.dictations + state.counts.notes + state.counts.meetings
  const blocked = Boolean(state.unavailable) || total === 0

  const send = useCallback(
    (question: string) => {
      const trimmed = question.trim()
      if (!trimmed || busy || blocked) return
      setDraft('')
      void window.murmur.ask
        .send({ question: trimmed, conversationId: state.activeId, sources: [] })
        .catch(() => undefined)
    },
    [busy, blocked, state.activeId],
  )

  const stop = useCallback(() => {
    void window.murmur.ask.cancel().catch(() => undefined)
  }, [])

  /** Every rail action returns the whole state, so they all land the same way. */
  const apply = useCallback((next: Promise<AskState>) => {
    void next.then((loaded) => dispatch({ type: 'loaded', state: loaded })).catch(() => undefined)
  }, [])

  const open = useCallback((conversationId: string | null) => {
    setDraft('')
    void window.murmur.ask
      .open({ conversationId })
      .then((loaded) => {
        dispatch({ type: 'loaded', state: loaded })
        // Opening a thread is a decision to continue it; the next act is
        // typing, so the cursor goes where the typing goes.
        composerRef.current?.focus()
      })
      .catch(() => undefined)
  }, [])

  const rename = useCallback((id: string, title: string) => {
    void window.murmur.ask
      .rename({ id, title })
      .then(() => window.murmur.ask.state())
      .then((loaded) => dispatch({ type: 'loaded', state: loaded }))
      .catch(() => undefined)
  }, [])

  const remove = useCallback((id: string) => apply(window.murmur.ask.remove({ id })), [apply])

  const search = useCallback(
    (query: string): Promise<AskSearchHit[]> => window.murmur.ask.search({ query }),
    [],
  )

  const empty = state.turns.length === 0 && !state.streaming && state.status !== 'searching'

  const pinned = useStickToBottom(scrollerRef, endRef)
  const reducedMotion = useReducedMotion()

  // Follow the conversation — but only while the reader is at the bottom.
  // Someone who scrolled up to re-read an earlier answer must not have the
  // page yanked out from under them by an arriving token.
  useEffect(() => {
    const scroller = scrollerRef.current
    if (pinned && scroller) scroller.scrollTo({ top: scroller.scrollHeight })
  }, [state.turns.length, state.streaming, state.status, pinned])

  const jumpToLatest = useCallback(() => {
    const scroller = scrollerRef.current
    scroller?.scrollTo({
      top: scroller.scrollHeight,
      behavior: reducedMotion ? 'auto' : 'smooth',
    })
  }, [reducedMotion])

  // `/` puts the cursor in the composer, the same reflex the rest of the Hub
  // answers with its search boxes. Guarded so a literal slash typed into any
  // field stays a slash.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target as HTMLElement | null
      if (
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.isContentEditable === true
      ) {
        return
      }
      event.preventDefault()
      composerRef.current?.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <>
      {/* The pane's accessible name — `App.tsx` points `aria-labelledby` at
          this id. Visually the chat owns the whole card. */}
      <h1 id="section-title" className="sr-only">
        Ask
      </h1>

      <div className="flex min-h-0 flex-1 gap-5">
        {state.conversations.length > 0 ? (
          <Rail
            conversations={state.conversations}
            activeId={state.activeId}
            busy={busy}
            collapsed={railCollapsed}
            onToggle={() => void update({ askRailCollapsed: !railCollapsed })}
            onOpen={open}
            onNew={() => open(null)}
            onRename={rename}
            onDelete={remove}
            onSearch={search}
          />
        ) : null}

        {/* Its own `@container`, so the grids inside measure the reading
            column. Left on the section, they would measure the rail as well
            and lay out for space this column does not have. */}
        <div className="@container relative -mr-10 min-w-0 flex-1">
          <div className="ask-thread-shell h-full">
            <div
              ref={scrollerRef}
              // The bottom padding is the floating composer's clearance,
              // sized to the footer (~128px: card + caption + breathing
              // room) so that, pinned at the bottom, the last message rests
              // just above the input instead of hovering a hand-span over
              // it — content scrolls up from behind, through the gradient.
              className="ask-scroller h-full overflow-y-auto overscroll-y-contain pb-32 pr-10 pt-5"
            >
              <div className="mx-auto max-w-[46rem]">
                {state.unavailable ? <Unavailable>{state.unavailable}</Unavailable> : null}
                {empty ? (
                  <Opening counts={state.counts} total={total} onAsk={send} disabled={blocked} />
                ) : (
                  <Thread state={state} />
                )}
              </div>
              <div ref={endRef} aria-hidden="true" className="h-px" />
            </div>

            {/* Messages dissolve under the card's top edge instead of
                clipping — see `.ask-top-fade` for why it only appears once
                something is actually being cut. */}
            <div className="ask-top-fade" aria-hidden="true" />

            {state.conversations.length > 0 ? (
              <button
                type="button"
                onClick={() => open(null)}
                disabled={busy}
                title="Start a new conversation"
                className="elev-2 absolute right-10 top-3 z-10 flex items-center gap-1.5 rounded-full border border-line bg-surface-raised py-1.5 pl-2.5 pr-3 text-[11px] font-medium text-ink-muted transition-colors duration-150 hover:text-ink disabled:opacity-40"
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
                  <path d="M12 5v14M5 12h14" />
                </svg>
                New
              </button>
            ) : null}

            {!pinned && !empty ? (
              <button
                type="button"
                onClick={jumpToLatest}
                className="ask-turn elev-2 absolute bottom-36 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-line bg-surface-raised py-1.5 pl-2.5 pr-3 text-[11px] font-medium text-ink-muted transition-colors duration-150 hover:text-ink"
              >
                <svg
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                  className="size-[12px]"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M12 5v14m0 0 5-5m-5 5-5-5" />
                </svg>
                Latest
              </button>
            ) : null}

            <Composer
              draft={draft}
              onDraft={setDraft}
              onSend={() => send(draft)}
              onStop={stop}
              busy={busy}
              disabled={blocked}
              status={statusLabel(state)}
              error={state.error}
              textareaRef={composerRef}
            />
          </div>
        </div>
      </div>
    </>
  )
}

/**
 * Whether the reader is at the bottom of the thread scroller.
 *
 * Watched with an IntersectionObserver on an end sentinel, rooted at the
 * scroller itself, rather than by comparing scroll offsets on every scroll
 * event — the observer only fires when the answer changes.
 */
function useStickToBottom(
  scroller: React.RefObject<HTMLDivElement | null>,
  sentinel: React.RefObject<HTMLDivElement | null>,
): boolean {
  const [pinned, setPinned] = useState(true)

  useEffect(() => {
    const root = scroller.current
    const node = sentinel.current
    if (!root || !node) return

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0]
        if (entry) setPinned(entry.isIntersecting)
      },
      // Generous slack: the sentinel sits under the composer's clearance
      // padding, so "at the bottom" must include the whole clearance plus a
      // line or two of honest drift.
      { root, rootMargin: '0px 0px 120px 0px' },
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [scroller, sentinel])

  return pinned
}

// ---------------------------------------------------------------------------
// Opening
// ---------------------------------------------------------------------------

const EXAMPLES = [
  { question: 'What did I say about the deadline?', hint: 'across every transcript' },
  { question: 'Summarise what I dictated this week', hint: 'the last seven days' },
  { question: 'What did we agree in my last meeting?', hint: 'from the transcript' },
]

function Opening({
  counts,
  total,
  onAsk,
  disabled,
}: {
  counts: ThreadState['counts']
  total: number
  onAsk: (question: string) => void
  disabled: boolean
}): React.JSX.Element {
  if (total === 0) {
    return (
      <div className="flex flex-col items-center py-16 text-center">
        <Mark size="lg" />
        <p className="mt-5 text-[15px] font-medium text-ink">Nothing to ask about yet</p>
        <p className="mt-1.5 max-w-sm text-[13px] leading-relaxed text-ink-muted">
          Ask reads your dictations, notes and meeting transcripts. Once you have dictated
          something, this is where you come back to find it.
        </p>
      </div>
    )
  }

  return (
    <div className="ask-turn ask-hero -mx-4 rounded-2xl px-4 py-10">
      <Mark size="lg" />
      <h2 className="mt-5 text-[19px] font-semibold tracking-tight text-ink">
        Everything you have said, searchable.
      </h2>

      {/* Serif numerals, matching the Dashboard's stat treatment — the corpus is
          the reassurance that there is something here worth asking about. */}
      <div className="mt-4 flex flex-wrap items-baseline gap-x-6 gap-y-2">
        <Corpus n={counts.dictations} label="dictations" />
        <Corpus n={counts.notes} label="notes" />
        <Corpus n={counts.meetings} label="meetings" />
      </div>

      <p className="mt-6 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
        Try asking
      </p>
      <ul className="mt-2.5 grid gap-2 @xl:grid-cols-3">
        {EXAMPLES.map((example) => (
          <li key={example.question}>
            <button
              type="button"
              disabled={disabled}
              onClick={() => onAsk(example.question)}
              className={surfaceClasses({
                padding: 'none',
                interactive: !disabled,
                className:
                  'group flex h-full w-full flex-col gap-1.5 p-3.5 text-left disabled:opacity-50',
              })}
            >
              <span className="text-[13px] font-medium leading-snug text-ink">
                {example.question}
              </span>
              <span className="text-[11px] text-ink-faint">{example.hint}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

function Corpus({ n, label }: { n: number; label: string }): React.JSX.Element | null {
  if (n === 0) return null
  return (
    <p className="flex items-baseline gap-1.5">
      <span className="font-serif text-[22px] tracking-tight text-ink tabular-nums">
        {n.toLocaleString()}
      </span>
      <span className="text-[12px] text-ink-muted">{label}</span>
    </p>
  )
}

/** The app's own waveform, at rest — the same mark as the sidebar wordmark. */
function Mark({ size = 'sm' }: { size?: 'sm' | 'lg' }): React.JSX.Element {
  const box = size === 'lg' ? 'size-10' : 'size-7'
  const glyph = size === 'lg' ? 'size-[20px]' : 'size-[15px]'
  return (
    <span
      aria-hidden="true"
      className={`grid ${box} shrink-0 place-items-center rounded-full bg-accent-soft text-accent`}
    >
      <svg
        viewBox="0 0 24 24"
        className={glyph}
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
      >
        <path d="M4 10.5v3M8 8v8M12 5v14M16 8v8M20 10.5v3" />
      </svg>
    </span>
  )
}

// ---------------------------------------------------------------------------
// Thread
// ---------------------------------------------------------------------------

function Thread({ state }: { state: ThreadState }): React.JSX.Element {
  const now = useNow()

  return (
    <div className="space-y-6 py-1">
      {state.turns.map((turn, index) => {
        const previous = state.turns[index - 1]
        return (
          <div key={turn.id} className="space-y-6">
            {/* A resumed thread carries its history; the divider is what makes
                "picking up where you left off" legible rather than eerie —
                without it last Tuesday's answer reads as part of today's. */}
            {previous && !sameDay(previous.createdAt, turn.createdAt) ? (
              <DayDivider label={relativeDay(turn.createdAt, now)} />
            ) : null}
            {turn.role === 'user' ? (
              <Question>{turn.content}</Question>
            ) : (
              <Answer
                text={turn.content}
                citations={turn.citations}
                coverage={turn.coverage}
              />
            )}
          </div>
        )
      })}

      {state.streaming ? (
        <Answer
          text={state.streaming}
          citations={state.citations}
          coverage={state.coverage}
          streaming
        />
      ) : state.status === 'searching' || state.status === 'answering' ? (
        <Thinking searching={state.status === 'searching'} />
      ) : null}
    </div>
  )
}

/** Same calendar day in local time — the clock a person's "today" runs on. */
function sameDay(a: number, b: number): boolean {
  const x = new Date(a)
  const y = new Date(b)
  return (
    x.getFullYear() === y.getFullYear() &&
    x.getMonth() === y.getMonth() &&
    x.getDate() === y.getDate()
  )
}

function DayDivider({ label }: { label: string }): React.JSX.Element {
  return (
    <div className="flex items-center gap-3" role="separator" aria-label={label}>
      <span aria-hidden="true" className="h-px flex-1 bg-line" />
      <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
        {label}
      </span>
      <span aria-hidden="true" className="h-px flex-1 bg-line" />
    </div>
  )
}

/**
 * The user's words: a quiet rounded bubble on the right.
 *
 * Quiet on purpose — a neutral sunken tint rather than the accent. The accent
 * is spent on what the app produced (citations, sources, the send button);
 * spending it on the user's own words too would make the page shout at itself.
 */
function Question({ children }: { children: string }): React.JSX.Element {
  return (
    <div className="ask-turn flex justify-end">
      <p className="max-w-[80%] whitespace-pre-wrap rounded-2xl rounded-br-[6px] bg-surface-sunken px-4 py-2.5 text-[13.5px] leading-relaxed text-ink">
        {children}
      </p>
    </div>
  )
}

/**
 * What the wait looks like before the first token: the waveform mark pulsing
 * beside skeleton lines, in place of a spinner. A skeleton says *an answer* is
 * coming and reserves the space it will take, so nothing jumps when it lands.
 */
function Thinking({ searching }: { searching: boolean }): React.JSX.Element {
  return (
    <div className="ask-turn flex gap-3" role="status" aria-busy="true">
      <span className="animate-pulse">
        <Mark />
      </span>
      <div className="min-w-0 flex-1 space-y-2.5 pt-1.5">
        <Skeleton className="h-3" width={92} />
        <Skeleton className="h-3" width={78} delayMs={80} />
        <Skeleton className="h-3" width={44} delayMs={160} />
        <span className="sr-only">
          {searching ? 'Searching your history' : 'Reading what it found'}
        </span>
      </div>
    </div>
  )
}

/**
 * An answer: plain prose, no bubble, no avatar — the words carry it. The
 * citation chips ride inline, the source cards follow, and an action row
 * appears under the finished answer on hover, the way a chat's message tools
 * do.
 */
function Answer({
  text,
  citations,
  coverage = '',
  streaming = false,
}: {
  text: string
  citations: readonly AskCitation[]
  /**
   * What a recap read, in words. Recaps have no per-claim citations — the
   * model saw everything in the period — so without this the reader has no
   * way to tell a summary of twelve records from a summary of one, which is
   * precisely the failure this line exists to make visible.
   */
  coverage?: string
  streaming?: boolean
}): React.JSX.Element {
  const toast = useToast()
  const blocks = splitBlocks(text)
  const used = blocks
    .flatMap((block) => block.lines)
    .flatMap((line) => splitAnswer(line, citations))
    .flatMap((part) => (part.citation ? [part.citation] : []))
  const unique = [...new Map(used.map((c) => [c.index, c])).values()]

  const copy = (): void => {
    // Through main — the renderer's own clipboard API is deliberately denied
    // (see `app.copyText` in the contract). The markers go; "[1]" means
    // nothing in the email the answer is pasted into.
    void window.murmur.app
      .copyText({ text: text.replace(/\s*\[\d{1,2}\]/g, '') })
      .then(() => toast.show({ message: 'Answer copied', tone: 'positive' }))
      .catch(() => undefined)
  }

  return (
    <div className="ask-turn group/answer">
      <div className="space-y-3 text-[14px] leading-[1.75] text-ink">
        {blocks.map((block, b) =>
          block.kind === 'list' ? (
            <ul key={`b-${b}`} className="space-y-1.5">
              {block.lines.map((line, i) => (
                <li key={`li-${i}`} className="flex gap-2.5">
                  {/* A dot rather than the model's hyphen: the marker is the
                      renderer's job, and hanging it outside the text column
                      keeps wrapped continuation lines aligned under the words
                      instead of under the bullet. */}
                  <span
                    aria-hidden="true"
                    className="mt-[0.62em] size-[3px] shrink-0 rounded-full bg-ink-faint"
                  />
                  <span className="min-w-0 flex-1">
                    <Prose text={line} citations={citations} />
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p key={`b-${b}`} className="whitespace-pre-wrap">
              <Prose text={block.lines.join('\n')} citations={citations} />
              {streaming && b === blocks.length - 1 ? <Caret /> : null}
            </p>
          ),
        )}
        {streaming && blocks.at(-1)?.kind === 'list' ? (
          <p>
            <Caret />
          </p>
        ) : null}
      </div>

      {coverage ? (
        <p className="mt-2.5 flex items-center gap-1.5 text-[11px] text-ink-faint">
          <svg
            viewBox="0 0 24 24"
            aria-hidden="true"
            className="size-[12px] shrink-0"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.9"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M4 6h16M4 12h16M4 18h10" />
          </svg>
          Read {coverage}
        </p>
      ) : null}

      {!streaming && unique.length > 0 ? <Sources citations={unique} /> : null}

      {streaming ? null : (
        <div className="mt-2 flex items-center gap-1 opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover/answer:opacity-100">
          <button
            type="button"
            onClick={copy}
            aria-label="Copy this answer"
            title="Copy this answer"
            className="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[11px] font-medium text-ink-faint transition-colors duration-150 hover:bg-ink/[0.05] hover:text-ink"
          >
            <svg
              viewBox="0 0 24 24"
              aria-hidden="true"
              className="size-[12px]"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M9 9h10v11H9zM5 15V4h10" />
            </svg>
            Copy
          </button>
        </div>
      )}
    </div>
  )
}

/** One run of text with its citation chips rendered inline. */
function Prose({
  text,
  citations,
}: {
  text: string
  citations: readonly AskCitation[]
}): React.JSX.Element {
  return (
    <>
      {splitAnswer(text, citations).map((part, i) =>
        part.kind === 'citation' && part.citation ? (
          // The chip and the word before it inside one unbreakable run — see
          // `takeLastWord` for why a chip alone on a line is easy to produce
          // and how bad it looks.
          <span key={`${part.value}-${i}`} className="whitespace-nowrap">
            {part.lead}
            <CitationChip citation={part.citation} />
          </span>
        ) : (
          <span key={`t-${i}`}>{part.value}</span>
        ),
      )}
    </>
  )
}

function Caret(): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      className="ask-caret ml-0.5 inline-block h-[0.95em] w-[2px] translate-y-[2px] rounded-full bg-accent align-baseline"
    />
  )
}

// ---------------------------------------------------------------------------
// Citations
// ---------------------------------------------------------------------------

/** The section a citation opens, by where the passage lives. */
const SOURCE_SECTION: Record<AskSource, SectionId> = {
  dictation: 'history',
  note: 'notes',
  meeting: 'meetings',
}

const SOURCE_LABEL: Record<AskSource, string> = {
  dictation: 'Dictation',
  note: 'Note',
  meeting: 'Meeting',
}

/** Drawn from the same 24×24 stroked vocabulary as the sidebar. */
const SOURCE_ICON: Record<AskSource, string> = {
  dictation: 'M4 10.5v3M8 8v8M12 5v14M16 8v8M20 10.5v3',
  note: 'M6 4h8l4 4v12H6zM14 4v4h4M9 13h6M9 16.5h4',
  meeting:
    'M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zM8 10v4M12 8v8M16 11v2',
}

function CitationChip({ citation }: { citation: AskCitation }): React.JSX.Element {
  const navigate = useNavigate()
  return (
    <button
      type="button"
      onClick={() => navigate(SOURCE_SECTION[citation.source])}
      aria-label={`Source ${citation.index}: ${SOURCE_LABEL[citation.source]} — ${citation.title}`}
      title={`${SOURCE_LABEL[citation.source]} — ${citation.title}`}
      className="mx-[1.5px] inline-flex h-[15px] min-w-[15px] translate-y-[-3px] items-center justify-center rounded-[4px] bg-accent/12 px-[3px] align-baseline text-[9.5px] font-semibold leading-none text-accent tabular-nums transition-colors duration-150 hover:bg-accent/25"
    >
      {citation.index}
    </button>
  )
}

/**
 * The sources under an answer.
 *
 * Cards rather than a row of small pills, because this is the part that makes
 * the answer trustworthy rather than merely fluent. A pill saying "1" asks the
 * reader to take the citation on faith; a card carrying the title, when it was
 * said, and the words themselves lets them check it at a glance — and check it
 * without leaving the answer they were reading.
 */
function Sources({ citations }: { citations: AskCitation[] }): React.JSX.Element {
  const navigate = useNavigate()
  const now = useNow()

  return (
    <div className="mt-4">
      <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
        {citations.length === 1 ? 'Source' : `${citations.length} sources`}
      </p>
      <ul className="mt-2 space-y-1.5">
        {citations.map((citation, index) => (
          <li
            key={citation.index}
            className="ask-source"
            style={{ '--ask-source-delay': `${index * 45}ms` } as React.CSSProperties}
          >
            <button
              type="button"
              onClick={() => navigate(SOURCE_SECTION[citation.source])}
              className={surfaceClasses({
                padding: 'none',
                interactive: true,
                className: 'flex h-full w-full gap-2.5 p-2.5 text-left',
              })}
            >
              <span
                aria-hidden="true"
                className="mt-px grid size-6 shrink-0 place-items-center rounded-md bg-accent-soft text-accent"
              >
                <svg
                  viewBox="0 0 24 24"
                  className="size-[13px]"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d={SOURCE_ICON[citation.source]} />
                </svg>
              </span>

              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-1.5">
                  <span className="text-[9.5px] font-semibold text-accent tabular-nums">
                    {citation.index}
                  </span>
                  <span className="truncate text-[12px] font-medium text-ink">
                    {citation.title}
                  </span>
                  <span className="ml-auto shrink-0 text-[10px] text-ink-faint">
                    {relativeDay(citation.timestamp, now)}
                  </span>
                </span>
                <span className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-ink-muted">
                  {citation.excerpt}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------

function Unavailable({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className={surfaceClasses({ tone: 'warning', padding: 'sm', className: 'mb-5' })}>
      <p className="text-[12px] leading-relaxed text-ink-muted">{children}</p>
    </div>
  )
}

/**
 * The floating composer, in Claude's grammar: a rounded card hovering over the
 * foot of the thread, the content dissolving into the footer's gradient behind
 * it, an icon send button, and the one-line caption beneath.
 */
function Composer({
  draft,
  onDraft,
  onSend,
  onStop,
  busy,
  disabled,
  status,
  error,
  textareaRef,
}: {
  draft: string
  onDraft: (value: string) => void
  onSend: () => void
  onStop: () => void
  busy: boolean
  disabled: boolean
  /** What the model is doing, or null once its text is doing the talking. */
  status: string | null
  error: string | null
  /** So `/` and opening a thread can put the cursor here. */
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
}): React.JSX.Element {
  return (
    // `ask-footer` is the gradient the thread dissolves into; everything inside
    // floats above the scroller. `pr-10` mirrors the scroller's own right
    // padding so the card centres on the same column as the messages.
    <div className="ask-footer absolute inset-x-0 bottom-0 z-10 pb-5 pr-10 pt-10">
      <div className="mx-auto max-w-[46rem]">
        {status ? (
          <p className="mb-2 flex items-center gap-2 text-[12px] text-ink-muted" role="status">
            <span className="size-1.5 animate-pulse rounded-full bg-accent" aria-hidden="true" />
            {status}
          </p>
        ) : null}

        {error ? (
          <p role="alert" className="mb-2 text-[12px] leading-relaxed text-danger">
            {error}
          </p>
        ) : null}

        {/* The whole card lights on keyboard focus, not just the textarea, so
            the composer reads as one control rather than a box beside a
            button. `has-[:focus-visible]` and not `focus-within`: opening a
            thread autofocuses the composer for typing, and lighting the full
            accent ring on every click-open reads as the app shouting. */}
        <div
          className={surfaceClasses({
            elevation: 2,
            padding: 'none',
            className:
              'flex items-end gap-2 rounded-2xl p-2 pl-4 transition-[border-color,box-shadow] duration-150 has-[:focus-visible]:border-accent has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent/15',
          })}
        >
          <textarea
            ref={textareaRef}
            rows={1}
            value={draft}
            disabled={disabled}
            aria-label="Ask a question about your history"
            placeholder={disabled ? 'Nothing to search yet' : 'Ask about anything you have said…'}
            onChange={(event) => onDraft(event.target.value)}
            onKeyDown={(event) => {
              // Enter sends, Shift+Enter breaks the line — the convention
              // every messaging app shares, and the one hands already know.
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                onSend()
              }
            }}
            className="max-h-40 min-h-[32px] w-full resize-none select-text border-0 bg-transparent py-1.5 text-[13.5px] leading-relaxed text-ink outline-none placeholder:text-ink-faint disabled:opacity-50"
            style={{ fieldSizing: 'content' } as React.CSSProperties}
          />
          {busy ? (
            <button
              type="button"
              onClick={onStop}
              aria-label="Stop answering"
              title="Stop answering"
              className="grid size-8 shrink-0 place-items-center rounded-xl bg-ink text-surface transition-opacity duration-150 hover:opacity-85"
            >
              {/* A stop square, filled — the streaming state's own glyph. */}
              <svg
                viewBox="0 0 24 24"
                aria-hidden="true"
                className="size-[11px]"
                fill="currentColor"
              >
                <rect x="6" y="6" width="12" height="12" rx="2" />
              </svg>
            </button>
          ) : (
            <button
              type="button"
              onClick={onSend}
              disabled={disabled || !draft.trim()}
              aria-label="Ask"
              title="Ask (⏎)"
              className="grid size-8 shrink-0 place-items-center rounded-xl bg-accent text-surface transition-[opacity,background-color] duration-150 hover:opacity-90 disabled:bg-ink/10 disabled:text-ink-faint"
            >
              <svg
                viewBox="0 0 24 24"
                aria-hidden="true"
                className="size-[14px]"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M12 19V5m0 0-6 6m6-6 6 6" />
              </svg>
            </button>
          )}
        </div>

        <p className="mt-2 flex items-center justify-center gap-1.5 text-[11px] text-ink-faint">
          <svg
            viewBox="0 0 24 24"
            aria-hidden="true"
            className="size-[11px] shrink-0"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.9"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M6 11V8a6 6 0 0 1 12 0v3M5 11h14v9H5z" />
          </svg>
          Answered by the model on this machine. Nothing leaves the device.
        </p>
      </div>
    </div>
  )
}
