import { useCallback, useEffect, useRef, useState } from 'react'

import type { DictationRecord, HistoryStats } from '@murmur/shared'

import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorCard,
  LoadingState,
  Section,
  TextInput,
} from '../../components/Section'
import { formatClock, formatNumber, groupByDay } from '../../format'

/**
 * History (PLAN §2.2.1), in the reference product's shape: dictations grouped
 * under date headers (Today · Yesterday · real dates), each row with the
 * wall-clock time in a left gutter and its actions surfacing on hover, plus a
 * compact stats rail on the right with the headline numbers in serif — the
 * same three figures Insights explores in depth.
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

export function HistorySection(): React.JSX.Element {
  const [records, setRecords] = useState<DictationRecord[] | null>(null)
  const [stats, setStats] = useState<HistoryStats | null>(null)
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
      const page = await window.murmur.history.query({ search: query, limit, offset: 0 })
      if (!active.current) return
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

  // The stats rail: read once, then keep in step from the same broadcast that
  // refreshes the list — its payload *is* the new totals.
  useEffect(() => {
    void window.murmur.history
      .stats()
      .then((value) => {
        if (active.current) setStats(value)
      })
      .catch(() => undefined)
  }, [])

  // Live updates while the Hub sits open (PLAN §2.2.1). The list needs a
  // query, because only the store knows where the new row sorts under the
  // current search. Read through a ref so the subscription is set up once
  // rather than being torn down on every keystroke.
  const latest = useRef({ search, count: PAGE_SIZE })
  useEffect(() => {
    latest.current = { search, count: records?.length ?? PAGE_SIZE }
  }, [search, records])

  useEffect(() => {
    return window.murmur.history.subscribe((nextStats) => {
      if (!active.current) return
      setStats(nextStats)
      void load(latest.current.search, latest.current.count)
    })
  }, [load])

  const remove = async (id: string): Promise<void> => {
    await window.murmur.history.remove({ id })
    await load(search, records?.length ?? PAGE_SIZE)
  }

  const clear = async (): Promise<void> => {
    // The one action here that cannot be undone row-by-row: make sure.
    if (!window.confirm(`Delete all ${total} dictations? This cannot be undone.`)) return
    await window.murmur.history.clear()
    await load('', PAGE_SIZE)
    setSearch('')
  }

  const copy = async (record: DictationRecord): Promise<void> => {
    // Through main, not `navigator.clipboard` — see the `app.copyText`
    // contract. The DOM API is present here but its permission is refused, so
    // it rejected on every packaged build.
    try {
      await window.murmur.app.copyText({ text: record.polishedText ?? record.rawText })
      setCopiedId(record.id)
      setTimeout(() => setCopiedId(null), 1_200)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  return (
    <Section title="History" description="Everything you have dictated, newest first.">
      {error ? <ErrorCard>{error}</ErrorCard> : null}

      <div className="flex items-start gap-8">
        <div className="min-w-0 flex-1">
          <div className="mb-5 flex items-center gap-2">
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
            <LoadingState label="Loading your history…" />
          ) : records.length === 0 ? (
            <EmptyState>
              {search
                ? `Nothing matches “${search}”.`
                : 'No dictations yet. Hold your dictation key and speak — what you say will show up here.'}
            </EmptyState>
          ) : (
            <>
              {groupByDay(records).map((group) => (
                <section key={group.label} className="mb-6">
                  <h3 className="mb-2 px-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
                    {group.label}
                  </h3>
                  <div className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
                    {group.items.map((record) => (
                      <HistoryRow
                        key={record.id}
                        record={record}
                        copied={copiedId === record.id}
                        onCopy={() => void copy(record)}
                        onDelete={() => void remove(record.id)}
                      />
                    ))}
                  </div>
                </section>
              ))}

              {records.length < total ? (
                <div className="mt-4 flex justify-center">
                  <Button onClick={() => void load(search, records.length + PAGE_SIZE)}>
                    Show more ({total - records.length} older)
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </div>

        {/* The stats rail — the reference keeps the headline numbers beside
            the feed, in serif. Insights is where they get depth. */}
        <aside className="hidden w-48 shrink-0 lg:block">
          <Card className="!p-4">
            <RailStat value={formatNumber(stats?.totalWords)} label="total words" />
            <RailStat value={formatNumber(stats?.avgWpm)} label="wpm" />
            <RailStat value={formatNumber(stats?.streakDays)} label="day streak" last />
          </Card>
        </aside>
      </div>
    </Section>
  )
}

/** One serif headline number in the rail. */
function RailStat({
  value,
  label,
  last = false,
}: {
  value: string
  label: string
  last?: boolean
}): React.JSX.Element {
  return (
    <div className={`flex items-baseline gap-2 ${last ? '' : 'mb-3'}`}>
      <span className="font-serif text-[26px] leading-none tracking-tight text-ink tabular-nums">
        {value}
      </span>
      <span className="text-[13px] text-ink-muted">{label}</span>
    </div>
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
    <div className="group flex items-start gap-4 px-4 py-3 transition-colors duration-150 hover:bg-canvas/60">
      {/* The time gutter — the reference's strongest history signature. */}
      <span className="w-16 shrink-0 pt-px text-[12px] tabular-nums text-ink-faint">
        {formatClock(record.ts)}
      </span>

      <div className="min-w-0 flex-1">
        <p className="select-text whitespace-pre-wrap text-[13px] leading-relaxed text-ink">
          {text}
        </p>
        {/* A row with no polished text means the raw transcript was inserted —
            either polishing was off, or the hallucination guard rejected the
            model's output (PLAN §7.4). Worth surfacing rather than hiding. */}
        {record.polishedText === null || record.appBundleId ? (
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            {record.polishedText === null ? <Badge tone="neutral">Raw</Badge> : null}
            {record.appBundleId ? (
              <Badge tone="neutral">{record.appName ?? record.appCategory}</Badge>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* Quiet until the row is hovered or focused — a wall of Copy/Delete
          buttons down the page is noise; they surface when relevant. */}
      <div className="flex shrink-0 items-center gap-2 opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover:opacity-100">
        <Button onClick={onCopy}>{copied ? 'Copied' : 'Copy'}</Button>
        <Button onClick={onDelete} variant="danger">
          Delete
        </Button>
      </div>
    </div>
  )
}
