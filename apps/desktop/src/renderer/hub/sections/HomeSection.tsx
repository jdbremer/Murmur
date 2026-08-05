import { useEffect, useState } from 'react'

import type { DictationRecord, HistoryStats } from '@murmur/shared'

import { Card, ComingSoon, Section, Stat } from '../../components/Section'

/**
 * Home / History (PLAN §2.2.1).
 *
 * The stats header and the feed already read through the real IPC channels;
 * they are empty because the SQLite store behind them arrives in Stage 2.
 */
export function HomeSection(): React.JSX.Element {
  const [stats, setStats] = useState<HistoryStats | null>(null)
  const [records, setRecords] = useState<DictationRecord[] | null>(null)

  useEffect(() => {
    let active = true
    void Promise.all([
      window.murmur.history.stats(),
      window.murmur.history.query({ search: '', limit: 20, offset: 0 }),
    ])
      .then(([nextStats, page]) => {
        if (!active) return
        setStats(nextStats)
        setRecords(page.records)
      })
      .catch(() => {
        if (active) setRecords([])
      })
    return () => {
      active = false
    }
  }, [])

  return (
    <Section title="Home" description="Everything you have dictated, newest first.">
      <Card className="mb-5">
        <div className="grid grid-cols-3 gap-6">
          <Stat label="Words dictated" value={format(stats?.totalWords)} />
          <Stat label="Average WPM" value={format(stats?.avgWpm)} />
          <Stat label="Day streak" value={format(stats?.streakDays)} />
        </div>
      </Card>

      {records && records.length > 0 ? (
        <ul className="space-y-2">
          {records.map((record) => (
            <Card key={record.id}>
              <p className="select-text text-[13px] leading-relaxed text-ink">
                {record.polishedText ?? record.rawText}
              </p>
            </Card>
          ))}
        </ul>
      ) : (
        <ComingSoon>
          No dictations yet. History, full-text search and the copy/delete controls are wired to
          real IPC channels already; the SQLite store behind them lands in the next stage.
        </ComingSoon>
      )}
    </Section>
  )
}

function format(value: number | undefined): string {
  if (value === undefined) return '—'
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}
