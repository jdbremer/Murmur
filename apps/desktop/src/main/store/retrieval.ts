import { readFileSync, statSync } from 'node:fs'

import type { Database } from 'better-sqlite3'
import { type AskPassage, type AskSource, type TimeWindow } from '@murmur/shared'

import { createLogger, type Logger } from '../logging'

/**
 * Retrieval for Ask (PLAN §2.2.9) — finding the handful of passages worth
 * showing a small model.
 *
 * Three separate FTS5 indexes are searched, not one: dictations, notes and
 * meeting chunks live in different tables with different corpora, and merging
 * them into a single index would mean rebuilding it whenever any of the three
 * changed. The interesting problem is therefore *fusion* — turning three ranked
 * lists into one — and the interesting constraint is that BM25 scores from
 * different indexes are not comparable. See {@link fuseRankings}.
 */

/** How many candidates to pull from each index before fusing. */
export const PER_SOURCE_LIMIT = 24

/**
 * Reciprocal-rank-fusion constant, at its conventional value.
 *
 * `k` controls how sharply rank 1 beats rank 2. At 60 the curve is gentle,
 * which is what we want: a note at rank 3 in a corpus of 40 notes is often more
 * useful than a dictation at rank 1 in a corpus of 400, and a sharper curve
 * would let whichever index happened to match first dominate the context.
 */
export const RRF_K = 60

/**
 * How much recency may add to a fused score, as a fraction of a rank-1 hit.
 *
 * Non-zero because this is a personal corpus and the honest prior is that a
 * thing said last Tuesday is more likely to be the thing meant than the same
 * words from eight months ago.
 *
 * The size is chosen against the rank curve rather than by taste, and the
 * arithmetic is the argument. Relevance runs `(k+1)/(k+rank)`, so a brand-new
 * passage at rank *r* outranks a year-old one at rank 1 exactly when
 * `61/(60+r) + w > 1`. At `w = 0.05` that holds through rank 4 and fails at
 * rank 5: **recency can promote a passage by at most three places.**
 *
 * That it can reach the top slot at all is deliberate, and it follows from what
 * RRF throws away. Fusion keeps only the ordering, so a unique, perfect,
 * one-of-a-kind match and a marginal top hit in a field of near-identical ones
 * both arrive as "rank 1" — the magnitude that would have distinguished them is
 * gone. Since the top hit is not reliably *decisively* best, letting a much
 * fresher near-match overtake it is the better bet on a personal corpus, where
 * forty rows all containing "migration" is the normal case and the one from
 * Tuesday is usually the one meant.
 *
 * Three places, though, not twelve. An earlier draft used 0.15, which spans
 * about twelve positions — enough for today's twelfth-best match to displace
 * the best in the corpus. That is a reranking wearing a tiebreak's name, and it
 * is what makes a search feel like it is ignoring the words you typed.
 */
export const RECENCY_WEIGHT = 0.05

/** Recency decays to ~1/e over this many days. */
const RECENCY_HALFLIFE_DAYS = 90

/** Target words per meeting chunk. */
export const CHUNK_WORDS = 160

/**
 * Words carried by grammar rather than by meaning, dropped before searching.
 *
 * Question words lead the list because every question starts with one, and in a
 * corpus of a few hundred personal records they match everywhere and rank
 * nothing. The list is deliberately short: aggressive stopword removal is how a
 * search starts ignoring words the user chose on purpose.
 */
const STOPWORDS = new Set([
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
  'get',
  'got',
  'had',
  'has',
  'have',
  'he',
  'her',
  'him',
  'his',
  'how',
  'i',
  'if',
  'in',
  'is',
  'it',
  'its',
  'just',
  'me',
  'my',
  'of',
  'on',
  'or',
  'our',
  'out',
  'said',
  'say',
  'she',
  'should',
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
  'up',
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

/** More terms than this and the tail is noise; the rarest words carry the query. */
const MAX_QUERY_TERMS = 12

/**
 * Turn a *question* into an FTS5 MATCH expression.
 *
 * Deliberately not {@link toFtsQuery}, which the History search box uses. That
 * one joins every term with `AND`, which is right for a search box — you type
 * two or three words and mean all of them — and catastrophic here. "What is
 * blocking the beta launch, and who owns the rollback plan?" becomes a demand
 * for a single record containing *what*, *is*, *blocking*, *the*, *beta*,
 * *launch*, *and*, *who*, *owns*, *rollback* and *plan* at once. Nothing ever
 * matches, retrieval returns empty, and the model — correctly, given what it
 * was handed — says it could not find anything. Ask would have looked broken in
 * a way that pointed at the model rather than at this line.
 *
 * So: stopwords out, `OR` instead of `AND`, and let BM25 do the ranking it is
 * for. A record matching four rare terms outranks one matching a single common
 * term without any of that needing to be spelled out as a boolean.
 *
 * Terms are also **suffix-stripped and prefix-matched**, which is a crude stand
 * in for the stemmer FTS5's `unicode61` tokenizer does not have. Crude, but
 * safe in one specific direction: because a stripped stem is always a prefix of
 * the word the user typed, `block*` matches everything `blocking*` would have
 * matched and adds `blocked` and `blocks` besides. It can only widen the net,
 * never narrow it — which is why it is worth doing without a real stemmer's
 * vocabulary. Without it, asking about "blocking" misses every record that says
 * "blocked", and on a personal corpus that is most of them.
 */
export function toAskQuery(question: string): string | null {
  const terms = question
    .toLowerCase()
    .split(/[^\p{L}\p{N}']+/u)
    .map((term) => term.replace(/^'+|'+$/g, ''))
    .filter((term) => term.length > 1 && !STOPWORDS.has(term))

  // Everything was a stopword — "what did I say?" and nothing else. Fall back to
  // the raw terms rather than returning nothing: a query that finds weak matches
  // is more useful than one that reports the corpus is empty.
  const chosen = (terms.length > 0 ? terms : question.toLowerCase().split(/\s+/))
    .map((term) => term.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter((term) => term.length > 1)
    .slice(0, MAX_QUERY_TERMS)

  if (chosen.length === 0) return null

  const stems = [...new Set(chosen.map(stem))]
  return stems.map((term) => `"${term}"*`).join(' OR ')
}

/**
 * Strip a common English inflection, but only when a real word is left.
 *
 * The three-character floor is what keeps this from turning short words into
 * prefixes that match half the corpus: "ads" would otherwise become `ad*` and
 * pull in *add*, *admin* and *address*, while "using" and "used" would both
 * collapse to `us*`. Three still admits the useful short cases — "owns" to
 * `own*`, "gets" to `get*`. `ss` is excluded from the plural rule so "process"
 * and "address" survive intact.
 */
export function stem(term: string): string {
  const strip = (suffix: string): string | null => {
    if (!term.endsWith(suffix)) return null
    const stripped = term.slice(0, -suffix.length)
    return stripped.length >= 3 ? stripped : null
  }
  if (!term.endsWith('ss')) {
    const plural = strip('ing') ?? strip('ed') ?? strip('es') ?? strip('s')
    if (plural) return plural
  }
  return term
}

export interface TranscriptSegment {
  /** The `mm:ss` stamp the transcript writer emitted. */
  at: string
  speaker: string
  text: string
}

/**
 * Pull the spoken lines out of a meeting transcript.
 *
 * Parses the format `transcript-writer.ts` emits — `- **[mm:ss] You:** text` —
 * and ignores everything else, which means YAML frontmatter, the `#` title, gap
 * markers and the footer are all skipped without needing to be recognised
 * individually. Anything that is not a segment line is not transcript text and
 * has no business being cited as one.
 */
export function parseTranscript(markdown: string): TranscriptSegment[] {
  const segments: TranscriptSegment[] = []
  for (const line of markdown.split('\n')) {
    const match = /^-\s+\*\*\[([\d:]+)\]\s+([^:*]+):\*\*\s*(.+)$/.exec(line.trim())
    if (!match) continue
    const [, at, speaker, text] = match
    if (!at || !speaker || !text) continue
    segments.push({ at, speaker: speaker.trim(), text: text.trim() })
  }
  return segments
}

export interface TranscriptChunk {
  ordinal: number
  text: string
}

/**
 * Group segments into passages of roughly {@link CHUNK_WORDS} words.
 *
 * Speaker labels and timestamps are kept inside the chunk text rather than
 * stripped, because in a meeting *who said it* is usually half the answer, and
 * a passage that reads "we agreed to ship Friday" without saying whether that
 * was you or them is worse than useless.
 *
 * Chunks never split a segment: a boundary mid-sentence produces two passages
 * that are each individually misleading, and the size target is soft enough
 * that respecting the boundary costs nothing.
 */
export function chunkSegments(
  segments: readonly TranscriptSegment[],
  targetWords = CHUNK_WORDS,
): TranscriptChunk[] {
  const chunks: TranscriptChunk[] = []
  let current: string[] = []
  let words = 0

  const flush = (): void => {
    if (current.length === 0) return
    chunks.push({ ordinal: chunks.length, text: current.join('\n') })
    current = []
    words = 0
  }

  for (const segment of segments) {
    const line = `[${segment.at}] ${segment.speaker}: ${segment.text}`
    current.push(line)
    words += segment.text.split(/\s+/).filter(Boolean).length
    if (words >= targetWords) flush()
  }
  flush()

  return chunks
}

/** One index's ranked answer, best first. */
export interface RankedHit {
  id: string
  source: AskSource
  title: string
  text: string
  timestamp: number
}

/**
 * Merge ranked lists from indexes whose scores cannot be compared.
 *
 * BM25 is corpus-relative: it scores a document against the statistics of the
 * index it lives in. A dictation index holding 400 one-sentence rows and a note
 * index holding 40 long ones produce numbers on genuinely different scales, so
 * sorting the union by raw BM25 ranks by *which table you came from* about as
 * much as by relevance. Normalising each list to its own maximum is no better —
 * it forces every source's best hit to exactly 1.0, so a barely-relevant
 * meeting ties the best note in the corpus.
 *
 * Reciprocal rank fusion sidesteps both by throwing the scores away and keeping
 * only the ordering, which *is* comparable. Scaled so a rank-1 hit is 1.0,
 * which makes {@link RECENCY_WEIGHT} legible as a fraction of a perfect match
 * rather than an arbitrary constant.
 */
export function fuseRankings(lists: readonly RankedHit[][], now: number): AskPassage[] {
  const fused: AskPassage[] = []

  for (const list of lists) {
    list.forEach((hit, i) => {
      const rank = i + 1
      const relevance = (RRF_K + 1) / (RRF_K + rank)
      const ageDays = Math.max(0, (now - hit.timestamp) / 86_400_000)
      const recency = Math.exp(-ageDays / RECENCY_HALFLIFE_DAYS)
      fused.push({
        id: hit.id,
        source: hit.source,
        title: hit.title,
        text: hit.text,
        timestamp: hit.timestamp,
        score: relevance + RECENCY_WEIGHT * recency,
      })
    })
  }

  return dedupe(fused).sort((a, b) => b.score - a.score)
}

/**
 * Drop passages whose text repeats one already kept.
 *
 * Real duplication, not a theoretical worry: dictating a thought and then
 * saving it to a note is a normal thing to do in this app, and it puts the same
 * sentences in two indexes. Both would be retrieved, both would occupy the
 * budget, and the answer would cite the same words twice as though two separate
 * records agreed with each other.
 */
function dedupe(passages: readonly AskPassage[]): AskPassage[] {
  const seen = new Map<string, AskPassage>()
  for (const passage of passages) {
    const key = normaliseForDedupe(passage.text)
    const existing = seen.get(key)
    if (!existing || passage.score > existing.score) seen.set(key, passage)
  }
  return [...seen.values()]
}

function normaliseForDedupe(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

interface DictationHitRow {
  id: string
  ts: number
  raw_text: string
  polished_text: string | null
  app_name: string | null
}

interface NoteHitRow {
  id: string
  title: string
  body: string
  updated_at: number
}

interface MeetingHitRow {
  meeting_id: string
  text: string
  title: string
  started_at: number
  ordinal: number
}

const ALL_SOURCES: readonly AskSource[] = ['dictation', 'note', 'meeting']

export interface SearchOptions {
  /** Which indexes to search. Omitted means all of them. */
  sources?: readonly AskSource[] | undefined
  /**
   * Restrict to a period the question named — "what did I say this week".
   *
   * A filter rather than a ranking nudge, because a question that names a
   * period means it: BM25 has no idea what "week" refers to and will happily
   * rank a transcript that merely contains the word above every record actually
   * from the last seven days.
   */
  window?: TimeWindow | undefined
}

/** ` AND col >= ? AND col < ?`, or nothing at all. */
function clause(window: TimeWindow | null, column: string): string {
  return window ? ` AND ${column} >= ? AND ${column} < ?` : ''
}

/** The bounds as positional parameters, matching {@link clause}. */
function bounds(window: TimeWindow | null): number[] {
  return window ? [window.from, window.to] : []
}

export interface RetrievalOptions {
  /** Injected for tests; defaults to the wall clock. */
  now?: () => number
  log?: Logger
}

export class RetrievalRepository {
  readonly #db: Database
  readonly #now: () => number
  readonly #log: Logger

  constructor(db: Database, options: RetrievalOptions = {}) {
    this.#db = db
    this.#now = options.now ?? (() => Date.now())
    this.#log = options.log ?? createLogger('ask:retrieval')
  }

  /**
   * Candidate passages for a question, best first.
   *
   * Returns *candidates*, not a final context: how many actually fit is a
   * budget question that `fitPassages` in `@murmur/shared` owns, and it needs to
   * see more than it will use in order to choose well.
   */
  search(query: string, options: SearchOptions = {}): AskPassage[] {
    const match = toAskQuery(query)
    if (!match) return []

    const wanted = new Set(options.sources ?? ALL_SOURCES)
    const window = options.window ?? null
    const lists: RankedHit[][] = []

    // FTS5 raises on some inputs that survive `toAskQuery` — a query of only
    // stopword-ish punctuation, a column filter the tokenizer rejects. An empty
    // result is the right answer for a search box; a crash is not.
    try {
      if (wanted.has('dictation')) lists.push(this.#searchDictations(match, window))
      if (wanted.has('note')) lists.push(this.#searchNotes(match, window))
      if (wanted.has('meeting')) lists.push(this.#searchMeetings(match, window))
    } catch (error) {
      this.#log.warn(`search failed for ${JSON.stringify(query)}: ${String(error)}`)
      return []
    }

    const fused = fuseRankings(lists, this.#now())

    // A window that finds nothing is worse than no window: "what did I say
    // about the offsite this week" would report the corpus empty when the
    // answer is sitting there from nine days ago. Falling back keeps the
    // question answerable, and every passage carries its own date, so a source
    // from outside the window is visible rather than quietly misattributed.
    if (window && fused.length === 0) {
      this.#log.info(`no matches inside ${window.label}; widening to the whole history`)
      return this.search(query, { ...options, window: undefined })
    }

    return fused
  }

  #searchDictations(match: string, window: TimeWindow | null): RankedHit[] {
    const rows = this.#db
      .prepare(
        `SELECT d.id, d.ts, d.raw_text, d.polished_text, d.app_name
           FROM dictations d
           JOIN dictations_fts f ON f.rowid = d.rowid
          WHERE dictations_fts MATCH ?${clause(window, 'd.ts')}
          ORDER BY bm25(dictations_fts) ASC
          LIMIT ?`,
      )
      .all(match, ...bounds(window), PER_SOURCE_LIMIT) as DictationHitRow[]

    return rows.map((row) => ({
      id: row.id,
      source: 'dictation' as const,
      // The app it was dictated into is the only handle a transcript has —
      // without it every dictation citation would read "dictation", and a strip
      // of eight identical chips tells the user nothing about which to open.
      title: row.app_name ? `dictated in ${row.app_name}` : 'dictation',
      // Polished text where it exists: it is what was actually inserted, and
      // what the user would recognise as the thing they said.
      text: row.polished_text?.trim() || row.raw_text,
      timestamp: row.ts,
    }))
  }

  #searchNotes(match: string, window: TimeWindow | null): RankedHit[] {
    const rows = this.#db
      .prepare(
        `SELECT n.id, n.title, n.body, n.updated_at
           FROM notes n
           JOIN notes_fts f ON f.rowid = n.rowid
          WHERE notes_fts MATCH ?${clause(window, 'n.updated_at')}
          ORDER BY bm25(notes_fts) ASC
          LIMIT ?`,
      )
      .all(match, ...bounds(window), PER_SOURCE_LIMIT) as NoteHitRow[]

    return rows.map((row) => ({
      id: row.id,
      source: 'note' as const,
      title: row.title.trim() || firstLine(row.body),
      text: row.body,
      timestamp: row.updated_at,
    }))
  }

  #searchMeetings(match: string, window: TimeWindow | null): RankedHit[] {
    const rows = this.#db
      .prepare(
        `SELECT c.meeting_id, c.text, c.ordinal, m.title, m.started_at
           FROM meeting_chunks c
           JOIN meeting_chunks_fts f ON f.rowid = c.id
           JOIN meetings m ON m.id = c.meeting_id
          WHERE meeting_chunks_fts MATCH ?${clause(window, 'm.started_at')}
          ORDER BY bm25(meeting_chunks_fts) ASC
          LIMIT ?`,
      )
      .all(match, ...bounds(window), PER_SOURCE_LIMIT) as MeetingHitRow[]

    return rows.map((row) => ({
      // Chunk-qualified: two passages from the same meeting are two distinct
      // citations, and collapsing them onto the meeting id would make the
      // second one silently replace the first in any id-keyed map.
      id: `${row.meeting_id}#${row.ordinal}`,
      source: 'meeting' as const,
      title: row.title,
      text: row.text,
      timestamp: row.started_at,
    }))
  }

  // -- meeting index ---------------------------------------------------------

  /**
   * Bring the meeting index up to date with the files on disk.
   *
   * Cheap to call: one `stat` per meeting, and work only where size or mtime
   * moved. That is what lets this run before every search instead of needing a
   * schedule, a watcher, or a hook in the recorder's hot path — and it means a
   * transcript the user edited by hand in their own editor gets picked up, which
   * a recorder hook would have missed.
   */
  syncMeetings(): { indexed: number; removed: number } {
    const meetings = this.#db.prepare(`SELECT id, path FROM meetings`).all() as {
      id: string
      path: string
    }[]

    const marks = new Map(
      (
        this.#db.prepare(`SELECT meeting_id, file_size, file_mtime FROM meeting_index`).all() as {
          meeting_id: string
          file_size: number
          file_mtime: number
        }[]
      ).map((row) => [row.meeting_id, row]),
    )

    let indexed = 0
    let removed = 0

    for (const meeting of meetings) {
      let size: number
      let mtime: number
      try {
        const stats = statSync(meeting.path)
        size = stats.size
        mtime = Math.floor(stats.mtimeMs)
      } catch {
        // The transcript was moved, deleted, or sits on a volume that is not
        // mounted. Drop the stale chunks rather than serving passages from a
        // file the user can no longer open from the citation.
        if (marks.has(meeting.id)) {
          this.#clearMeeting(meeting.id)
          removed += 1
        }
        continue
      }

      const mark = marks.get(meeting.id)
      if (mark && mark.file_size === size && mark.file_mtime === mtime) continue

      try {
        this.#indexMeeting(meeting.id, meeting.path, size, mtime)
        indexed += 1
      } catch (error) {
        this.#log.warn(`could not index ${meeting.path}: ${String(error)}`)
      }
    }

    return { indexed, removed }
  }

  #indexMeeting(id: string, path: string, size: number, mtime: number): void {
    const markdown = readFileSync(path, 'utf8')
    const chunks = chunkSegments(parseTranscript(markdown))

    const write = this.#db.transaction(() => {
      this.#db.prepare(`DELETE FROM meeting_chunks WHERE meeting_id = ?`).run(id)
      const insert = this.#db.prepare(
        `INSERT INTO meeting_chunks (meeting_id, ordinal, text) VALUES (?, ?, ?)`,
      )
      for (const chunk of chunks) insert.run(id, chunk.ordinal, chunk.text)
      this.#db
        .prepare(
          `INSERT INTO meeting_index (meeting_id, indexed_at, file_size, file_mtime)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(meeting_id) DO UPDATE SET
             indexed_at = excluded.indexed_at,
             file_size  = excluded.file_size,
             file_mtime = excluded.file_mtime`,
        )
        .run(id, this.#now(), size, mtime)
    })
    write()
  }

  #clearMeeting(id: string): void {
    const clear = this.#db.transaction(() => {
      this.#db.prepare(`DELETE FROM meeting_chunks WHERE meeting_id = ?`).run(id)
      this.#db.prepare(`DELETE FROM meeting_index WHERE meeting_id = ?`).run(id)
    })
    clear()
  }

  /** How much there is to search, for the empty state's "N dictations" line. */
  counts(): { dictations: number; notes: number; meetings: number } {
    const one = (sql: string): number => (this.#db.prepare(sql).get() as { n: number }).n
    return {
      dictations: one(`SELECT COUNT(*) AS n FROM dictations`),
      notes: one(`SELECT COUNT(*) AS n FROM notes`),
      meetings: one(`SELECT COUNT(*) AS n FROM meetings`),
    }
  }
}

function firstLine(body: string): string {
  const line = body
    .split('\n')
    .map((l) => l.replace(/^#{1,6}\s+/, '').trim())
    .find((l) => l.length > 0)
  return line ? line.slice(0, 60) : 'untitled note'
}
