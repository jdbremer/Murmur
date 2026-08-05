import { useCallback, useEffect, useRef, useState } from 'react'

import type { DictationRecord, HistoryStats } from '@murmur/shared'

import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorCard,
  Section,
  Stat,
  TextInput,
} from '../../components/Section'
import { formatDuration, formatNumber, formatTimestamp } from '../../format'

/**
 * Home / History (PLAN §2.2.1).
 *
 * Search goes through the store's FTS5 index rather than filtering in the
 * renderer: the whole point of keeping history in SQLite is that a year of
 * dictations stays searchable without shipping all of it across IPC.
 *
 * Every row is the user's own text, so it is selectable, copyable and
 * individually deletable — history you cannot delete a single row from is a
 * liability rather than a feature (PLAN §10.4).
 */

const PAGE_SIZE = 25

export function HomeSection(): React.JSX.Element {
  const [stats, setStats] = useState<HistoryStats | null>(null)
  const [records, setRecords] = useState<DictationRecord[] | null>(null)
  const [total, setTotal] = useState(0)
  const [search, setSearch] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)

  const active = useRef(true)
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
    }
  }, [])

  const load = useCallback(async (query: string, limit: number): Promise<void> => {
    try {
      const [nextStats, page] = await Promise.all([
        window.murmur.history.stats(),
        window.murmur.history.query({ search: query, limit, offset: 0 }),
      ])
      if (!active.current) return
      setStats(nextStats)
      setRecords(page.records)
      setTotal(page.total)
      setError(null)
    } catch (cause) {
      if (!active.current) return
      setError(cause instanceof Error ? cause.message : String(cause))
      setRecords([])
    }
  }, [])

  // Debounced so typing does not fire one FTS query per keystroke.
  useEffect(() => {
    const timer = setTimeout(
      () => {
        void load(search, PAGE_SIZE)
      },
      search ? 180 : 0,
    )
    return () => clearTimeout(timer)
  }, [search, load])

  const remove = async (id: string): Promise<void> => {
    await window.murmur.history.remove({ id })
    await load(search, records?.length ?? PAGE_SIZE)
  }

  const clear = async (): Promise<void> => {
    await window.murmur.history.clear()
    await load('', PAGE_SIZE)
    setSearch('')
  }

  const copy = async (record: DictationRecord): Promise<void> => {
    await navigator.clipboard.writeText(record.polishedText ?? record.rawText)
    setCopiedId(record.id)
    setTimeout(() => setCopiedId(null), 1_200)
  }

  return (
    <Section title="Home" description="Everything you have dictated, newest first.">
      {error ? <ErrorCard>{error}</ErrorCard> : null}

      <Card className="mb-5">
        <div className="grid grid-cols-3 gap-6">
          <Stat label="Words dictated" value={formatNumber(stats?.totalWords)} />
          <Stat label="Average WPM" value={formatNumber(stats?.avgWpm)} />
          <Stat label="Day streak" value={formatNumber(stats?.streakDays)} />
        </div>
      </Card>

      <div className="mb-4 flex items-center gap-2">
        <div className="flex-1">
          <TextInput
            value={search}
            onChange={setSearch}
            ariaLabel="Search history"
            placeholder="Search your dictations…"
          />
        </div>
        {records && records.length > 0 ? (
          <Button onClick={() => void clear()} variant="danger">
            Clear all
          </Button>
        ) : null}
      </div>

      {records === null ? (
        <EmptyState>Loading…</EmptyState>
      ) : records.length === 0 ? (
        <EmptyState>
          {search
            ? `Nothing matches “${search}”.`
            : 'No dictations yet. Hold your dictation key and speak — what you say will show up here.'}
        </EmptyState>
      ) : (
        <>
          <ul className="space-y-2">
            {records.map((record) => (
              <li key={record.id}>
                <HistoryRow
                  record={record}
                  copied={copiedId === record.id}
                  onCopy={() => void copy(record)}
                  onDelete={() => void remove(record.id)}
                />
              </li>
            ))}
          </ul>

          {records.length < total ? (
            <div className="mt-4 flex justify-center">
              <Button onClick={() => void load(search, records.length + PAGE_SIZE)}>
                Show more ({total - records.length} older)
              </Button>
            </div>
          ) : null}
        </>
      )}
    </Section>
  )
}

function HistoryRow({
  record,
  copied,
  onCopy,
  onDelete,
}: {
  record: DictationRecord
  copied: boolean
  onCopy: () => void
  onDelete: () => void
}): React.JSX.Element {
  const text = record.polishedText ?? record.rawText

  return (
    <Card>
      <div className="flex items-start justify-between gap-4">
        <p className="min-w-0 select-text whitespace-pre-wrap text-[13px] leading-relaxed text-ink">
          {text}
        </p>
        <div className="flex shrink-0 items-center gap-2">
          <Button onClick={onCopy}>{copied ? 'Copied' : 'Copy'}</Button>
          <Button onClick={onDelete} variant="danger">
            Delete
          </Button>
        </div>
      </div>

      <div className="mt-2.5 flex flex-wrap items-center gap-2 text-[12px] text-ink-faint">
        <span>{formatTimestamp(record.ts)}</span>
        <span aria-hidden>·</span>
        <span>{formatDuration(record.durationMs)} spoken</span>
        <span aria-hidden>·</span>
        <span>{formatDuration(record.timings.totalMs)} to insert</span>
        {/* A row with no polished text means the raw transcript was inserted —
            either polishing was off, or the hallucination guard rejected the
            model's output (PLAN §7.4). Worth surfacing rather than hiding. */}
        {record.polishedText === null ? <Badge tone="neutral">Raw</Badge> : null}
        {record.appBundleId ? <Badge tone="neutral">{record.appCategory}</Badge> : null}
      </div>
    </Card>
  )
}
