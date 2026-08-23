import { useCallback, useEffect, useRef, useState } from 'react'

import {
  deriveNoteTitle,
  HISTORY_EXPORT_FORMATS,
  type DictationRecord,
  type HistoryExportFormat,
  type HistoryStats,
} from '@murmur/shared'

import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorCard,
  Section,
  Select,
  TextInput,
} from '../../components/Section'
import { SkeletonList } from '../../components/Skeleton'
import { formatClock, formatNumber, groupByDay } from '../../format'
import { useFocusShortcut } from '../../hooks/useFocusShortcut'
import { useToast } from '../components/ToastHost'
import { useNavigate } from '../navigation'
import { errorMessage } from '../../lib/errors'

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

/** A stable identity, so an empty selection never re-renders the list. */
const EMPTY_SELECTION: ReadonlySet<string> = new Set()

const FORMAT_LABELS: Record<HistoryExportFormat, string> = {
  md: 'Markdown',
  csv: 'CSV',
  json: 'JSON',
  txt: 'Text',
}

const FORMAT_OPTIONS = HISTORY_EXPORT_FORMATS.map((value) => ({
  value,
  label: FORMAT_LABELS[value],
}))

/**
 * Keep the first occurrence of each id.
 *
 * Appending pages from a live list can double up: a dictation landing while
 * page two is in flight shifts every row down by one, so the row that was last
 * on page one arrives again as the first of page two. Rendering it twice is a
 * React key collision as well as a lie about the history.
 */
function dedupe(records: readonly DictationRecord[]): DictationRecord[] {
  const seen = new Set<string>()
  return records.filter((record) => {
    if (seen.has(record.id)) return false
    seen.add(record.id)
    return true
  })
}

export function HistorySection(): React.JSX.Element {
  const [records, setRecords] = useState<DictationRecord[] | null>(null)
  const [stats, setStats] = useState<HistoryStats | null>(null)
  const [total, setTotal] = useState(0)
  const [search, setSearch] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [selected, setSelected] = useState<ReadonlySet<string>>(EMPTY_SELECTION)
  const [format, setFormat] = useState<HistoryExportFormat>('md')
  const [polishingId, setPolishingId] = useState<string | null>(null)
  const toast = useToast()
  const navigate = useNavigate()
  const searchRef = useRef<HTMLInputElement | null>(null)
  useFocusShortcut(searchRef)

  const active = useRef(true)
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
    }
  }, [])

  /**
   * Read one page, either replacing the list or appending to it.
   *
   * This used to ask for `offset: 0` and a larger `limit` every time, so
   * "Show more" re-fetched and re-parsed everything already on screen —
   * quadratic in the number of pages, and the cost lands on exactly the users
   * who have the most history. A real offset fetches only what is new.
   */
  const load = useCallback(
    async (query: string, offset: number, mode: 'replace' | 'append'): Promise<void> => {
      try {
        const page = await window.murmur.history.query({
          search: query,
          limit: PAGE_SIZE,
          offset,
        })
        if (!active.current) return
        setRecords((current) =>
          mode === 'append' && current ? dedupe([...current, ...page.records]) : page.records,
        )
        setTotal(page.total)
        setError(null)
      } catch (cause) {
        if (!active.current) return
        setError(errorMessage(cause))
        setRecords([])
      }
    },
    [],
  )

  /**
   * Re-read every page currently on screen, in one query.
   *
   * What a delete or an undo needs: the list has to stay the length it was,
   * and a paged re-fetch after a row disappears would silently drop whichever
   * row slid across each page boundary.
   */
  const reload = useCallback(async (query: string, count: number): Promise<void> => {
    try {
      const page = await window.murmur.history.query({
        search: query,
        limit: Math.max(PAGE_SIZE, Math.min(500, count)),
        offset: 0,
      })
      if (!active.current) return
      setRecords(page.records)
      setTotal(page.total)
      setError(null)
    } catch (cause) {
      if (!active.current) return
      setError(errorMessage(cause))
    }
  }, [])

  // Debounced so typing does not fire one FTS query per keystroke.
  useEffect(() => {
    const timer = setTimeout(
      () => {
        void load(search, 0, 'replace')
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
      void reload(latest.current.search, latest.current.count)
    })
  }, [reload])

  /**
   * Delete, but reversibly.
   *
   * No confirmation dialog: a modal in front of every single-row delete is the
   * kind of safety that trains people to click through it. The undo in the
   * toast is the real safety net, and it costs nothing when it is not needed.
   * `history.restore` puts the row back without touching the lifetime counters
   * — deleting never moved them, so undoing must not either.
   */
  const remove = async (record: DictationRecord): Promise<void> => {
    const count = records?.length ?? PAGE_SIZE
    await window.murmur.history.remove({ id: record.id })
    await reload(search, count)
    toast.show({
      message: 'Dictation deleted',
      actionLabel: 'Undo',
      onAction: () => {
        void window.murmur.history.restore(record).then(() => reload(search, count))
      },
    })
  }

  const clear = async (): Promise<void> => {
    // The one action here that cannot be undone row-by-row: make sure.
    if (!window.confirm(`Delete all ${total} dictations? This cannot be undone.`)) return
    const removed = total
    await window.murmur.history.clear()
    await load('', 0, 'replace')
    setSearch('')
    toast.show({
      message: `Deleted ${formatNumber(removed)} dictation${removed === 1 ? '' : 's'}`,
      detail: 'Your word count and streak were reset with them.',
    })
  }

  const toggle = (id: string): void => {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  /**
   * Delete a selection, reversibly.
   *
   * The undo restores every row in one go rather than offering one toast per
   * dictation — a stack of forty undo toasts is not an undo, it is a wall.
   */
  const removeSelected = async (): Promise<void> => {
    const rows = (records ?? []).filter((record) => selected.has(record.id))
    if (rows.length === 0) return
    const count = records?.length ?? PAGE_SIZE

    for (const row of rows) await window.murmur.history.remove({ id: row.id })
    setSelected(EMPTY_SELECTION)
    await reload(search, count)

    toast.show({
      message: `Deleted ${formatNumber(rows.length)} dictation${rows.length === 1 ? '' : 's'}`,
      actionLabel: 'Undo',
      onAction: () => {
        void Promise.all(rows.map((row) => window.murmur.history.restore(row))).then(() =>
          reload(search, count),
        )
      },
    })
  }

  const exportSelected = async (): Promise<void> => {
    try {
      const result = await window.murmur.data.exportHistory({
        format,
        ids: [...selected],
        search: selected.size === 0 ? search : '',
      })
      // A cancelled dialog is the ordinary outcome, not something to report.
      if (!result.path) return
      toast.show({
        message: `Exported ${formatNumber(result.count)} dictation${result.count === 1 ? '' : 's'}`,
        detail: result.path,
        tone: 'positive',
      })
    } catch (cause) {
      toast.show({
        message: 'Could not export that',
        detail: errorMessage(cause),
        tone: 'danger',
      })
    }
  }

  /**
   * A dictation is often the first draft of something longer. Sending it to the
   * Scratchpad is the difference between history being a log and history being
   * a place work starts.
   */
  const toScratchpad = async (record: DictationRecord): Promise<void> => {
    try {
      const note = await window.murmur.notes.create({
        title: '',
        body: record.polishedText ?? record.rawText,
      })
      toast.show({
        message: `Saved to the Scratchpad`,
        detail: deriveNoteTitle(note),
        tone: 'positive',
        actionLabel: 'Open',
        onAction: () => void window.murmur.notes.openWindow({ noteId: note.id }),
      })
    } catch (cause) {
      toast.show({
        message: 'Could not save that note',
        detail: errorMessage(cause),
        tone: 'danger',
      })
    }
  }

  /**
   * Polish a transcript that went in raw.
   *
   * Undoable like everything else destructive here: the model can produce a
   * worse sentence than the one it replaced, and "the polish button made it
   * wrong and I cannot get my words back" would be a reason never to press it
   * a second time.
   */
  const repolish = async (record: DictationRecord): Promise<void> => {
    const previous = record.polishedText
    setPolishingId(record.id)
    try {
      const updated = await window.murmur.history.repolish({ id: record.id })
      setRecords((current) => (current ?? []).map((row) => (row.id === record.id ? updated : row)))
      toast.show({
        message: 'Polished',
        detail: updated.polishedText ?? undefined,
        tone: 'positive',
        actionLabel: 'Undo',
        onAction: () => {
          void window.murmur.history
            .restore({ ...record, polishedText: previous })
            .then(() => reload(search, records?.length ?? PAGE_SIZE))
        },
      })
    } catch (cause) {
      toast.show({ message: 'Could not polish that', detail: errorMessage(cause), tone: 'danger' })
    } finally {
      setPolishingId(null)
    }
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
      setError(errorMessage(cause))
    }
  }

  return (
    <Section title="History" description="Everything you have dictated, newest first.">
      {error ? <ErrorCard>{error}</ErrorCard> : null}

      <div className="flex items-start gap-8">
        <div className="min-w-0 flex-1">
          <div className="mb-4 flex items-center gap-2">
            <div className="flex-1">
              <TextInput
                inputRef={searchRef}
                value={search}
                onChange={setSearch}
                ariaLabel="Search history"
                placeholder="Search your dictations…"
              />
            </div>
            {records && records.length > 0 ? (
              <>
                <Select
                  label="Export format"
                  value={format}
                  options={FORMAT_OPTIONS}
                  onChange={setFormat}
                />
                <Button onClick={() => void exportSelected()}>Export…</Button>
                <Button onClick={() => void clear()} variant="danger">
                  Clear all
                </Button>
              </>
            ) : null}
          </div>

          {/* The selection bar takes over the toolbar's job while a selection
              exists, rather than adding a second row of controls that are only
              sometimes meaningful. */}
          {selected.size > 0 ? (
            <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-accent/40 bg-accent-soft px-3 py-2">
              <span className="text-[12px] font-medium tabular-nums text-ink">
                {formatNumber(selected.size)} selected
              </span>
              <div className="flex-1" />
              <Button onClick={() => void exportSelected()}>Export these…</Button>
              <Button variant="danger" onClick={() => void removeSelected()}>
                Delete
              </Button>
              <Button onClick={() => setSelected(EMPTY_SELECTION)}>Clear</Button>
            </div>
          ) : null}

          {records === null ? (
            <SkeletonList label="Loading your history…" rows={6} gutter />
          ) : records.length === 0 && search ? (
            <EmptyState
              icon="search"
              title={`Nothing matches “${search}”`}
              action={<Button onClick={() => setSearch('')}>Clear search</Button>}
            >
              Search looks through every word you have dictated, polished and raw. Try a shorter
              phrase, or clear the search to see everything.
            </EmptyState>
          ) : records.length === 0 ? (
            <EmptyState
              icon="history"
              title="Nothing here yet"
              action={
                <Button variant="primary" onClick={() => navigate('help')}>
                  How dictation works
                </Button>
              }
            >
              Hold your dictation key anywhere on your Mac and speak. What you say lands in whatever
              you were typing into — and a copy shows up here.
            </EmptyState>
          ) : (
            <>
              {groupByDay(records).map((group) => (
                <section key={group.label} className="mb-6">
                  <h3 className="mb-2 px-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
                    {group.label}
                  </h3>
                  <div className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface-raised elev-1">
                    {group.items.map((record) => (
                      <HistoryRow
                        key={record.id}
                        record={record}
                        copied={copiedId === record.id}
                        selected={selected.has(record.id)}
                        onToggle={() => toggle(record.id)}
                        onCopy={() => void copy(record)}
                        polishing={polishingId === record.id}
                        onRepolish={() => void repolish(record)}
                        onSaveToNotes={() => void toScratchpad(record)}
                        onDelete={() => void remove(record)}
                      />
                    ))}
                  </div>
                </section>
              ))}

              {records.length < total ? (
                <div className="mt-4 flex justify-center">
                  <Button onClick={() => void load(search, records.length, 'append')}>
                    Show more ({total - records.length} older)
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </div>

        {/* The stats rail — the reference keeps the headline numbers beside the
            feed, in serif. Insights is where they get depth. It gives up its
            224px before the feed does: three figures that are also one click
            away in Insights are not worth squeezing the transcripts for. */}
        <aside className="hidden w-48 shrink-0 @3xl:block">
          <Card padding="sm">
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
  selected,
  polishing,
  onToggle,
  onCopy,
  onRepolish,
  onSaveToNotes,
  onDelete,
}: {
  record: DictationRecord
  copied: boolean
  selected: boolean
  polishing: boolean
  onToggle: () => void
  onCopy: () => void
  onRepolish: () => void
  onSaveToNotes: () => void
  onDelete: () => void
}): React.JSX.Element {
  const text = record.polishedText ?? record.rawText

  return (
    <div
      className={`group relative flex items-start gap-3 px-4 py-3 transition-colors duration-150 ${
        selected ? 'bg-accent-soft' : 'hover:bg-surface-sunken/60'
      }`}
    >
      {/* Hidden until the row is hovered, or until something is selected —
          a column of empty checkboxes down a reading surface is a table, and
          this is meant to read as text. */}
      <input
        type="checkbox"
        checked={selected}
        onChange={onToggle}
        aria-label={`Select the dictation from ${formatClock(record.ts)}`}
        className={`mt-1 size-3.5 shrink-0 accent-accent transition-opacity duration-150 ${
          selected ? 'opacity-100' : 'opacity-0 focus-visible:opacity-100 group-hover:opacity-100'
        }`}
      />

      {/* The time gutter — the reference's strongest history signature. */}
      <span className="w-14 shrink-0 pt-px text-[12px] tabular-nums text-ink-faint">
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
      {/*
        Floated over the row rather than laid out beside it.
        As a flex sibling these three buttons reserved their full width on every
        row whether or not they were visible, and the reading column — the only
        thing on this page anyone came to read — was squeezed to about four
        words a line. Overlaying them costs nothing until the pointer arrives,
        and the backdrop keeps the text underneath from showing through.
      */}
      <div className="pointer-events-none absolute right-3 top-2 flex items-center gap-2 rounded-lg bg-surface-raised/95 px-1 opacity-0 shadow-sm backdrop-blur-[2px] transition-opacity duration-150 focus-within:pointer-events-auto focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100">
        <Button onClick={onCopy}>{copied ? 'Copied' : 'Copy'}</Button>
        {/* Offered only where it would change something: a row that is already
            polished does not need a button promising to polish it. */}
        {record.polishedText === null ? (
          <Button
            onClick={onRepolish}
            disabled={polishing}
            title="Run the polishing model over this transcript"
          >
            {polishing ? 'Polishing…' : 'Polish'}
          </Button>
        ) : null}
        <Button onClick={onSaveToNotes} title="Start a note from this dictation">
          To Scratchpad
        </Button>
        <Button onClick={onDelete} variant="danger">
          Delete
        </Button>
      </div>
    </div>
  )
}
