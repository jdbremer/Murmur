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
  /**
   * What this answer was built from — "12 dictations and 1 meeting from today".
   *
   * Stored on the turn rather than held in view state because it is provenance,
   * and provenance that disappears when you reopen the conversation is worse
   * than none: a recap with no citations and no coverage line is a summary the
   * reader has to take entirely on trust.
   */
  coverage: z.string().default(''),
  /**
   * True when the model hit the token cap mid-answer.
   *
   * Worth storing rather than merely logging: a truncated answer is still the
   * best answer available and is kept, so without a mark on it the reader has
   * no way to tell a sentence the model chose to end from one that simply
   * stopped.
   */
  truncated: z.boolean().default(false),
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
  /**
   * Reserved for the answer, so the model is never cut off mid-sentence.
   *
   * 512 was not enough. A multi-hop question — one that has to reconcile two
   * sources before it can answer — ran past it and stopped mid-clause, and
   * nothing downstream noticed, because the truncation flag the stream already
   * returns was being discarded. Raised against a measured overrun rather than
   * doubled on principle: it comes out of the passage budget, and passages are
   * what make the answer grounded in the first place.
   */
  answerTokens: 768,
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
    /**
     * What the answer was built from, in words — "12 dictations and 1 meeting
     * from today". Empty for an ordinary lookup, where the citation chips
     * already say. A recap has no per-claim citations to show (it read
     * everything), so this line is the only thing standing between the reader
     * and taking a summary's completeness on faith.
     */
    coverage: z.string().default(''),
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
  /** Opening questions built from what this user actually has. */
  suggestions: z.array(z.object({ question: z.string(), hint: z.string() })).default([]),
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

// ---------------------------------------------------------------------------
// Intent
// ---------------------------------------------------------------------------

/**
 * What kind of question this is, and therefore how to answer it.
 *
 * The first version of Ask had one strategy — rank passages by keyword
 * relevance and hand the model the best few — and pointed it at every question.
 * That answers "what did I say about the migration" and is *structurally*
 * incapable of answering the two things people actually try first:
 *
 *  - **"Summarize my day."** The words carry the instruction, not the topic, so
 *    BM25 ranks by whichever record happens to contain "today" or "summarize".
 *    The model then faithfully summarises the one or two records it was handed
 *    and produces a confident, tiny, wrong answer. A recap needs *everything in
 *    the window*, chronologically — the opposite of top-k by relevance.
 *  - **"Do I have any meetings transcribed?"** This is a question about the
 *    catalogue, not the contents. No amount of full-text search over transcript
 *    *text* can answer whether a transcript *exists*; the answer lives in
 *    counts and dates.
 *
 * So the question is routed first, and each route retrieves differently.
 */
export const ASK_INTENTS = ['lookup', 'recap', 'catalog'] as const
export const AskIntentSchema = z.enum(ASK_INTENTS)
export type AskIntent = z.infer<typeof AskIntentSchema>

export interface AskPlan {
  intent: AskIntent
  /** The period the question named, or one implied by a bare recap. */
  window: TimeWindow | null
  /** For a catalogue question that named one kind of thing. */
  focus: AskSource | null
  /** Content words left after the instruction vocabulary is removed. */
  topic: string[]
  /**
   * What to actually search — the question, plus the subject it is leaning on
   * from earlier in the conversation. See {@link planAsk}.
   */
  query: string
  /** True when the question only makes sense as a continuation. */
  followUp: boolean
}

/** What was asked immediately before, so a follow-up can lean on it. */
export interface AskContext {
  previousQuestion: string | null
}

/**
 * Words that point at something already said rather than naming it.
 *
 * "Who is fixing **that**?" is a complete sentence and a useless search query:
 * every content word in it is either grammar or a pointer, so retrieval looks
 * for "fixing" and finds whichever record happens to mention fixing anything.
 */
const REFERENTIAL_RE = /\b(it|its|that|those|this|these|they|them|their|one|ones|same|so)\b/i

/** Openers that only exist to continue — "and…", "what about…". */
const CONTINUATION_RE =
  /^\s*(and\b|also\b|plus\b|what about\b|how about\b|what else\b|who else\b|anything else\b|any others?\b|more\b|then\b)/i

/**
 * Words that carry *the shape of the request* rather than its subject.
 *
 * Distinct from {@link STOPWORDS}-style grammar: these are meaningful English
 * words that happen to describe what the user wants done. "Summarize what I
 * dictated today" has no topic — every content word in it is an instruction —
 * and recognising that is exactly what separates a recap from a lookup.
 */
const INSTRUCTION_WORDS = new Set([
  'anything',
  'brief',
  'catch',
  'dictate',
  'dictated',
  'dictating',
  'dictation',
  'dictations',
  'digest',
  'discuss',
  'discussed',
  'everything',
  'get',
  'give',
  'going',
  'happened',
  'me',
  'my',
  'overview',
  'recap',
  'recorded',
  'recording',
  'recordings',
  'rundown',
  'said',
  'say',
  'saying',
  'summarise',
  'summarised',
  'summarize',
  'summarized',
  'summary',
  'talk',
  'talked',
  'talking',
  'transcribe',
  'transcribed',
  'transcript',
  'transcripts',
  'up',
  'work',
  'worked',
  'working',
  'wrote',
])

/** Words naming a period; already handled by {@link parseTimeWindow}. */
const PERIOD_WORDS = new Set([
  'day',
  'days',
  'few',
  'fortnight',
  'last',
  'lately',
  'month',
  'months',
  'morning',
  'next',
  'past',
  'previous',
  'recent',
  'recently',
  'today',
  'tonight',
  'week',
  'weeks',
  'yesterday',
])

const RECAP_RE =
  /\b(summari[sz]e|summari[sz]ed|summary|recap|rundown|overview|digest|catch me up|brief me)\b/i

/** "What did I work on", "what have I been up to" — a recap without the verb. */
const RECAP_PHRASE_RE =
  /\bwhat (did|have) (i|we) (been )?(do|doing|done|work|worked|working|say|said|saying|talk|talked|discuss|discussed|get|got|up to)\b/i

const CATALOG_RE = [
  /\b(do|did|have|has) (i|we) (have|got|recorded|transcribed|made)\b/i,
  /\bhow (many|much)\b/i,
  /\b(is|are) there (any|a|an)\b/i,
  /\bwhen (did|was) (i|my|the)\b.*\b(last|first|latest|most recent)\b/i,
  /\b(list|show me|show|what) (all )?(my |the )?(meetings?|notes?|dictations?|transcripts?|recordings?|conversations?)\b/i,
  /\bany (meetings?|notes?|dictations?|transcripts?|recordings?)\b/i,
  /\b(how long|how much time|total)\b/i,
]

/** Which kind of thing a catalogue question is about, when it names one. */
const FOCUS_PATTERNS: [RegExp, AskSource][] = [
  [/\b(meetings?|calls?|standups?)\b/i, 'meeting'],
  [/\b(notes?|scratchpad)\b/i, 'note'],
  [/\b(dictations?|dictated)\b/i, 'dictation'],
]

/**
 * Decide how to answer a question.
 *
 * Rule-based rather than a classification round-trip through the model. A 1B–4B
 * model classifying its own input is both slower (a whole extra inference
 * before the first token) and less reliable than a dozen regexes, and — unlike
 * the model — this can be tested exhaustively and behaves the same every time.
 *
 * The ordering matters: catalogue is checked first because it is the most
 * specific, and a question like "how many meetings did I record this week"
 * satisfies the recap patterns too.
 */
export function planAsk(
  question: string,
  now: number,
  context: AskContext = { previousQuestion: null },
): AskPlan {
  const window = parseTimeWindow(question, now)
  const topic = topicTerms(question)
  const own = ownIntent(question, topic)

  // A question that leans on the last one: a pointer with no antecedent, a
  // continuation opener, or nothing left at all once the grammar is removed.
  const leaning =
    CONTINUATION_RE.test(question) || REFERENTIAL_RE.test(question) || topic.length === 0
  const followUp = leaning && Boolean(context.previousQuestion)

  // Carry the previous question's subject into the search. Retrieval never
  // sees the conversation — only the prompt does — so without this, "who is
  // fixing that?" searches for "fixing" and truthfully reports finding
  // nothing, moments after the thing being pointed at was on screen.
  //
  // The *question* is left alone; only the search text grows. The model still
  // reads what the user actually typed, with the real history above it.
  let query = question
  if (followUp && context.previousQuestion) {
    const carried = topicTerms(context.previousQuestion).filter((term) => !topic.includes(term))
    if (carried.length > 0) query = `${question} ${carried.join(' ')}`
  }

  // Intent the question declares for itself always wins. Only a question that
  // declares none inherits — so "what about yesterday?" after a recap recaps
  // yesterday, while "who owns it?" after a recap is still a lookup.
  const intent: AskIntent =
    own ?? (followUp ? (inheritableIntent(context.previousQuestion) ?? 'lookup') : 'lookup')

  if (intent === 'catalog') {
    const focus = FOCUS_PATTERNS.find(([pattern]) => pattern.test(question))?.[1] ?? null
    return { intent, window, focus, topic, query, followUp }
  }
  if (intent === 'recap') {
    // A bare "give me a recap" means the recent past; today is the reading
    // that makes the answer small enough to be worth having.
    return {
      intent,
      window: window ?? todayWindow(now),
      focus: null,
      topic,
      query,
      followUp,
    }
  }
  return { intent: 'lookup', window, focus: null, topic, query, followUp }
}

/** The intent a question declares by itself, or null when it declares none. */
function ownIntent(question: string, topic: string[]): AskIntent | null {
  if (CATALOG_RE.some((pattern) => pattern.test(question))) return 'catalog'
  // A recap only when the question has *no subject left* once the instruction
  // vocabulary is removed. "Summarize my day" is a recap; "summarize what I
  // said about the migration" still has a subject, and the ordinary lookup
  // path — find the migration, let the model summarise it — is a far better
  // answer than dumping the whole day on the model.
  if ((RECAP_RE.test(question) || RECAP_PHRASE_RE.test(question)) && topic.length === 0) {
    return 'recap'
  }
  return null
}

/**
 * What the previous question was answered as.
 *
 * Recomputed from its text rather than stored, so there is exactly one
 * definition of what a question means and no second copy to fall out of step.
 * Planned without context of its own, which is what stops the recursion.
 */
function inheritableIntent(previousQuestion: string | null): AskIntent | null {
  if (!previousQuestion) return null
  return ownIntent(previousQuestion, topicTerms(previousQuestion))
}

/** The content words, with grammar, instructions and period words removed. */
function topicTerms(question: string): string[] {
  return question
    .toLowerCase()
    .split(/[^\p{L}\p{N}']+/u)
    .map((term) => term.replace(/^'+|'+$/g, ''))
    .filter(
      (term) =>
        term.length > 1 &&
        !INSTRUCTION_WORDS.has(term) &&
        !PERIOD_WORDS.has(term) &&
        !QUESTION_GRAMMAR.has(term),
    )
}

/**
 * Grammar shared with the FTS query builder.
 *
 * Deliberately a second, smaller list rather than a reference to the retrieval
 * one: that list exists to stop a search matching everything, this one exists
 * to decide whether a question has a subject, and letting them drift apart is
 * better than coupling two judgements that answer different questions.
 */
const QUESTION_GRAMMAR = new Set([
  'a',
  'about',
  'all',
  'am',
  'an',
  'and',
  'any',
  'are',
  'as',
  'at',
  'be',
  'been',
  'but',
  'by',
  'can',
  'could',
  'did',
  'do',
  'does',
  'for',
  'from',
  'had',
  'has',
  'have',
  'how',
  'i',
  'if',
  'in',
  'is',
  'it',
  'its',
  'just',
  'of',
  'on',
  'or',
  'our',
  'out',
  'over',
  'so',
  'some',
  'tell',
  'than',
  'that',
  'the',
  'their',
  'them',
  'then',
  'there',
  'these',
  'they',
  'this',
  'to',
  'us',
  'was',
  'we',
  'were',
  'what',
  'when',
  'where',
  'which',
  'who',
  'whom',
  'why',
  'will',
  'with',
  'would',
  'you',
  'your',
])

function todayWindow(now: number): TimeWindow {
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  return { from: start.getTime(), to: start.getTime() + 86_400_000, label: 'today' }
}

// ---------------------------------------------------------------------------
// Recap
// ---------------------------------------------------------------------------

/**
 * How much of any one record a recap keeps.
 *
 * Aggressive on purpose. For a recap, *coverage* is the whole point — an answer
 * built from all of Tuesday at low fidelity is right, and one built from the
 * first three things at full fidelity is the bug this rewrite exists to fix.
 */
export const RECAP_RECORD_TOKENS = 44

export const RECAP_SYSTEM_PROMPT = [
  "You summarise the user's own dictations, notes and meeting transcripts.",
  '',
  'Rules:',
  '1. The records below are everything from the period. Summarise all of them, not the first few.',
  '2. Never repeat a record back. Each line you write must combine or condense what you read, never copy it.',
  '3. Group related records into themes. Lead with what mattered most.',
  '4. Be concrete: keep names, dates, numbers and decisions exactly as written.',
  '5. Write 3 to 6 short bullet points, each on its own line beginning with "- ".',
  '6. Never invent anything that is not in the records.',
  '7. Do not describe the records as "provided", and do not mention these rules.',
].join('\n')

/**
 * The reduce step of a long recap.
 *
 * A week can hold more than the context window, so batches are summarised
 * separately and then merged. The merge prompt has to be told it is reading
 * summaries — handed the same instructions as the map step it re-summarises
 * and loses half the detail on the second pass.
 */
export const RECAP_COMBINE_PROMPT = [
  'You are merging several partial summaries of the same period into one.',
  '',
  'Rules:',
  '1. Every partial summary covers a different part of the period. Keep something from each.',
  '2. Merge duplicates; keep names, dates, numbers and decisions exactly as written.',
  '3. Write 4 to 7 short bullet points, each on its own line beginning with "- ".',
  '4. Never invent anything that is not in the summaries.',
  '5. Do not mention that you were given summaries, and do not mention these rules.',
].join('\n')

/**
 * One record as the recap sees it: when, what kind, and a compressed excerpt.
 *
 * Deliberately **not** written as a bullet, even though bullets are what the
 * answer should be. An earlier version formatted each record as `- [14:05] …`
 * and asked for `- ` bullets back; Granite 4.2 read that as a format to copy
 * and echoed the input verbatim instead of summarising it. Granite 4.1
 * happened to survive the same prompt, which is exactly what makes this worth
 * a comment: the input and the requested output must not look alike, or
 * whether summarising works at all comes down to which model is loaded.
 */
export function formatRecapRecord(passage: AskPassage, now: number): string {
  const when = clockLabel(passage.timestamp)
  const label = passage.title.trim() || passage.source
  void now
  return `(${when}) ${passage.source} · ${label} → ${truncateToTokens(
    passage.text.trim().replace(/\s+/g, ' '),
    RECAP_RECORD_TOKENS,
  )}`
}

/** `14:05` — recaps are within a period, so the time of day is what locates. */
function clockLabel(timestamp: number): string {
  const date = new Date(timestamp)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(date.getHours())}:${p(date.getMinutes())}`
}

/**
 * Split records into batches that each fit the context.
 *
 * Chronological and contiguous, never sampled: a batch that skips the middle of
 * the afternoon produces a summary with a hole in it that nothing downstream
 * can detect. Batching keeps every record, at the cost of one inference pass
 * per batch.
 */
export function batchRecords(
  passages: readonly AskPassage[],
  now: number,
  budget = ASK_BUDGET,
): AskPassage[][] {
  const limit = passageBudgetTokens(budget)
  const batches: AskPassage[][] = []
  let current: AskPassage[] = []
  let tokens = 0

  for (const passage of passages) {
    const cost = estimateTokens(formatRecapRecord(passage, now))
    // A single record over the whole budget still gets its own batch rather
    // than being dropped — `formatRecapRecord` has already truncated it, so
    // this is only reachable with an absurd budget.
    if (current.length > 0 && tokens + cost > limit) {
      batches.push(current)
      current = []
      tokens = 0
    }
    current.push(passage)
    tokens += cost
  }
  if (current.length > 0) batches.push(current)

  return batches
}

export function buildRecapPrompt(input: {
  question: string
  records: readonly AskPassage[]
  label: string
  now: number
}): AskPromptMessage[] {
  const body = input.records.map((record) => formatRecapRecord(record, input.now)).join('\n')
  return [
    { role: 'system', content: RECAP_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `Everything from ${input.label} (${input.records.length} record${
        input.records.length === 1 ? '' : 's'
      }):\n\n${body}\n\nRequest: ${input.question.trim()}`,
    },
  ]
}

export function buildCombinePrompt(input: {
  question: string
  summaries: readonly string[]
  label: string
}): AskPromptMessage[] {
  const body = input.summaries
    .map((summary, i) => `Part ${i + 1} of ${input.summaries.length}:\n${summary.trim()}`)
    .join('\n\n')
  return [
    { role: 'system', content: RECAP_COMBINE_PROMPT },
    {
      role: 'user',
      content: `Partial summaries of ${input.label}:\n\n${body}\n\nRequest: ${input.question.trim()}`,
    },
  ]
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

/** What exists, rather than what it says. */
export const CorpusDigestSchema = z.object({
  dictations: z.object({
    total: z.number().int().nonnegative(),
    today: z.number().int().nonnegative(),
    week: z.number().int().nonnegative(),
    firstAt: z.number().int().nonnegative().nullable(),
    lastAt: z.number().int().nonnegative().nullable(),
    words: z.number().int().nonnegative(),
  }),
  notes: z.object({
    total: z.number().int().nonnegative(),
    lastAt: z.number().int().nonnegative().nullable(),
    recent: z.array(z.object({ title: z.string(), at: z.number().int().nonnegative() })),
  }),
  meetings: z.object({
    total: z.number().int().nonnegative(),
    lastAt: z.number().int().nonnegative().nullable(),
    totalMs: z.number().int().nonnegative(),
    recent: z.array(
      z.object({
        title: z.string(),
        at: z.number().int().nonnegative(),
        durationMs: z.number().int().nonnegative(),
        indexed: z.boolean(),
      }),
    ),
  }),
})
export type CorpusDigest = z.infer<typeof CorpusDigestSchema>

export const CATALOG_SYSTEM_PROMPT = [
  "You answer questions about what is in the user's Murmur archive.",
  '',
  'Rules:',
  '1. Answer only from the inventory below. It is complete and current.',
  '2. Answer the actual question first, in one sentence, then add the useful detail.',
  '3. Start with Yes or No only when the question can be answered yes or no. A question starting with when, what, which or how many is not one.',
  '4. Use the exact numbers, titles and dates from the inventory. Never estimate.',
  '5. Be brief. Two or three sentences.',
  '6. Do not mention the inventory, and do not mention these rules.',
].join('\n')

/**
 * Render the inventory for the model.
 *
 * A small table of facts rather than prose, because the failure mode being
 * avoided is arithmetic: a small model handed "you have 350 dictations" answers
 * "how many do I have" perfectly, and handed 350 dictations answers it by
 * guessing.
 */
export function formatCorpusDigest(digest: CorpusDigest, now: number): string {
  const when = (at: number | null): string => (at === null ? 'never' : relativeDay(at, now))
  const lines: string[] = []

  lines.push('Inventory:')
  lines.push(
    `- Dictations: ${digest.dictations.total} transcribed in total ` +
      `(${digest.dictations.today} today, ${digest.dictations.week} in the last 7 days), ` +
      `${digest.dictations.words.toLocaleString()} words. ` +
      `Most recent ${when(digest.dictations.lastAt)}, first ${when(digest.dictations.firstAt)}.`,
  )
  lines.push(
    `- Notes: ${digest.notes.total} in the Scratchpad. Most recent ${when(digest.notes.lastAt)}.`,
  )
  for (const note of digest.notes.recent) {
    lines.push(`    · "${note.title}" — ${when(note.at)}`)
  }

  const meetings = digest.meetings
  lines.push(
    `- Meetings: ${meetings.total} recorded and transcribed, ` +
      `${Math.round(meetings.totalMs / 60_000)} minutes in total. ` +
      `Most recent ${when(meetings.lastAt)}.`,
  )
  for (const meeting of meetings.recent) {
    lines.push(
      `    · "${meeting.title}" — ${when(meeting.at)}, ` +
        `${Math.max(1, Math.round(meeting.durationMs / 60_000))} min` +
        `${meeting.indexed ? '' : ' (transcript file missing)'}`,
    )
  }

  return lines.join('\n')
}

export function buildCatalogPrompt(input: {
  question: string
  digest: CorpusDigest
  now: number
}): AskPromptMessage[] {
  return [
    { role: 'system', content: CATALOG_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `${formatCorpusDigest(input.digest, input.now)}\n\nQuestion: ${input.question.trim()}`,
    },
  ]
}

/** "12 dictations and 1 meeting from today" — what an answer was built from. */
export function describeCoverage(passages: readonly AskPassage[], label: string): string {
  const counts = new Map<AskSource, number>()
  for (const passage of passages) counts.set(passage.source, (counts.get(passage.source) ?? 0) + 1)

  const parts = ASK_SOURCES.flatMap((source) => {
    const n = counts.get(source)
    if (!n) return []
    const noun = source === 'dictation' ? 'dictation' : source
    return [`${n} ${noun}${n === 1 ? '' : 's'}`]
  })

  if (parts.length === 0) return `nothing from ${label}`
  const joined =
    parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`
  return `${joined} from ${label}`
}

/**
 * Opening questions drawn from what the user actually has.
 *
 * The first question is the hardest one to ask: a blank composer over a corpus
 * you cannot see gives no clue what this thing is good at. Canned examples help
 * a little, but "What did we agree in Design standup?" — naming a meeting that
 * really happened — teaches the feature in a way "What did we agree in my last
 * meeting?" never does, because the reader can tell it is about *them*.
 *
 * Built from the digest rather than the model: no inference, no latency, and
 * nothing invented.
 */
export function suggestedQuestions(digest: CorpusDigest): { question: string; hint: string }[] {
  const out: { question: string; hint: string }[] = []

  if (digest.dictations.today > 0) {
    out.push({
      question: 'Summarise my day',
      hint: `${digest.dictations.today} dictation${digest.dictations.today === 1 ? '' : 's'} today`,
    })
  } else if (digest.dictations.week > 0) {
    out.push({ question: 'Summarise this week', hint: `${digest.dictations.week} this week` })
  }

  const meeting = digest.meetings.recent[0]
  if (meeting) {
    out.push({ question: `What did we agree in ${meeting.title}?`, hint: 'from the transcript' })
  }

  const note = digest.notes.recent[0]
  if (note) {
    out.push({ question: `What is in my "${note.title}" note?`, hint: 'your most recent note' })
  }

  // A fallback so the opening is never bare, and never more than three so the
  // row stays scannable.
  if (out.length < 3 && digest.dictations.total > 0) {
    out.push({ question: 'What did I say about the deadline?', hint: 'across everything' })
  }
  return out.slice(0, 3)
}
