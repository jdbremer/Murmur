import { z } from 'zod'

/**
 * Ask — grounded chat over everything Murmur has already stored.
 *
 * The pitch is narrow on purpose. A 1B–4B polish model loses badly to anything
 * cloud-hosted at open-ended conversation, and shipping a general chatbot would
 * invite exactly that comparison. What a small model *is* good at is reading a
 * few passages you hand it and answering from them, so Ask is retrieval first
 * and generation second: every answer is grounded in dictations, notes and
 * meeting transcripts that already exist on disk, each one cited, and
 * "I couldn't find anything about that" is a first-class answer rather than a
 * failure mode.
 *
 * That framing is also what makes the feature honest about its limits. The
 * model is not being asked to know things; it is being asked to read.
 *
 * ## Why the budget arithmetic lives here
 *
 * `llama-server` runs with a fixed `--ctx-size`, and overflowing it does not
 * error — it silently evicts the *front* of the prompt, which is where the
 * grounding rules and the retrieved passages sit. An answer built from a
 * truncated context looks completely normal and is unmoored from the sources it
 * cites. So the fit is computed before the request is sent, in a pure function
 * with tests, rather than being left to the server to paper over.
 */

export const ASK_SOURCES = ['dictation', 'note', 'meeting'] as const
export const AskSourceSchema = z.enum(ASK_SOURCES)
export type AskSource = z.infer<typeof AskSourceSchema>

/** One retrieved chunk of the user's own text, ready to be cited. */
export const AskPassageSchema = z.object({
  /** Stable id of the underlying row — a dictation, note or meeting id. */
  id: z.string().min(1),
  source: AskSourceSchema,
  /** What the citation chip shows: a note's title, a meeting's name, a date. */
  title: z.string(),
  text: z.string(),
  /** Epoch ms of the underlying record, for "last week" style questions. */
  timestamp: z.number().int().nonnegative(),
  /**
   * Relevance, higher is better, normalised across sources.
   *
   * FTS5's `bm25()` returns *negative* numbers that are more negative when more
   * relevant, and the three indexes are not on the same scale as each other,
   * so raw bm25 cannot be compared across sources. `retrieval.ts` normalises
   * into 0..1 before anything here sees it.
   */
  score: z.number(),
})
export type AskPassage = z.infer<typeof AskPassageSchema>

/** A passage actually shown to the model, with the number the model cites. */
export const AskCitationSchema = z.object({
  /** 1-based, matching the `[n]` markers in the prompt and the answer. */
  index: z.number().int().positive(),
  id: z.string().min(1),
  source: AskSourceSchema,
  title: z.string(),
  timestamp: z.number().int().nonnegative(),
  /** A short lead-in, so the chip can be expanded without another round trip. */
  excerpt: z.string(),
})
export type AskCitation = z.infer<typeof AskCitationSchema>

export const AskTurnSchema = z.object({
  id: z.string().min(1),
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  /** Only ever populated on assistant turns. */
  citations: z.array(AskCitationSchema).default([]),
  createdAt: z.number().int().nonnegative(),
})
export type AskTurn = z.infer<typeof AskTurnSchema>

export const AskStatusSchema = z.enum([
  'idle',
  /** Running the FTS queries. Fast, but worth a distinct state when empty. */
  'searching',
  /** Streaming tokens. */
  'answering',
  /** Yielded the model to a dictation; will restart when it is free. */
  'paused',
  'error',
])
export type AskStatus = z.infer<typeof AskStatusSchema>

// ---------------------------------------------------------------------------
// Context budget
// ---------------------------------------------------------------------------

/**
 * The budget, in tokens, carved out of `--ctx-size`.
 *
 * These sum to less than the 4096 the sidecar launches with, and the slack is
 * deliberate: {@link estimateTokens} is a heuristic, and the chat template adds
 * per-message scaffolding this arithmetic cannot see.
 */
export const ASK_BUDGET = {
  /** Total we are willing to occupy. Below `--ctx-size` by a safety margin. */
  contextTokens: 3600,
  /** Reserved for the answer, so the model is never cut off mid-sentence. */
  answerTokens: 512,
  /** Reserved for the grounding rules; measured, not guessed — see the test. */
  systemTokens: 320,
  /** Reserved for earlier turns of the conversation. */
  historyTokens: 480,
  /**
   * No single passage may occupy more than this. A 4,000-word note would
   * otherwise crowd out every other source and make the answer look like it
   * only ever consults one document.
   */
  passageTokens: 500,
} as const

/** Retrieved context gets whatever the fixed reservations do not take. */
export function passageBudgetTokens(budget = ASK_BUDGET): number {
  return Math.max(
    0,
    budget.contextTokens - budget.answerTokens - budget.systemTokens - budget.historyTokens,
  )
}

/**
 * Tokens in a string, approximately.
 *
 * Deliberately a character heuristic rather than a real tokeniser: shipping a
 * BPE vocabulary into `@murmur/shared` to decide how many notes to include is a
 * dependency and a per-model correctness problem for a number that only needs
 * to be in the right neighbourhood. 3.6 chars/token rather than the usual 4
 * because it must *over*-estimate — under-estimating overflows the window, and
 * an overflow silently evicts the grounding rules.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.6)
}

/** Cut text to a token budget on a word boundary. */
export function truncateToTokens(text: string, maxTokens: number): string {
  if (estimateTokens(text) <= maxTokens) return text
  const maxChars = Math.max(0, Math.floor(maxTokens * 3.6))
  const cut = text.slice(0, maxChars)
  const lastSpace = cut.lastIndexOf(' ')
  return `${(lastSpace > maxChars * 0.5 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`
}

export interface FittedContext {
  /** In the order they will be numbered, best first. */
  passages: AskPassage[]
  /** How many candidates did not fit; surfaced as "searched N, used M". */
  dropped: number
  tokens: number
}

/**
 * Choose which retrieved passages to actually send.
 *
 * Greedy by score, skipping any passage that would overflow rather than
 * stopping at the first one that does — a single long note near the top should
 * not deny the budget to three short, equally relevant dictations behind it.
 */
export function fitPassages(candidates: readonly AskPassage[], budget = ASK_BUDGET): FittedContext {
  const limit = passageBudgetTokens(budget)
  const ranked = [...candidates].sort((a, b) => b.score - a.score)

  const passages: AskPassage[] = []
  let tokens = 0
  let dropped = 0

  for (const candidate of ranked) {
    const text = truncateToTokens(candidate.text, budget.passageTokens)
    // The per-passage overhead of the `[n] source — title` header line.
    const cost = estimateTokens(text) + 24
    if (tokens + cost > limit) {
      dropped += 1
      continue
    }
    passages.push({ ...candidate, text })
    tokens += cost
  }

  return { passages, dropped, tokens }
}

/**
 * Drop the oldest turns until the conversation fits.
 *
 * Whole turns, and always ending on an assistant turn boundary, because a
 * history that starts mid-exchange reads to the model as though it answered a
 * question nobody asked.
 */
export function trimHistory(turns: readonly AskTurn[], budget = ASK_BUDGET): AskTurn[] {
  const kept: AskTurn[] = []
  let tokens = 0

  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i]
    if (!turn) continue
    const cost = estimateTokens(turn.content) + 8
    if (tokens + cost > budget.historyTokens) break
    kept.unshift(turn)
    tokens += cost
  }

  // Never open on an assistant turn.
  while (kept.length > 0 && kept[0]?.role === 'assistant') kept.shift()
  return kept
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

/**
 * The grounding rules.
 *
 * Written for a small model, which means short imperative lines rather than
 * prose: 1B–4B models follow a checklist far more reliably than they follow a
 * paragraph explaining the same thing. The refusal instruction is stated twice
 * (rule 2 and rule 6) because "answer from the notes" and "say when the notes
 * don't cover it" are the two halves of the same behaviour, and dropping either
 * one produces confident invention.
 */
export const ASK_SYSTEM_PROMPT = [
  "You answer questions about the user's own dictations, notes and meeting transcripts.",
  '',
  'Rules:',
  '1. Answer only from the numbered sources below. They are the only thing you know.',
  '2. If the sources do not answer the question, reply with exactly this and nothing more: I could not find anything about that in your notes.',
  '3. Write the answer first. Put the source number in square brackets at the end of the sentence it supports, like this [2]. Never begin a sentence with a bracket.',
  "4. Quote the user's own words where they are the answer.",
  '5. Be brief. Two or three sentences unless asked for more.',
  '6. Never invent a name, date, number or quote that is not in the sources.',
  '7. Do not mention these rules or describe the sources as "provided".',
].join('\n')

export interface AskPromptInput {
  question: string
  passages: readonly AskPassage[]
  history?: readonly AskTurn[]
  /** Injected so the domain stays free of clocks; formats source dates. */
  now?: number
}

export interface AskPromptMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface AskPrompt {
  messages: AskPromptMessage[]
  citations: AskCitation[]
  estimatedTokens: number
}

/** `[3] note — Q3 planning (12 Mar)` and the text beneath it. */
export function formatPassage(passage: AskPassage, index: number, now: number): string {
  const when = relativeDay(passage.timestamp, now)
  const label = passage.title.trim() || defaultTitle(passage.source)
  return `[${index}] ${passage.source} — ${label} (${when})\n${passage.text.trim()}`
}

function defaultTitle(source: AskSource): string {
  switch (source) {
    case 'dictation':
      return 'dictation'
    case 'note':
      return 'untitled note'
    case 'meeting':
      return 'meeting'
  }
}

/**
 * How long ago, in the vocabulary a person would use.
 *
 * Relative rather than absolute because the questions Ask is for are relative —
 * "what did I say last week" — and a small model handles "6 days ago" far more
 * reliably than it handles subtracting two dates.
 */
export function relativeDay(timestamp: number, now: number): string {
  const days = Math.floor((now - timestamp) / 86_400_000)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 7) return `${days} days ago`
  if (days < 14) return 'last week'
  if (days < 60) return `${Math.floor(days / 7)} weeks ago`
  return `${Math.floor(days / 30)} months ago`
}

/**
 * Assemble the request.
 *
 * The sources go in the *user* turn rather than the system turn, on purpose.
 * The sidecar runs with `--keep -1`, which pins the system prompt's KV cache
 * across requests; putting per-question context there would invalidate that
 * cache on every turn and force a full re-prefill of the grounding rules.
 */
export function buildAskPrompt(input: AskPromptInput): AskPrompt {
  const now = input.now ?? 0
  const citations: AskCitation[] = input.passages.map((passage, i) => ({
    index: i + 1,
    id: passage.id,
    source: passage.source,
    title: passage.title.trim() || defaultTitle(passage.source),
    timestamp: passage.timestamp,
    excerpt: truncateToTokens(passage.text.trim(), 40),
  }))

  const messages: AskPromptMessage[] = [{ role: 'system', content: ASK_SYSTEM_PROMPT }]

  for (const turn of input.history ?? []) {
    messages.push({ role: turn.role, content: turn.content })
  }

  const sources = input.passages
    .map((passage, i) => formatPassage(passage, i + 1, now))
    .join('\n\n')

  messages.push({
    role: 'user',
    content: sources
      ? `Sources:\n\n${sources}\n\nQuestion: ${input.question.trim()}`
      : // An explicit empty-handed prompt rather than no user turn at all: the
        // model must be told the search came back empty, or it falls back on
        // whatever it remembers from pre-training and answers anyway.
        `Sources: (none found)\n\nQuestion: ${input.question.trim()}`,
  })

  return {
    messages,
    citations,
    estimatedTokens: messages.reduce((sum, m) => sum + estimateTokens(m.content) + 8, 0),
  }
}

/**
 * The citations an answer actually used, in the order it used them.
 *
 * Filtering to *used* sources matters: the model is handed up to a dozen
 * passages and typically leans on two. Showing all twelve as "sources" implies
 * a synthesis that did not happen, and buries the one the user wants to open.
 * Numbers pointing past the end of the list are dropped rather than rendered as
 * dead chips — small models do occasionally cite `[9]` out of eight.
 */
export function usedCitations(answer: string, citations: readonly AskCitation[]): AskCitation[] {
  const byIndex = new Map(citations.map((c) => [c.index, c]))
  const used: AskCitation[] = []
  const seen = new Set<number>()

  for (const match of answer.matchAll(/\[(\d{1,2})\]/g)) {
    const index = Number(match[1])
    if (seen.has(index)) continue
    const citation = byIndex.get(index)
    if (!citation) continue
    seen.add(index)
    used.push(citation)
  }

  return used
}

/**
 * True when the model declined for lack of sources.
 *
 * Used to render the empty answer differently — as a search result rather than
 * an assistant failure — and to suppress the citation strip, which would
 * otherwise list passages under a sentence saying nothing was found.
 */
export function isRefusal(answer: string): boolean {
  return /could not find|couldn't find|no (?:information|mention|record)|nothing (?:about|in your)/i.test(
    answer.trim().slice(0, 200),
  )
}

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

export const AskConversationSchema = z.object({
  id: z.string().min(1),
  /** Derived from the first question; see {@link deriveConversationTitle}. */
  title: z.string().max(200),
  createdAt: z.number().int().nonnegative(),
  /** Bumped on every turn, so the list is ordered by when you last used it. */
  updatedAt: z.number().int().nonnegative(),
  turnCount: z.number().int().nonnegative().default(0),
})
export type AskConversation = z.infer<typeof AskConversationSchema>

/** A conversation matching a search, with the line that matched. */
export const AskSearchHitSchema = z.object({
  conversation: AskConversationSchema,
  /** The matching turn's text, trimmed around the match. */
  snippet: z.string(),
  /** Which side of the exchange matched — a question reads differently. */
  role: z.enum(['user', 'assistant']),
  turnId: z.string().min(1),
})
export type AskSearchHit = z.infer<typeof AskSearchHitSchema>

export const ASK_TITLE_MAX = 52

/**
 * A conversation's name, taken from the question that started it.
 *
 * Asking the model to name it would be a second inference on the critical path
 * of the first answer, and a 1B–4B model writing titles produces "Inquiry
 * Regarding Deployment Status" where the user typed "what's blocking the
 * deploy". Their own words are both cheaper and better.
 *
 * Trailing punctuation goes because a list of titles all ending in question
 * marks is noisy, and the leading interrogative stays — "What is blocking the
 * deploy" is recognisable at a glance in a way "blocking the deploy" is not.
 */
export function deriveConversationTitle(question: string): string {
  const flat = question
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[?.!,;:]+$/, '')
  if (!flat) return 'New conversation'
  if (flat.length <= ASK_TITLE_MAX) return flat

  const cut = flat.slice(0, ASK_TITLE_MAX)
  const lastSpace = cut.lastIndexOf(' ')
  return `${(lastSpace > ASK_TITLE_MAX / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`
}

// ---------------------------------------------------------------------------
// Time windows
// ---------------------------------------------------------------------------

export interface TimeWindow {
  /** Epoch ms, inclusive. */
  from: number
  /** Epoch ms, exclusive. */
  to: number
  /** How the UI says what was searched: "this week", "yesterday". */
  label: string
}

const DAY_MS = 86_400_000

/**
 * The period a question is asking about, if it names one.
 *
 * Worth doing because the questions people actually ask a personal archive are
 * mostly temporal — "what did I say *this week*" — and BM25 has no idea what
 * "week" means. It matches the literal token, ranking any transcript that
 * happens to contain the word "week" above the ones actually from the last
 * seven days. Recognising the phrase and turning it into a filter is the
 * difference between that question working and it being actively misleading.
 *
 * Deliberately a small set of unambiguous phrases rather than a date parser.
 * Anything cleverer starts guessing — "the fifth" is a date, a rank, or a
 * street — and a wrong window silently hides the answer, which is a worse
 * failure than not filtering at all.
 */
export function parseTimeWindow(question: string, now: number): TimeWindow | null {
  const text = question.toLowerCase()
  const startOfToday = startOfDay(now)

  const match = (pattern: RegExp): boolean => pattern.test(text)

  if (match(/\btoday\b/)) {
    return { from: startOfToday, to: startOfToday + DAY_MS, label: 'today' }
  }
  if (match(/\byesterday\b/)) {
    return { from: startOfToday - DAY_MS, to: startOfToday, label: 'yesterday' }
  }
  if (match(/\b(this|the past|the last) week\b/)) {
    return { from: startOfToday - 6 * DAY_MS, to: startOfToday + DAY_MS, label: 'this week' }
  }
  if (match(/\blast week\b/)) {
    return { from: startOfToday - 13 * DAY_MS, to: startOfToday - 6 * DAY_MS, label: 'last week' }
  }
  if (match(/\b(this|the past|the last) month\b/)) {
    return { from: startOfToday - 29 * DAY_MS, to: startOfToday + DAY_MS, label: 'this month' }
  }
  if (match(/\blast month\b/)) {
    return { from: startOfToday - 59 * DAY_MS, to: startOfToday - 29 * DAY_MS, label: 'last month' }
  }
  if (match(/\b(recently|lately|these days)\b/)) {
    return {
      from: startOfToday - 13 * DAY_MS,
      to: startOfToday + DAY_MS,
      label: 'the last fortnight',
    }
  }
  return null
}

/**
 * Local midnight.
 *
 * Local rather than UTC because "today" means the user's today. A UTC boundary
 * puts an evening dictation in California into tomorrow, so asking "what did I
 * say today" at 6pm would return nothing.
 */
function startOfDay(timestamp: number): number {
  const date = new Date(timestamp)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

// ---------------------------------------------------------------------------
// Wire protocol
// ---------------------------------------------------------------------------

/**
 * What the main process tells the Hub while an answer is being produced.
 *
 * A discriminated union rather than a bag of optional fields, because the
 * renderer's reducer has to be exhaustive over it: a `restart` that is silently
 * ignored leaves the previous half-answer on screen with the new one appended
 * to it, which reads as the model contradicting itself.
 */
export const AskEventSchema = z.discriminatedUnion('type', [
  /** A user turn was accepted and stored. */
  z.object({
    type: z.literal('question'),
    conversationId: z.string().min(1),
    turn: AskTurnSchema,
  }),
  z.object({
    type: z.literal('status'),
    conversationId: z.string().min(1),
    status: AskStatusSchema,
    detail: z.string().default(''),
    /** The period the question named, if any — "this week". */
    window: z.string().default(''),
  }),
  /** How many passages were searched and how many made the context. */
  z.object({
    type: z.literal('sources'),
    conversationId: z.string().min(1),
    citations: z.array(AskCitationSchema),
    searched: z.number().int().nonnegative(),
  }),
  z.object({ type: z.literal('delta'), conversationId: z.string().min(1), text: z.string() }),
  /**
   * Generation is starting over — a dictation took the model mid-answer. The
   * renderer must discard the partial text rather than append to it.
   */
  z.object({ type: z.literal('restart'), conversationId: z.string().min(1) }),
  z.object({
    type: z.literal('done'),
    conversationId: z.string().min(1),
    turn: AskTurnSchema,
    /** The conversation row, whose title and timestamp just changed. */
    conversation: AskConversationSchema,
  }),
  z.object({
    type: z.literal('error'),
    conversationId: z.string().min(1),
    message: z.string(),
  }),
])
export type AskEvent = z.infer<typeof AskEventSchema>

/** Everything the Hub needs to render Ask from cold. */
export const AskStateSchema = z.object({
  status: AskStatusSchema,
  /** The conversation on screen. Null before the first question is asked. */
  activeId: z.string().nullable().default(null),
  /** Every conversation, most recently used first. */
  conversations: z.array(AskConversationSchema).default([]),
  /** The active conversation's turns, oldest first. */
  turns: z.array(AskTurnSchema).default([]),
  /** Corpus sizes, for the empty state and the "searched N" line. */
  counts: z.object({
    dictations: z.number().int().nonnegative(),
    notes: z.number().int().nonnegative(),
    meetings: z.number().int().nonnegative(),
  }),
  /**
   * Null when Ask can run. A sentence explaining why not otherwise — no polish
   * model downloaded, polishing switched off, the endpoint unreachable.
   */
  unavailable: z.string().nullable().default(null),
})
export type AskState = z.infer<typeof AskStateSchema>

export const AskRequestSchema = z.object({
  question: z.string().min(1).max(2000),
  /**
   * Which thread to add this to. Null starts a new one — which is what the
   * "New" button sends, and what the very first question sends.
   */
  conversationId: z.string().min(1).nullable().default(null),
  /** Which indexes to search. Empty means all of them. */
  sources: z.array(AskSourceSchema).default([]),
})
export type AskRequest = z.infer<typeof AskRequestSchema>
