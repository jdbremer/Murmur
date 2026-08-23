import { USAGE_INTENSITY_LABEL, usageIntensity, type InsightsApp } from '@murmur/shared'

import { Button, EmptyState } from '../../../components/Section'
import { useNavigate } from '../../navigation'
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
  const navigate = useNavigate()

  if (!collecting) {
    return (
      <EmptyState
        icon="apps"
        title="Per-app breakdown is off"
        action={<Button onClick={() => navigate('settings')}>Open Settings</Button>}
      >
        Turn “Track which apps you dictate into” back on and this starts filling from your next
        dictation. Nothing already collected was kept.
      </EmptyState>
    )
  }

  if (apps.length === 0) {
    return (
      <EmptyState icon="apps" title="No apps yet">
        Dictate into a few apps and this fills in.
      </EmptyState>
    )
  }

  // Percentages are against every app, including the ones past the cut, so the
  // numbers under the bars still add up to the total above them.
  const total = apps.reduce((sum, app) => sum + app.words, 0) + otherWords
  const widest = apps[0]?.words ?? 1

  return (
    <ul className="space-y-2.5">
      {apps.map((app, index) => {
        const intensity = usageIntensity(app.words)
        const share = total > 0 ? Math.round((app.words / total) * 100) : 0
        return (
          <li key={app.bundleId}>
            {/*
              Both labels sit outside the track.
              They used to be overlaid on it, which is only legible while the
              bar is short: the top app fills the whole row, and dark secondary
              text on a saturated indigo fill is unreadable — the one row the
              chart most wants you to read.
            */}
            <div
              className="flex items-center gap-3"
              title={`${app.name} — ${formatNumber(app.words)} words across ${formatNumber(
                app.dictations,
              )} dictations · ${USAGE_INTENSITY_LABEL[intensity]}`}
            >
              <span className="w-28 shrink-0 truncate text-[12px] font-medium text-ink">
                {app.name}
              </span>
              <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-surface-sunken">
                <div
                  className={`h-full rounded-full transition-[width] duration-500 ${
                    RANK_FILL[Math.min(index, RANK_FILL.length - 1)]
                  }`}
                  // Against the widest bar, not the total: a chart where the top
                  // app fills 8% of the row is unreadable, and the percentage
                  // beside it carries the true share.
                  style={{ width: `${Math.max(6, Math.round((app.words / widest) * 100))}%` }}
                />
              </div>
              <span className="w-24 shrink-0 text-right text-[11px] tabular-nums text-ink-muted">
                {formatNumber(app.words)} · {share}%
              </span>
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
