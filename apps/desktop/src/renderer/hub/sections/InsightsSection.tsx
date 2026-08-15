import { monthOverMonthChange } from '@murmur/shared'

import { Badge, Card, ErrorCard, LoadingState, Section } from '../../components/Section'
import { formatNumber } from '../../format'
import { useInsights } from '../../hooks/useInsights'
import { AppBars } from './insights/AppBars'
import { WpmGauge } from './insights/Gauge'
import { StreakHeatmap } from './insights/HeatmapView'

/**
 * Insights (PLAN §2.2.2) — what you have actually been using Murmur for.
 *
 * Every figure is computed on this machine from this machine's database. There
 * is no server, no cohort, no telemetry, and the section is careful never to
 * imply otherwise: the WPM comparison is against a published *typing*
 * distribution, and the fixes tile counts three things that were measured
 * rather than one number that was estimated.
 *
 * The counters behind it deliberately outlive the history retention window —
 * see migration 5. Deleting a transcript for privacy does not un-speak it, so
 * the totals only move when the user resets them.
 */
export function InsightsSection(): React.JSX.Element {
  const { insights, error } = useInsights()

  if (error) {
    return (
      <Section title="Insights" description="What you have been dictating, and where.">
        <ErrorCard>{error}</ErrorCard>
      </Section>
    )
  }

  if (!insights) {
    return (
      <Section title="Insights" description="What you have been dictating, and where.">
        <LoadingState label="Adding it all up…" />
      </Section>
    )
  }

  const { totals, fixes, streak, days, apps, today } = insights
  const change = monthOverMonthChange(days, today)

  // Gated on the lifetime word count, not on the dictation count. The latter is
  // summed from `dictation_days`, whose per-day columns migration 5 can only
  // backfill from history rows that still exist — so a user whose transcripts
  // have all been pruned has a real word count, a real streak and a zero
  // dictation count. Hiding their totals behind "nothing to show yet" would
  // throw away precisely the numbers these counters exist to survive.
  if (totals.words === 0 && streak.longest === 0) {
    return (
      <Section title="Insights" description="What you have been dictating, and where.">
        <Card className="border-dashed">
          <p className="mx-auto max-w-md py-6 text-center text-[13px] leading-relaxed text-ink-muted">
            Nothing to show yet. Hold your dictation key and speak — your speaking rate, the words
            you have saved yourself typing, and the apps you use Murmur in most all appear here.
          </p>
        </Card>
      </Section>
    )
  }

  return (
    <Section
      title="Insights"
      description="What you have been dictating, and where. Computed on this machine; none of it leaves."
    >
      <div className="mb-4 grid gap-4 sm:grid-cols-2">
        <Card>
          <Heading>Speaking rate</Heading>
          <div className="pt-2">
            <WpmGauge wpm={totals.avgWpm} />
          </div>
        </Card>

        <div className="grid gap-4">
          <Card>
            <Heading>Words dictated</Heading>
            <div className="mt-1.5 flex items-baseline gap-2">
              <p className="font-serif text-[32px] tracking-tight tabular-nums text-ink">
                {formatNumber(totals.words)}
              </p>
              {/* Hidden rather than shown as +100% when there is no previous
                  month to compare against. */}
              {change !== null ? (
                <Badge
                  tone={change >= 0 ? 'positive' : 'neutral'}
                  title="This month so far, against all of last month"
                >
                  {change >= 0 ? '+' : ''}
                  {change}% vs last month
                </Badge>
              ) : null}
            </div>
            <p className="mt-1 text-[12px] text-ink-muted">
              across {formatNumber(totals.dictations)} dictations
            </p>
          </Card>

          <Card>
            <Heading>Fixed for you</Heading>
            <dl className="mt-2 space-y-1.5">
              <FixRow
                label="Words cleaned up"
                value={fixes.wordsCleaned}
                hint="Fillers, false starts and self-corrections the polishing model removed. An estimate — a rewrite that shortens a sentence counts too."
              />
              <FixRow
                label="Dictionary fixes"
                value={fixes.dictionaryFixes}
                hint="Replacement rules that actually fired."
              />
              <FixRow
                label="Snippets expanded"
                value={fixes.snippetExpansions}
                hint="Triggers that expanded into stored text."
              />
            </dl>
          </Card>
        </div>
      </div>

      <Card className="mb-4">
        <div className="mb-3 flex items-baseline justify-between gap-4">
          <Heading>Daily streak</Heading>
          <p className="text-[12px] text-ink-muted">
            <span className="font-medium text-ink">{formatNumber(streak.current)}</span> day
            {streak.current === 1 ? '' : 's'} · best {formatNumber(streak.longest)}
          </p>
        </div>
        <StreakHeatmap
          days={days}
          today={today}
          streakEndDay={streak.endDay}
          streakLength={streak.current}
        />
      </Card>

      <Card>
        <div className="mb-3">
          <Heading>Where you dictate</Heading>
        </div>
        <AppBars apps={apps} otherWords={insights.otherAppWords} collecting={insights.collecting} />
      </Card>
    </Section>
  )
}

function Heading({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <h2 className="text-[11px] font-semibold uppercase tracking-[0.07em] text-ink-faint">
      {children}
    </h2>
  )
}

function FixRow({
  label,
  value,
  hint,
}: {
  label: string
  value: number
  hint: string
}): React.JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-[13px] text-ink-muted" title={hint}>
        {label}
      </dt>
      <dd className="text-[15px] font-medium tabular-nums text-ink">{formatNumber(value)}</dd>
    </div>
  )
}
