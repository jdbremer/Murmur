import type {
  AskCitation,
  AskConversation,
  AskEvent,
  AskState,
  AskStatus,
  AskTurn,
} from '@murmur/shared'

/**
 * The Ask thread's state, as a pure reducer (PLAN §2.2.9).
 *
 * Separated from the component for one specific reason: the `restart` event.
 * When a dictation preempts an answer mid-stream, the model starts over, and
 * the partial text already on screen has to be *discarded* rather than appended
 * to. Get that wrong and the pane shows two half-answers spliced together —
 * which reads as the model contradicting itself, and is the kind of bug that
 * only appears when someone happens to dictate at the wrong moment. It is worth
 * being able to test directly instead of by timing a race.
 */

export interface ThreadState {
  /** The conversation on screen. Null on a blank composer. */
  activeId: string | null
  /** Every conversation, most recently used first. */
  conversations: AskConversation[]
  /** The active conversation's finished turns, oldest first. */
  turns: AskTurn[]
  /** The answer currently arriving, if any. */
  streaming: string
  status: AskStatus
  /** Sources offered to the model for the in-flight answer. */
  citations: AskCitation[]
  /** How many candidates retrieval found before the budget cut them down. */
  searched: number
  /** What the in-flight answer was built from; see the `sources` event. */
  coverage: string
  /** The period the question named, if any — "this week". */
  window: string
  error: string | null
  /** Non-null when Ask cannot run at all; the composer is disabled. */
  unavailable: string | null
  counts: AskState['counts']
}

export const INITIAL_THREAD: ThreadState = {
  activeId: null,
  conversations: [],
  turns: [],
  streaming: '',
  status: 'idle',
  citations: [],
  searched: 0,
  coverage: '',
  window: '',
  error: null,
  unavailable: null,
  counts: { dictations: 0, notes: 0, meetings: 0 },
}

export type ThreadAction = { type: 'loaded'; state: AskState } | { type: 'event'; event: AskEvent }

export function threadReducer(state: ThreadState, action: ThreadAction): ThreadState {
  switch (action.type) {
    case 'loaded':
      // A whole-state replace, used for opening a conversation, deleting one and
      // clearing them all. The in-flight stream is dropped with it: main
      // cancels the answer when the active conversation changes, so keeping the
      // partial text would leave one thread's half-answer under another's turns.
      return {
        ...state,
        activeId: action.state.activeId,
        conversations: action.state.conversations,
        turns: action.state.turns,
        status: action.state.status,
        counts: action.state.counts,
        unavailable: action.state.unavailable,
        streaming: '',
        citations: [],
        searched: 0,
        coverage: '',
        window: '',
        error: null,
      }

    case 'event':
      return applyEvent(state, action.event)
  }
}

/**
 * Whether an event belongs to the conversation on screen.
 *
 * Events carry their conversation id because the pane can change threads while
 * an answer is in flight. Main cancels on a switch, but the cancel and the last
 * few deltas race, and a delta applied to the wrong thread appends one
 * conversation's words to another's answer.
 *
 * The `null` case is not a loophole but the ordinary path: asking from a blank
 * composer creates the conversation in main, so the very first event is the
 * renderer's only way to learn its id.
 */
function belongs(state: ThreadState, event: AskEvent): boolean {
  return state.activeId === null || state.activeId === event.conversationId
}

function applyEvent(state: ThreadState, event: AskEvent): ThreadState {
  if (!belongs(state, event)) return state

  switch (event.type) {
    case 'question':
      // A new question clears the previous error. Leaving it up would put a
      // stale failure above an answer that is arriving perfectly well.
      return {
        ...state,
        activeId: event.conversationId,
        turns: [...state.turns, event.turn],
        streaming: '',
        citations: [],
        searched: 0,
        coverage: '',
        error: null,
      }

    case 'status':
      return {
        ...state,
        activeId: event.conversationId,
        status: event.status,
        // Carried on `searching` and cleared by the next question, so the pane
        // can say which period it looked in.
        window: event.status === 'searching' ? event.window : state.window,
      }

    case 'sources':
      return {
        ...state,
        citations: event.citations,
        searched: event.searched,
        coverage: event.coverage,
      }

    case 'delta':
      return { ...state, streaming: state.streaming + event.text }

    case 'restart':
      // The whole reason this reducer exists. Appending here would splice two
      // half-answers together.
      return { ...state, streaming: '' }

    case 'done':
      // The stored turn replaces the streamed text rather than joining it: the
      // turn is authoritative, carries the citations, and has been trimmed.
      return {
        ...state,
        turns: [...state.turns, event.turn],
        conversations: upsertConversation(state.conversations, event.conversation),
        streaming: '',
        status: 'idle',
      }

    case 'error':
      // The partial answer is kept deliberately — half an answer plus an
      // explanation is more use than an empty pane and an explanation.
      return { ...state, error: event.message, status: 'error' }
  }
}

/**
 * Put a conversation at the front of the list, replacing any older copy.
 *
 * Front because the list is ordered by when each thread was last used, and the
 * one that just answered is now the most recent — re-sorting the whole array on
 * `updatedAt` would reach the same place by a longer route, and would depend on
 * a timestamp that a same-millisecond answer can tie.
 */
function upsertConversation(
  conversations: readonly AskConversation[],
  conversation: AskConversation,
): AskConversation[] {
  return [conversation, ...conversations.filter((c) => c.id !== conversation.id)]
}

/** True while the model is working and the composer should show Stop. */
export function isBusy(status: AskStatus): boolean {
  return status === 'searching' || status === 'answering' || status === 'paused'
}

/** What the status line says, or null when there is nothing worth saying. */
export function statusLabel(state: ThreadState): string | null {
  switch (state.status) {
    case 'searching':
      // Naming the period matters: a question about "this week" searches only
      // the last seven days, and a reader who does not know that reads an empty
      // answer as an empty archive.
      return state.window ? `Searching ${state.window}…` : 'Searching your history…'
    case 'paused':
      return 'Paused while you dictated…'
    case 'answering':
      // Only until the first token: once text is arriving, the text *is* the
      // progress indicator and a spinner beside it is noise.
      return state.streaming ? null : 'Reading what it found…'
    default:
      return null
  }
}

export interface AnswerPart {
  kind: 'text' | 'citation'
  /** The text to render, or the citation marker's number as written. */
  value: string
  citation?: AskCitation
  /**
   * On a citation, the word the chip must stay glued to.
   *
   * A chip is an atomic inline box, and CSS allows a line break between text
   * and an atomic inline even with no space between them — so an answer ending
   * "…before the end of the month.[1]" happily drops the chip onto a line of
   * its own, where it reads as a stray footnote rather than a reference. The
   * last word is therefore handed to the citation part so the renderer can keep
   * the two inside one `nowrap` span, which is what a printed superscript does.
   */
  lead?: string
}

/**
 * Split an answer into text and citation markers.
 *
 * Inline chips rather than a footnote list, because a citation's whole job is
 * to say *which* clause it supports. A list at the bottom makes the reader map
 * numbers back onto sentences by hand, which is exactly the work the marker was
 * supposed to save.
 *
 * A marker with no matching source is **dropped**, not rendered. Small models
 * do produce them — a refusal that ends "…nothing about that in your notes. [1]"
 * came out of the real 3B model during testing, and a lone bracket after a
 * sentence saying nothing was found reads as a source the reader cannot open.
 * Dropping it edits the model's output, which is worth being deliberate about:
 * a reference to a source that does not exist is malformed markup rather than
 * something the model meant to say, and every alternative — rendering it, or
 * showing a chip that goes nowhere — is a worse lie than removing it.
 */
export function splitAnswer(text: string, citations: readonly AskCitation[]): AnswerPart[] {
  const byIndex = new Map(citations.map((citation) => [citation.index, citation]))
  const parts: AnswerPart[] = []
  let cursor = 0

  const push = (value: string): void => {
    if (!value) return
    // Merge with the previous run so dropping a dangling marker does not leave
    // two adjacent text nodes with a seam between them.
    const last = parts.at(-1)
    if (last?.kind === 'text') last.value += value
    else parts.push({ kind: 'text', value })
  }

  for (const match of text.matchAll(/\s*\[(\d{1,2})\]/g)) {
    const at = match.index
    const citation = byIndex.get(Number(match[1]))

    push(text.slice(cursor, at))
    cursor = at + match[0].length

    if (citation) {
      // Take the trailing word off the text run and give it to the chip, so
      // the two travel together when the line wraps.
      parts.push({
        kind: 'citation',
        value: String(citation.index),
        citation,
        lead: takeLastWord(parts),
      })
    }
    // Otherwise both the marker and the space before it are simply gone.
  }

  push(text.slice(cursor))
  return parts
}

/**
 * Remove the final word from the last text part and return it.
 *
 * Returns an empty string when there is no preceding text, or when it already
 * ends in whitespace — a chip after a space has a legitimate break before it
 * and does not need gluing.
 */
function takeLastWord(parts: AnswerPart[]): string {
  const last = parts.at(-1)
  if (last?.kind !== 'text' || !last.value || /\s$/.test(last.value)) return ''

  const boundary = last.value.search(/\S+$/)
  if (boundary === -1) return ''

  const word = last.value.slice(boundary)
  const head = last.value.slice(0, boundary)
  if (head) last.value = head
  else parts.pop()
  return word
}

/**
 * Split an answer into paragraphs and bullet runs.
 *
 * A recap is asked for as "- " lines and, rendered as one `pre-wrap` block,
 * arrives as a wall of hyphens with wrapped continuation lines flush against
 * the margin — the reader has to find the item boundaries by eye. Detecting the
 * runs and rendering a real list is the difference between a list and text that
 * happens to contain hyphens.
 *
 * Deliberately not a Markdown parser. The only structure the prompts ask for is
 * a bullet, and a parser would bring emphasis, headings and links along with
 * it — every one of them a way for a small model's stray asterisk to eat half
 * an answer.
 */
export interface AnswerBlock {
  kind: 'text' | 'list'
  /** One string for `text`; one per item for `list`. */
  lines: string[]
}

export function splitBlocks(text: string): AnswerBlock[] {
  const blocks: AnswerBlock[] = []

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trimEnd()
    // `- ` or `• `, and a lone `-` is a hyphen rather than an empty bullet.
    const bullet = /^\s*[-•*]\s+(.*)$/.exec(line)
    const last = blocks.at(-1)

    if (bullet?.[1]) {
      if (last?.kind === 'list') last.lines.push(bullet[1])
      else blocks.push({ kind: 'list', lines: [bullet[1]] })
      continue
    }

    if (!line.trim()) continue
    if (last?.kind === 'text') last.lines.push(line)
    else blocks.push({ kind: 'text', lines: [line] })
  }

  return blocks
}
