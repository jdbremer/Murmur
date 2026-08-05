import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { DictationRecord, HistoryStats } from '@murmur/shared'

import {
  Badge,
  Button,
  Card,
  EmptyState,
  IconButton,
  InlineError,
  SearchInput,
  Section,
  Stat,
} from '../../components/Section'
import {
  absoluteTime,
  appName,
  categoryLabel,
  formatCount,
  formatDecimal,
  formatDuration,
  relativeTime,
} from '../../lib/format'

/**
 * Home / History (PLAN §2.2.1).
 *
 * Reverse-chronological feed of everything dictated, with the polished text as
 * the primary line and the raw transcript one disclosure away — that pair is
 * the only honest way to show what a polishing model did to your words.
 *
 * Paging rather than virtual scrolling: `history.query` is offset-based and
 * FTS-backed, 25 rows is far below where the DOM starts to care, and "Load
 * more" is a control people understand. A windowing library would be more code
 * for a list most users scroll twice.
 */

const PAGE_SIZE = 25
const SEARCH_DEBOUNCE_MS = 180

export function HomeSection(): React.JSX.Element {
  const [stats, setStats] = useState<HistoryStats | null>(null)
  const [records, setRecords] = useState<DictationRecord[] | null>(null)
  const [total, setTotal] = useState(0)
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const requestId = useRef(0)

  const loadStats = useCallback(() => {
    void window.murmur.history
      .stats()
      .then(setStats)
      .catch(() => undefined)
  }, [])

  const load = useCallback((nextQuery: string, offset: number) => {
    const id = (requestId.current += 1)
    // One microtask of deferral keeps every setState below out of the
    // synchronous body of the effects that call load
    // (react-hooks/set-state-in-effect).
    void Promise.resolve()
      .then(() => {
        if (id !== requestId.current) return undefined
        setBusy(true)
        return window.murmur.history.query({ search: nextQuery, limit: PAGE_SIZE, offset })
      })
      .then((page) => {
        if (page === undefined || id !== requestId.current) return
        setRecords((current) =>
          offset === 0 ? page.records : [...(current ?? []), ...page.records],
        )
        setTotal(page.total)
        setError(null)
      })
      .catch((cause: unknown) => {
        if (id !== requestId.current) return
        setError(messageOf(cause))
        setRecords((current) => current ?? [])
      })
      .finally(() => {
        if (id === requestId.current) setBusy(false)
      })
  }, [])

  useEffect(() => {
    loadStats()
  }, [loadStats])

  // Debounced: every keystroke would otherwise be an FTS query and a re-render.
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [search])

  useEffect(() => {
    load(query, 0)
  }, [load, query])

  const remove = useCallback(
    (id: string) => {
      setRecords((current) => current?.filter((record) => record.id !== id) ?? null)
      setTotal((current) => Math.max(0, current - 1))
      void window.murmur.history
        .remove({ id })
        .then(loadStats)
        .catch((cause: unknown) => {
          setError(messageOf(cause))
          load(query, 0)
        })
    },
    [load, loadStats, query],
  )

  const loaded = records?.length ?? 0
  const hasMore = loaded < total

  return (
    <Section
      title="Home"
      description="Everything you have dictated, newest first. None of it left this machine."
    >
      <Card className="mb-5">
        <div className="grid grid-cols-3 gap-6">
          <Stat label="Words dictated" value={formatCount(stats?.totalWords)} />
          <Stat label="Average words per minute" value={formatDecimal(stats?.avgWpm)} />
          <Stat
            label="Day streak"
            value={formatCount(stats?.streakDays)}
            hint={stats && stats.streakDays > 0 ? 'Consecutive days with a dictation' : undefined}
          />
        </div>
      </Card>

      <div className="mb-4">
        <SearchInput
          value={search}
          onChange={setSearch}
          label="Search your dictations"
          placeholder="Search transcripts…"
        />
      </div>

      <InlineError>{error}</InlineError>

      {records === null ? (
        <p className="py-6 text-center text-[13px] text-ink-muted">Loading…</p>
      ) : records.length === 0 ? (
        query.length > 0 ? (
          <EmptyState title="No matches">
            Nothing in your history matches “{query}”. Search covers the polished text and the raw
            transcript alike.
          </EmptyState>
        ) : (
          <EmptyState title="Nothing here yet">
            Hold your dictation key, say a sentence, and let go. The words land wherever your cursor
            is — and a copy appears here, on this machine only.
          </EmptyState>
        )
      ) : (
        <>
          <ul className="space-y-2">
            {records.map((record) => (
              <HistoryRow key={record.id} record={record} onDelete={() => remove(record.id)} />
            ))}
          </ul>

          <div className="mt-4 flex items-center justify-between gap-4">
            <p className="text-[12px] text-ink-faint">
              Showing {formatCount(loaded)} of {formatCount(total)}
            </p>
            {hasMore ? (
              <Button onClick={() => load(query, loaded)} disabled={busy}>
                {busy ? 'Loading…' : 'Load more'}
              </Button>
            ) : null}
          </div>
        </>
      )}
    </Section>
  )
}

function HistoryRow({
  record,
  onDelete,
}: {
  record: DictationRecord
  onDelete: () => void
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const [copied, setCopied] = useState(false)
  const text = record.polishedText ?? record.rawText
  const polished = record.polishedText !== null && record.polishedText !== record.rawText
  const app = useMemo(() => appName(record.appBundleId), [record.appBundleId])

  const copy = useCallback(() => {
    void navigator.clipboard
      .writeText(text)
      .then(() => setCopied(true))
      .catch(() => setCopied(false))
  }, [text])

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1400)
    return () => clearTimeout(timer)
  }, [copied])

  return (
    <li>
      <Card>
        <p className="select-text whitespace-pre-wrap text-[13px] leading-relaxed text-ink">
          {text}
        </p>

        <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] text-ink-faint">
          <Badge tone="neutral" title={`Tone profile: ${categoryLabel(record.appCategory)}`}>
            {categoryLabel(record.appCategory)}
          </Badge>
          {app ? <span title={record.appBundleId ?? undefined}>{app}</span> : null}
          <span aria-hidden="true">·</span>
          <span>{formatDuration(record.durationMs)}</span>
          <span aria-hidden="true">·</span>
          <time dateTime={new Date(record.ts).toISOString()} title={absoluteTime(record.ts)}>
            {relativeTime(record.ts)}
          </time>

          <span className="ml-auto flex items-center gap-1">
            {polished ? (
              <button
                type="button"
                onClick={() => setExpanded((open) => !open)}
                aria-expanded={expanded}
                className="rounded px-1.5 py-0.5 text-[11px] text-ink-muted outline-none hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              >
                {expanded ? 'Hide raw transcript' : 'Show raw transcript'}
              </button>
            ) : null}
            <IconButton label={copied ? 'Copied' : 'Copy to clipboard'} onClick={copy}>
              {copied ? (
                <path d="m5 12.5 4.5 4.5L19 7" />
              ) : (
                <>
                  <rect x="9" y="9" width="11" height="11" rx="2" />
                  <path d="M5 15V6a1 1 0 0 1 1-1h9" />
                </>
              )}
            </IconButton>
            <IconButton label="Delete this dictation" tone="danger" onClick={onDelete}>
              <path d="M5 7h14M10 7V5h4v2M6 7l1 12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-12" />
            </IconButton>
          </span>
        </div>

        {expanded ? (
          <div className="mt-3 rounded-lg border border-line bg-canvas p-3">
            <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-ink-faint">
              Raw transcript
            </p>
            <p className="select-text whitespace-pre-wrap text-[12px] leading-relaxed text-ink-muted">
              {record.rawText}
            </p>
            <p className="mt-2 text-[11px] text-ink-faint">
              {record.sttModelId}
              {record.polishModelId ? ` · polished by ${record.polishModelId}` : ' · not polished'}
            </p>
          </div>
        ) : null}
      </Card>
    </li>
  )
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
