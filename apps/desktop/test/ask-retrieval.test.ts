import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Database } from 'better-sqlite3'

import { createNullLogger } from '../src/main/logging'
import { databasePath, openDatabase } from '../src/main/store/db'
import {
  DictationsRepository,
  MeetingsRepository,
  NotesRepository,
} from '../src/main/store/repositories'
import {
  CHUNK_WORDS,
  RECENCY_WEIGHT,
  RRF_K,
  RetrievalRepository,
  chunkSegments,
  fuseRankings,
  parseTranscript,
  stem,
  toAskQuery,
  type RankedHit,
} from '../src/main/store/retrieval'

/**
 * Retrieval for Ask (PLAN §2.2.9).
 *
 * Two things are worth testing hard here. The first is rank fusion, because the
 * naive alternatives are subtly wrong in ways that look fine in a demo: sorting
 * three indexes by raw BM25 ranks by which table a row came from, and
 * per-source normalisation forces every source's best hit to tie.
 *
 * The second is the meeting index, which is a *cache* of files the user owns
 * and can edit outside Murmur. Everything about it — staleness, deletion, hand
 * edits — has to be checked against real files on disk.
 */

const DAY = 86_400_000
const NOW = 1_700_000_000_000
const log = createNullLogger()

let directory: string
let db: Database
let dictations: DictationsRepository
let notes: NotesRepository
let meetings: MeetingsRepository
let retrieval: RetrievalRepository

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'murmur-ask-'))
  db = openDatabase(databasePath(directory), { log }).db
  dictations = new DictationsRepository(db)
  notes = new NotesRepository(db)
  meetings = new MeetingsRepository(db)
  retrieval = new RetrievalRepository(db, { now: () => NOW, log })
})

afterEach(() => {
  try {
    db.close()
  } catch {
    /* already closed */
  }
  rmSync(directory, { recursive: true, force: true })
})

function addDictation(text: string, over: { ts?: number; polished?: string | null } = {}): string {
  return dictations.insert({
    ts: over.ts ?? NOW - DAY,
    rawText: text,
    polishedText: over.polished === undefined ? null : over.polished,
    appBundleId: 'com.tinyspeck.slackmacgap',
    appName: 'Slack',
    appCategory: 'work',
    durationMs: 1000,
    sttModelId: 'whisper-small',
    polishModelId: null,
    timings: { sttMs: 200, polishMs: 0, totalMs: 400 },
  }).id
}

/**
 * A note with a timestamp we control.
 *
 * `notes.create` stamps `updated_at` from the real clock, which is years away
 * from the `NOW` fixture — so a window built around `NOW` would exclude every
 * note and quietly test the widening fallback instead of the filter.
 */
function addNote(title: string, body: string, updatedAt = NOW - DAY): string {
  const note = notes.create({ title, body })
  db.prepare(`UPDATE notes SET updated_at = ? WHERE id = ?`).run(updatedAt, note.id)
  return note.id
}

function writeTranscript(name: string, body: string, startedAt = NOW - DAY): string {
  const path = join(directory, name)
  writeFileSync(path, body, 'utf8')
  meetings.save({
    id: name,
    startedAt,
    endedAt: startedAt + 600_000,
    title: name.replace(/\.md$/, ''),
    path,
    appBundleId: null,
    hadSystemAudio: false,
    segmentCount: 2,
    durationMs: 600_000,
  })
  return path
}

const TRANSCRIPT = `---
title: Q3 planning
date: 2026-03-12
---

# Q3 planning

- **[00:04] You:** We should move the migration to Thursday.
- **[00:11] Them:** Thursday works, but the rollback plan needs signing off.
- **[00:20] You:** I will write the rollback plan tonight.

> [Transcription unavailable — 01:00 to 01:30]

---

Ended 3:04:05 PM · 10:00 · 3 segments
`

describe('toAskQuery', () => {
  it('ORs the terms instead of ANDing them', () => {
    // The bug that made Ask look broken end to end. History's search box ANDs,
    // which is right when you type two words and mean both; applied to a
    // sentence it demands one record containing every word of the question, so
    // nothing ever matches and the model truthfully reports it found nothing.
    const query = toAskQuery('What is blocking the beta launch?') ?? ''
    expect(query).toContain(' OR ')
    expect(query).not.toContain(' AND ')
  })

  it('drops the grammar and keeps the content words', () => {
    const query = toAskQuery('What is blocking the beta launch, and who owns the rollback plan?')
    expect(query).toMatch(/block/)
    expect(query).toMatch(/beta/)
    expect(query).toMatch(/launch/)
    expect(query).toMatch(/rollback/)
    expect(query).not.toMatch(/"what"/)
    expect(query).not.toMatch(/"the"/)
    expect(query).not.toMatch(/"who"/)
  })

  it('quotes every term, so punctuation cannot become FTS5 syntax', () => {
    // `"`, `*`, `:`, `^`, `-`, `(`, `)` and NEAR are all operators. An
    // unescaped question is a crash, and questions are full of punctuation.
    for (const question of [
      'what about "the thing" (again)?',
      'NEAR( is a function -- right?',
      "who's on-call?",
      'what about ^this: 50% of it*',
    ]) {
      const query = toAskQuery(question) ?? ''
      for (const term of query.split(' OR ')) expect(term).toMatch(/^"[^"]+"\*$/)
    }
  })

  it('falls back to the raw words when the question is all grammar', () => {
    // "what did I say?" should find weak matches, not report an empty corpus.
    expect(toAskQuery('what did I say?')).toBeTruthy()
  })

  it('returns null only when there is genuinely nothing to search for', () => {
    expect(toAskQuery('')).toBeNull()
    expect(toAskQuery('   ')).toBeNull()
    expect(toAskQuery('?!  ...')).toBeNull()
  })

  it('caps a rambling question rather than sending fifty terms', () => {
    const query = toAskQuery(
      'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar',
    )
    expect((query ?? '').split(' OR ')).toHaveLength(12)
  })

  it('does not repeat a term the question used twice', () => {
    const query = toAskQuery('migration migration migrations') ?? ''
    expect(query.split(' OR ')).toHaveLength(1)
  })
})

describe('stem', () => {
  it('strips inflections so a question about "blocking" finds "blocked"', () => {
    expect(stem('blocking')).toBe('block')
    expect(stem('blocked')).toBe('block')
    expect(stem('blocks')).toBe('block')
    expect(stem('owns')).toBe('own')
  })

  it('only ever produces a prefix of the original word', () => {
    // The property that makes a hand-rolled stemmer safe here: the result is
    // always a prefix, so prefix-matching it can only widen the net, never
    // narrow it. No word the user typed can stop matching itself.
    for (const word of ['blocking', 'migrations', 'matches', 'process', 'address', 'plan', 'is']) {
      expect(word.startsWith(stem(word))).toBe(true)
    }
  })

  it('leaves short words alone rather than shrinking them to noise', () => {
    // `ad*` would pull in add, admin and address; `us*` would match half the
    // corpus. Both are worse than not stemming at all.
    expect(stem('is')).toBe('is')
    expect(stem('ads')).toBe('ads')
    expect(stem('used')).toBe('used')
    expect(stem('using')).toBe('using')
  })

  it('does not mistake a double-s ending for a plural', () => {
    expect(stem('process')).toBe('process')
    expect(stem('address')).toBe('address')
  })
})

describe('parseTranscript', () => {
  it('reads the segment lines the transcript writer emits', () => {
    const segments = parseTranscript(TRANSCRIPT)
    expect(segments).toHaveLength(3)
    expect(segments[0]).toEqual({
      at: '00:04',
      speaker: 'You',
      text: 'We should move the migration to Thursday.',
    })
    expect(segments[1]?.speaker).toBe('Them')
  })

  it('ignores frontmatter, headings, gap markers and the footer', () => {
    // Anything that is not a segment line is not transcript text and must never
    // be citable as though the user said it.
    const joined = parseTranscript(TRANSCRIPT)
      .map((s) => s.text)
      .join(' ')
    expect(joined).not.toContain('Transcription unavailable')
    expect(joined).not.toContain('Q3 planning')
    expect(joined).not.toContain('Ended')
  })

  it('handles an hour-long stamp and an empty file', () => {
    expect(parseTranscript('- **[1:02:03] You:** still here\n')[0]?.at).toBe('1:02:03')
    expect(parseTranscript('')).toEqual([])
  })
})

describe('chunkSegments', () => {
  it('keeps who said it inside the passage', () => {
    // In a meeting, *who* said it is usually half the answer. A passage reading
    // "we agreed to ship Friday" with no speaker is worse than useless.
    const [chunk] = chunkSegments(parseTranscript(TRANSCRIPT))
    expect(chunk?.text).toContain('You:')
    expect(chunk?.text).toContain('Them:')
    expect(chunk?.text).toContain('[00:04]')
  })

  it('never splits a segment across two chunks', () => {
    const segments = Array.from({ length: 40 }, (_, i) => ({
      at: `00:${String(i).padStart(2, '0')}`,
      speaker: 'You',
      text: `sentence ${i} ${'word '.repeat(20)}`,
    }))
    const chunks = chunkSegments(segments)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      for (const line of chunk.text.split('\n')) expect(line).toMatch(/^\[\d/)
    }
  })

  it('numbers chunks from zero, contiguously', () => {
    const segments = Array.from({ length: 30 }, () => ({
      at: '00:01',
      speaker: 'You',
      text: 'word '.repeat(CHUNK_WORDS),
    }))
    const chunks = chunkSegments(segments)
    expect(chunks.map((c) => c.ordinal)).toEqual(chunks.map((_, i) => i))
  })

  it('produces nothing for a transcript with no speech', () => {
    expect(chunkSegments([])).toEqual([])
  })
})

describe('fuseRankings', () => {
  function hit(over: Partial<RankedHit> = {}): RankedHit {
    return {
      id: over.id ?? 'x',
      source: over.source ?? 'dictation',
      title: over.title ?? 't',
      text: over.text ?? 'some text',
      timestamp: over.timestamp ?? NOW,
      score: 0,
      ...over,
    } as RankedHit
  }

  it('scores a rank-one hit at one, before recency', () => {
    const [first] = fuseRankings([[hit({ timestamp: 0 })]], NOW)
    expect(first?.score).toBeCloseTo(1, 5)
  })

  it('interleaves two indexes by rank rather than by table', () => {
    // Sorting the union by raw BM25 would group by source, because the scores
    // are corpus-relative and the two corpora are different sizes. Fusion has
    // to put a note's rank-1 hit above a dictation's rank-2 hit.
    const dictationList = [
      hit({ id: 'd1', text: 'alpha' }),
      hit({ id: 'd2', text: 'beta' }),
      hit({ id: 'd3', text: 'gamma' }),
    ]
    const noteList = [hit({ id: 'n1', source: 'note', text: 'delta' })]
    const ids = fuseRankings([dictationList, noteList], NOW).map((p) => p.id)
    expect(ids.indexOf('n1')).toBeLessThan(ids.indexOf('d2'))
  })

  it('scores a fresh passage above an identical stale one', () => {
    const old = fuseRankings([[hit({ id: 'old', text: 'a', timestamp: NOW - 365 * DAY })]], NOW)[0]
    const fresh = fuseRankings([[hit({ id: 'new', text: 'b', timestamp: NOW })]], NOW)[0]
    expect(fresh?.score).toBeGreaterThan(old?.score ?? 0)
    expect((fresh?.score ?? 0) - (old?.score ?? 0)).toBeLessThanOrEqual(RECENCY_WEIGHT + 1e-9)
  })

  it('lets recency lift a passage exactly three places, and no further', () => {
    // Pins the documented span. Widening `RECENCY_WEIGHT` without revisiting
    // it is how a tiebreak quietly becomes a reranking: at 0.15 the reach is
    // twelve places, enough for today's also-ran to bury the best match there
    // is.
    const stale = (rank: number): number => {
      const list = Array.from({ length: rank }, (_, i) =>
        hit({ id: `s${i}`, text: `s${i}`, timestamp: NOW - 400 * DAY }),
      )
      return fuseRankings([list], NOW).at(-1)?.score ?? 0
    }
    const freshAtRank = (rank: number): number => {
      const list = Array.from({ length: rank }, (_, i) =>
        hit({ id: `f${i}`, text: `f${i}`, timestamp: NOW }),
      )
      return fuseRankings([list], NOW).at(-1)?.score ?? 0
    }
    expect(freshAtRank(4)).toBeGreaterThan(stale(1))
    expect(freshAtRank(5)).toBeLessThan(stale(1))
  })

  it('collapses the same text found in two indexes', () => {
    // Dictating a thought and saving it as a note is normal in this app, and it
    // puts the same sentences in two indexes. Both would occupy the budget and
    // the answer would cite one idea twice as though two records agreed.
    const text = 'The migration moves to Thursday.'
    const fused = fuseRankings(
      [[hit({ id: 'd1', text })], [hit({ id: 'n1', source: 'note', text })]],
      NOW,
    )
    expect(fused).toHaveLength(1)
  })

  it('keeps the better-scoring copy when it deduplicates', () => {
    const text = 'same words'
    const fused = fuseRankings(
      [
        [hit({ id: 'worse' }), hit({ id: 'worse2' }), hit({ id: 'd', text })],
        [hit({ id: 'n', source: 'note', text })],
      ],
      NOW,
    )
    expect(fused.find((p) => p.text === text)?.id).toBe('n')
  })

  it('ignores punctuation and case when deduplicating', () => {
    const fused = fuseRankings(
      [
        [hit({ id: 'a', text: 'Ship it on Friday!' })],
        [hit({ id: 'b', source: 'note', text: 'ship it on friday' })],
      ],
      NOW,
    )
    expect(fused).toHaveLength(1)
  })

  it('returns nothing for empty input', () => {
    expect(fuseRankings([], NOW)).toEqual([])
    expect(fuseRankings([[], []], NOW)).toEqual([])
  })

  it('uses the conventional RRF constant', () => {
    expect(RRF_K).toBe(60)
  })
})

describe('RetrievalRepository', () => {
  it('finds a dictation, a note and a meeting in one search', () => {
    addDictation('The migration is blocked on the schema change.')
    notes.create({ title: 'Migration plan', body: 'Roll the migration forward on Thursday.' })
    writeTranscript('standup.md', TRANSCRIPT)
    retrieval.syncMeetings()

    const sources = new Set(retrieval.search('migration').map((p) => p.source))
    expect(sources).toEqual(new Set(['dictation', 'note', 'meeting']))
  })

  it('prefers the polished text, which is what was actually inserted', () => {
    addDictation('um the deploy is uh blocked', { polished: 'The deploy is blocked.' })
    const [passage] = retrieval.search('deploy')
    expect(passage?.text).toBe('The deploy is blocked.')
  })

  it('falls back to the raw text when nothing was polished', () => {
    addDictation('the deploy is blocked', { polished: null })
    expect(retrieval.search('deploy')[0]?.text).toBe('the deploy is blocked')
  })

  it('titles a dictation by the app it was spoken into', () => {
    // Without it every dictation chip reads "dictation", and a strip of eight
    // identical chips tells the user nothing about which one to open.
    addDictation('shipping notes')
    expect(retrieval.search('shipping')[0]?.title).toBe('dictated in Slack')
  })

  it('can be limited to one kind of source', () => {
    addDictation('budget for the offsite')
    notes.create({ title: 'Offsite', body: 'budget for the offsite' })
    const results = retrieval.search('offsite', { sources: ['note'] })
    expect(results.every((p) => p.source === 'note')).toBe(true)
  })

  it('returns nothing rather than throwing on a query FTS5 cannot parse', () => {
    // An unescaped search box is a crash in FTS5. An empty result is the right
    // answer for a search box; a stack trace is not.
    addDictation('anything at all')
    expect(retrieval.search('"')).toEqual([])
    expect(retrieval.search('   ')).toEqual([])
    expect(retrieval.search('NEAR(')).toEqual([])
    expect(retrieval.search('*')).toEqual([])
  })

  it('gives every meeting chunk its own citable id', () => {
    // Collapsing chunks onto the meeting id would let the second silently
    // replace the first in any id-keyed map.
    const long = Array.from(
      { length: 30 },
      (_, i) => `- **[00:${String(i).padStart(2, '0')}] You:** rollback ${'word '.repeat(30)}`,
    ).join('\n')
    writeTranscript('long.md', long)
    retrieval.syncMeetings()

    const ids = retrieval.search('rollback').map((p) => p.id)
    expect(ids.length).toBeGreaterThan(1)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.every((id) => id.startsWith('long.md#'))).toBe(true)
  })

  describe('meeting index', () => {
    it('indexes on first sync and does no work on the second', () => {
      writeTranscript('a.md', TRANSCRIPT)
      expect(retrieval.syncMeetings()).toEqual({ indexed: 1, removed: 0 })
      expect(retrieval.syncMeetings()).toEqual({ indexed: 0, removed: 0 })
    })

    it('picks up a transcript the user edited outside Murmur', () => {
      // The reason this is a disk scan rather than a hook in the recorder: the
      // Markdown is the user's file and they can edit it in their own editor.
      const path = writeTranscript('b.md', TRANSCRIPT)
      retrieval.syncMeetings()
      expect(retrieval.search('pineapple')).toEqual([])

      writeFileSync(path, `${TRANSCRIPT}- **[02:00] You:** and pineapple on Friday.\n`, 'utf8')
      expect(retrieval.syncMeetings().indexed).toBe(1)
      expect(retrieval.search('pineapple')).toHaveLength(1)
    })

    it('re-indexes an edit that left the file the same size', () => {
      // A same-length edit is exactly what a typo fix looks like. Size alone
      // would miss it; mtime is why both are stored.
      const path = writeTranscript('c.md', TRANSCRIPT)
      retrieval.syncMeetings()

      writeFileSync(path, TRANSCRIPT.replace('Thursday.', 'Tuesday..'), 'utf8')
      const future = new Date(Date.now() + 60_000)
      utimesSync(path, future, future)

      expect(retrieval.syncMeetings().indexed).toBe(1)
      expect(retrieval.search('Tuesday')).toHaveLength(1)
    })

    it('drops the chunks when the transcript is no longer on disk', () => {
      // Serving a passage whose citation cannot be opened is worse than not
      // finding it at all.
      const path = writeTranscript('d.md', TRANSCRIPT)
      retrieval.syncMeetings()
      expect(retrieval.search('rollback').length).toBeGreaterThan(0)

      rmSync(path)
      expect(retrieval.syncMeetings()).toEqual({ indexed: 0, removed: 1 })
      expect(retrieval.search('rollback')).toEqual([])
    })

    it('leaves the index alone when a transcript is simply unreachable', () => {
      const path = writeTranscript('e.md', TRANSCRIPT)
      retrieval.syncMeetings()
      rmSync(path)
      retrieval.syncMeetings()
      // Already cleared; a second pass must not keep reporting removals.
      expect(retrieval.syncMeetings()).toEqual({ indexed: 0, removed: 0 })
    })

    it('cascades chunks away when the meeting row is deleted', () => {
      writeTranscript('f.md', TRANSCRIPT)
      retrieval.syncMeetings()
      db.prepare(`DELETE FROM meetings WHERE id = 'f.md'`).run()
      expect(retrieval.search('rollback')).toEqual([])
      expect(
        (db.prepare(`SELECT COUNT(*) AS n FROM meeting_chunks`).get() as { n: number }).n,
      ).toBe(0)
    })

    it('leaves the full-text index consistent after a re-index', () => {
      // The FTS index is external-content: if the delete trigger were missing,
      // re-indexing would leave rows pointing at chunk text that no longer
      // exists, and searches would return passages that cannot be rendered.
      const path = writeTranscript('g.md', TRANSCRIPT)
      retrieval.syncMeetings()
      writeFileSync(path, '- **[00:01] You:** completely different words now.\n', 'utf8')
      retrieval.syncMeetings()

      expect(retrieval.search('rollback')).toEqual([])
      expect(retrieval.search('completely')).toHaveLength(1)
      expect(() =>
        db
          .prepare(`INSERT INTO meeting_chunks_fts(meeting_chunks_fts) VALUES('integrity-check')`)
          .run(),
      ).not.toThrow()
    })
  })

  describe('time windows', () => {
    const week = { from: NOW - 7 * DAY, to: NOW + DAY, label: 'this week' }

    it('keeps only what falls inside the window', () => {
      addDictation('offsite venue booking', { ts: NOW - 2 * DAY })
      addDictation('offsite venue catering', { ts: NOW - 40 * DAY })

      const found = retrieval.search('offsite venue', { window: week })
      expect(found).toHaveLength(1)
      expect(found[0]?.text).toContain('booking')
    })

    it('applies the window to notes and meetings alike', () => {
      addNote('Offsite', 'offsite venue shortlist', NOW - 2 * DAY)
      writeTranscript('old.md', '- **[00:01] You:** offsite venue ideas\n', NOW - 90 * DAY)
      retrieval.syncMeetings()

      const sources = new Set(
        retrieval.search('offsite venue', { window: week }).map((p) => p.source),
      )
      expect(sources.has('note')).toBe(true)
      expect(sources.has('meeting')).toBe(false)
    })

    it('widens to the whole history rather than reporting nothing', () => {
      // "What did I say about the offsite this week" must not claim the archive
      // is empty when the answer is sitting there from nine days ago.
      addDictation('offsite venue booking', { ts: NOW - 40 * DAY })
      expect(retrieval.search('offsite venue', { window: week })).toHaveLength(1)
    })

    it('does not widen when the window itself had matches', () => {
      addDictation('offsite venue booking', { ts: NOW - 2 * DAY })
      addDictation('offsite venue catering', { ts: NOW - 40 * DAY })
      expect(retrieval.search('offsite venue', { window: week })).toHaveLength(1)
    })

    it('treats the window as half-open, so adjacent windows cannot both match', () => {
      // A second record inside the window keeps the result non-empty, so this
      // tests the boundary rather than the widening fallback — which would
      // otherwise find the excluded record anyway and hide the bug.
      addDictation('boundary case exact', { ts: NOW - 7 * DAY })
      addDictation('boundary case earlier', { ts: NOW - 10 * DAY })

      const earlier = { from: NOW - 14 * DAY, to: NOW - 7 * DAY, label: 'last week' }
      const found = retrieval.search('boundary case', { window: earlier })
      expect(found).toHaveLength(1)
      expect(found[0]?.text).toContain('earlier')

      // And the excluded one belongs to the window that starts where it ended.
      const later = { from: NOW - 7 * DAY, to: NOW, label: 'this week' }
      expect(retrieval.search('boundary case', { window: later })[0]?.text).toContain('exact')
    })
  })

  it('counts what there is to search', () => {
    addDictation('one')
    notes.create({ title: 'n', body: 'b' })
    writeTranscript('h.md', TRANSCRIPT)
    expect(retrieval.counts()).toEqual({ dictations: 1, notes: 1, meetings: 1 })
  })
})
