import { USAGE_INTENSITY_LABEL, usageIntensity, type InsightsApp } from '@murmur/shared'

import { EmptyState } from '../../../components/Section'
import { formatNumber } from '../../../format'

/**
 * Where the words actually went, as horizontal bars.
 *
 * Per *app* rather than per tone category, which is the breakdown Style already
 * shows and which answers a different question: "Slack, 12,400 words" is a fact
 * about your week, "work, 12,400 words" is a fact about our bundle-id table.
 *
 * Shading is by rank, not by value — the top app darkest, the next two mid, the
 * rest light — so the ordering survives a screenshot at any contrast, and so a
 * user with one dominant app does not get a chart of one visible bar and six
 * invisible ones.
 */

const RANK_FILL = ['bg-accent', 'bg-accent/65', 'bg-accent/65', 'bg-accent/35'] as const

export function AppBars({
  apps,
  otherWords,
  collecting,
}: {
  apps: readonly InsightsApp[]
  otherWords: number
  collecting: boolean
}): React.JSX.Element {
  if (!collecting) {
    return (
      <EmptyState>
        The per-app breakdown is switched off. Turn “Track which apps you dictate into” back on in
        Settings and it starts filling from your next dictation.
      </EmptyState>
    )
  }

  if (apps.length === 0) {
    return <EmptyState>Dictate into a few apps and this fills in.</EmptyState>
  }

  // Percentages are against every app, including the ones past the cut, so the
  // numbers under the bars still add up to the total above them.
  const total = apps.reduce((sum, app) => sum + app.words, 0) + otherWords
  const widest = apps[0]?.words ?? 1

  return (
    <ul className="space-y-1.5">
      {apps.map((app, index) => {
        const intensity = usageIntensity(app.words)
        const share = total > 0 ? Math.round((app.words / total) * 100) : 0
        return (
          <li key={app.bundleId}>
            <div
              className="group relative h-8 overflow-hidden rounded-lg bg-canvas"
              title={`${app.name} — ${formatNumber(app.words)} words across ${formatNumber(
                app.dictations,
              )} dictations · ${USAGE_INTENSITY_LABEL[intensity]}`}
            >
              <div
                className={`h-full rounded-lg transition-[width] duration-500 ${
                  RANK_FILL[Math.min(index, RANK_FILL.length - 1)]
                }`}
                // Against the widest bar, not the total: a chart where the top
                // app fills 8% of the row is unreadable, and the percentage
                // label below carries the true share.
                style={{ width: `${Math.max(6, Math.round((app.words / widest) * 100))}%` }}
              />
              <div className="pointer-events-none absolute inset-0 flex items-center justify-between px-2.5">
                <span className="truncate text-[12px] font-medium text-ink mix-blend-luminosity">
                  {app.name}
                </span>
                <span className="shrink-0 pl-3 text-[11px] tabular-nums text-ink-muted">
                  {formatNumber(app.words)} · {share}%
                </span>
              </div>
            </div>
          </li>
        )
      })}

      {/* Never silently truncated: a chart that hides its own tail reads as a
          complete picture when it is not. */}
      {otherWords > 0 ? (
        <li className="pt-1 text-[12px] text-ink-faint">
          + {formatNumber(otherWords)} words in other apps
        </li>
      ) : null}
    </ul>
  )
}
