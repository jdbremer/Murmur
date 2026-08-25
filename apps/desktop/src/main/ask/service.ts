import {
  ASK_BUDGET,
  buildAskPrompt,
  deriveConversationTitle,
  fitPassages,
  parseTimeWindow,
  trimHistory,
  usedCitations,
  type AskConversation,
  type AskEvent,
  type AskRequest,
  type AskSearchHit,
  type AskSource,
  type AskState,
  type AskStatus,
} from '@murmur/shared'

import { isPreempted } from '../engines/gate'
import type { PolishEngine } from '../engines/types'
import { createLogger, type Logger } from '../logging'
import type { AskRepository } from '../store/repositories'
import type { RetrievalRepository } from '../store/retrieval'

/**
 * Ask's orchestrator: retrieve, ground, stream, cite (PLAN §2.2.9).
 *
 * The interesting behaviour is not the chat loop — that part is ordinary — but
 * what happens when a dictation arrives mid-answer. `gate.ts` preempts the
 * stream, and this service is what makes that survivable: it recognises a
 * preemption as distinct from a cancellation, throws away the partial answer,
 * and reruns the same prompt once the model is free.
 *
 * Rerunning rather than resuming is a real choice. Resuming would mean feeding
 * the half-answer back as an assistant turn and asking for a continuation,
 * which small models handle badly — they restate, or drift into a different
 * register mid-paragraph. A visible restart after a ~1s dictation is honest and
 * produces one coherent answer; a seamless-looking resume produces two halves
 * that do not match.
 */
/** How many times an answer may be restarted before we stop trying. */
export const MAX_PREEMPT_RETRIES = 3
export interface AskServiceDeps {
  retrieval: RetrievalRepository
  store: AskRepository
  /** Late-bound: the engine is swapped when settings change. */
  engine: () => PolishEngine | null
  emit: (event: AskEvent) => void
  now?: () => number
  log?: Logger
}
export class AskService {
  readonly #deps: AskServiceDeps
  readonly #now: () => number
  readonly #log: Logger
  #status: AskStatus = 'idle'
  #activeId: string | null = null
  /** Non-null while an answer is in flight; aborting it is a user cancel. */
  #cancel: AbortController | null = null
  constructor(deps: AskServiceDeps) {
    this.#deps = deps
    this.#now = deps.now ?? (() => Date.now())
    this.#log = deps.log ?? createLogger('ask')
  }
  state(): AskState {
    const conversations = this.#deps.store.list()
    // Fall back to the most recent thread rather than opening on a blank pane:
    // reopening the Hub should land you where you left off.
    const activeId = this.#activeId ?? conversations[0]?.id ?? null
    this.#activeId = activeId
    return {
      status: this.#status,
      activeId,
      conversations,
      turns: activeId ? this.#deps.store.turns(activeId) : [],
      counts: this.#deps.retrieval.counts(),
      unavailable: this.#unavailableReason(),
    }
  }
  /** Switch threads. Cancels an answer in flight — it belongs to the old one. */
  open(conversationId: string | null): AskState {
    if (conversationId !== this.#activeId) this.cancel()
    this.#activeId = conversationId
    this.#status = 'idle'
    // An opened-but-never-used thread is clutter in the list; drop any that the
    // user left behind, sparing whichever one they are looking at now.
    this.#deps.store.pruneEmpty(conversationId ?? undefined)
    return this.state()
  }
  search(query: string): AskSearchHit[] {
    return this.#deps.store.search(query)
  }
  rename(conversationId: string, title: string): AskConversation | null {
    return this.#deps.store.rename(conversationId, title.trim().slice(0, 200), this.#now())
  }
  delete(conversationId: string): AskState {
    if (conversationId === this.#activeId) {
      this.cancel()
      this.#activeId = null
    }
    this.#deps.store.delete(conversationId)
    return this.state()
  }
  /** Erase every conversation. Touches nothing it ever cited. */
  clear(): AskState {
    this.cancel()
    this.#deps.store.clear()
    this.#activeId = null
    this.#status = 'idle'
    return this.state()
  }
  /** Stop the answer in flight. Final — unlike a preemption, nothing retries. */
  cancel(): void {
    this.#cancel?.abort(new AskCancelledError())
    this.#cancel = null
    if (this.#status !== 'idle') this.#status = 'idle'
  }
  /**
   * Answer a question.
   *
   * Resolves when the answer is complete or has failed; progress arrives on the
   * event stream rather than in the return value, because the interesting part
   * of an answer is watching it appear.
   */
  async ask(request: AskRequest): Promise<void> {
    const question = request.question.trim()
    if (!question) return
    // One at a time. A second question while the first is streaming replaces
    // it: two concurrent answers would interleave their deltas into a single
    // transcript with no way for the renderer to tell them apart.
    this.cancel()
    const conversation = this.#resolveConversation(request.conversationId, question)
    this.#activeId = conversation.id
    const unavailable = this.#unavailableReason()
    if (unavailable) {
      this.#emit({ type: 'error', conversationId: conversation.id, message: unavailable })
      return
    }
    const controller = new AbortController()
    this.#cancel = controller
    const userTurn = this.#deps.store.append(conversation.id, {
      role: 'user',
      content: question,
      citations: [],
      createdAt: this.#now(),
    })
    this.#emit({ type: 'question', conversationId: conversation.id, turn: userTurn })
    try {
      await this.#answer(conversation.id, question, userTurn.id, request.sources, controller.signal)
    } catch (error) {
      if (isCancelled(error) || controller.signal.aborted) {
        this.#setStatus(conversation.id, 'idle')
        return
      }
      const message = error instanceof Error ? error.message : String(error)
      this.#log.warn(`ask failed: ${message}`)
      this.#setStatus(conversation.id, 'error')
      this.#emit({ type: 'error', conversationId: conversation.id, message })
    } finally {
      if (this.#cancel === controller) this.#cancel = null
    }
  }
  // -- internals -------------------------------------------------------------
  /**
   * The thread this question belongs to, creating one if needed.
   *
   * A new thread is named from the question that started it, before the answer
   * exists — so the list is readable the instant it appears, rather than
   * showing "New conversation" for however long the model takes.
   */
  #resolveConversation(requested: string | null, question: string): AskConversation {
    const existing = requested ? this.#deps.store.get(requested) : null
    if (existing) return existing
    return this.#deps.store.create(deriveConversationTitle(question), this.#now())
  }
  async #answer(
    conversationId: string,
    question: string,
    questionId: string,
    sources: AskSource[],
    signal: AbortSignal,
  ): Promise<void> {
    const now = this.#now()
    const window = parseTimeWindow(question, now)
    this.#setStatus(conversationId, 'searching', window?.label ?? '')
    // Cheap when nothing changed — one `stat` per meeting — so it runs per
    // question rather than on a schedule. A transcript finished thirty seconds
    // ago is exactly the thing someone is most likely to ask about.
    const synced = this.#deps.retrieval.syncMeetings()
    if (synced.indexed || synced.removed) {
      this.#log.info(`meeting index: +${synced.indexed} ~${synced.removed}`)
    }
    const candidates = this.#deps.retrieval.search(question, {
      ...(sources.length > 0 ? { sources } : {}),
      ...(window ? { window } : {}),
    })
    const fitted = fitPassages(candidates)
    // History excludes the question just stored, which is already the prompt's
    // final user turn — including it would show the model the same sentence
    // twice and invite it to answer the earlier copy. Excluded by id rather
    // than by dropping the last row: a positional drop fails silently when the
    // stored order is not what it assumes, by removing someone else's turn.
    const previous = this.#deps.store.turns(conversationId).filter((t) => t.id !== questionId)
    const prompt = buildAskPrompt({
      question,
      passages: fitted.passages,
      history: trimHistory(previous),
      now,
    })
    this.#emit({
      type: 'sources',
      conversationId,
      citations: prompt.citations,
      searched: candidates.length,
    })
    const answer = await this.#generate(conversationId, prompt.messages, signal)
    const turn = this.#deps.store.append(conversationId, {
      role: 'assistant',
      content: answer,
      citations: usedCitations(answer, prompt.citations),
      createdAt: this.#now(),
    })
    this.#setStatus(conversationId, 'idle')
    const conversation = this.#deps.store.get(conversationId)
    if (conversation) {
      this.#emit({ type: 'done', conversationId, turn, conversation })
    }
  }
  /**
   * Stream one answer, restarting if a dictation takes the model.
   *
   * The retry budget exists because preemption is not rate-limited: someone
   * dictating steadily could restart an answer indefinitely, and an Ask pane
   * that flickers forever is worse than one that says it gave way.
   */
  async #generate(
    conversationId: string,
    messages: { role: 'system' | 'user' | 'assistant'; content: string }[],
    signal: AbortSignal,
  ): Promise<string> {
    for (let attempt = 0; ; attempt += 1) {
      const engine = this.#deps.engine()
      if (!engine?.streamChat) throw new Error('The polishing model is not available right now.')
      let text = ''
      try {
        this.#setStatus(conversationId, 'answering')
        const stream = engine.streamChat({
          messages,
          maxTokens: ASK_BUDGET.answerTokens,
          signal,
        })
        for await (const delta of stream) {
          text += delta
          this.#emit({ type: 'delta', conversationId, text: delta })
        }
        return text.trim()
      } catch (error) {
        // A user cancel and a dictation preemption both surface as an abort;
        // only the reason distinguishes them, and only one of them retries.
        if (signal.aborted || isCancelled(error)) throw error
        if (!isPreempted(error)) throw error
        if (attempt >= MAX_PREEMPT_RETRIES) {
          throw new Error('Dictation kept needing the model, so the answer was dropped.', {
            cause: error,
          })
        }
        this.#log.info(`preempted by dictation; restarting (attempt ${attempt + 1})`)
        this.#setStatus(conversationId, 'paused')
        this.#emit({ type: 'restart', conversationId })
      }
    }
  }
  #unavailableReason(): string | null {
    const engine = this.#deps.engine()
    if (!engine) {
      return 'Ask needs a polishing model. Turn Polishing on in Settings and pick one.'
    }
    if (!engine.streamChat) return 'This polishing engine cannot answer questions.'
    const status = engine.status()
    switch (status.state) {
      case 'unavailable':
        return status.detail || 'The polishing model is unavailable.'
      case 'idle':
        // Idle covers both "never loaded" and "unloaded after ten minutes of
        // nothing". The second is normal and recoverable — the first request
        // respawns the sidecar — so it must not read as an error.
        return status.modelId ? null : 'No polishing model is loaded yet.'
      default:
        return null
    }
  }
  #setStatus(conversationId: string, status: AskStatus, window = ''): void {
    this.#status = status
    this.#emit({ type: 'status', conversationId, status, detail: '', window })
  }
  #emit(event: AskEvent): void {
    this.#deps.emit(event)
  }
}
/** Thrown into the abort signal when the user stops an answer. */
export class AskCancelledError extends Error {
  constructor() {
    super('Cancelled')
    this.name = 'AskCancelledError'
  }
}
function isCancelled(error: unknown): boolean {
  const name = (error as { name?: string })?.name
  return name === 'AskCancelledError' || name === 'AbortError'
}
