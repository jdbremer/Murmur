import { useState } from 'react'

import type { InsightsDay } from '@murmur/shared'

import { formatNumber } from '../../../format'
import { buildHeatmap, HEATMAP_STEP_WEEKS, addDays, type HeatmapCell } from './heatmap'

/**
 * The streak grid (PLAN §2.2.2).
 *
 * A year of squares, one per day, shaded by how much was dictated. The current
 * streak glows — and stops on the last day actually dictated, never on today's
 * empty square: see `streakEndDay` in the store for why that distinction earns
 * its own field.
 */

/** How many week columns fit comfortably in the Hub's content width. */
const VISIBLE_WEEKS = 26

const LEVEL_FILL: Record<HeatmapCell['level'], string> = {
  0: 'bg-canvas border border-line',
  1: 'bg-accent/20',
  2: 'bg-accent/40',
  3: 'bg-accent/65',
  4: 'bg-accent',
}

const WEEKDAY_LABELS = ['', 'Mon', '', 'Wed', '', 'Fri', '']

export function StreakHeatmap({
  days,
  today,
  streakEndDay,
  streakLength,
}: {
  days: readonly InsightsDay[]
  today: string
  streakEndDay: string | null
  streakLength: number
}): React.JSX.Element {
  /** Weeks scrolled back from the present. 0 = the window ending today. */
  const [weeksBack, setWeeksBack] = useState(0)

  const windowEnd = addDays(today, -weeksBack * 7)
  const { columns, monthLabels } = buildHeatmap({
    days,
    today: windowEnd,
    weeks: VISIBLE_WEEKS,
    streakEndDay,
    streakLength,
  })

  // Bounded by the evidence: there is nothing to look at before the first day
  // the user dictated on, so the back arrow stops there rather than scrolling
  // into an infinite empty past.
  const firstRecorded = days[0]?.day
  const earliestVisible = columns[0]?.[0]?.day
  const canGoBack = firstRecorded !== undefined && earliestVisible! > firstRecorded

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <div className="flex gap-1 text-[11px] text-ink-faint">
          {monthLabels.map(({ column, label }) => (
            <span key={`${column}-${label}`} className="tabular-nums">
              {label}
            </span>
          ))}
        </div>
        <div className="flex items-center gap-1">
          <ArrowButton
            label={`Show the ${HEATMAP_STEP_WEEKS} weeks before this`}
            disabled={!canGoBack}
            onClick={() => setWeeksBack((back) => back + HEATMAP_STEP_WEEKS)}
          >
            <path d="m14 6-6 6 6 6" />
          </ArrowButton>
          <ArrowButton
            label="Show more recent weeks"
            disabled={weeksBack === 0}
            onClick={() => setWeeksBack((back) => Math.max(0, back - HEATMAP_STEP_WEEKS))}
          >
            <path d="m10 6 6 6-6 6" />
          </ArrowButton>
        </div>
      </div>

      {/* Wide content scrolls inside its own box rather than widening the page. */}
      <div className="flex gap-1.5 overflow-x-auto pb-1">
        <div className="flex shrink-0 flex-col gap-[3px] pr-1 pt-[1px]">
          {WEEKDAY_LABELS.map((label, index) => (
            <span
              key={index}
              className="h-[13px] text-[9px] leading-[13px] text-ink-faint"
              aria-hidden="true"
            >
              {label}
            </span>
          ))}
        </div>

        <div className="flex gap-[3px]">
          {columns.map((column, index) => (
            <div key={index} className="flex flex-col gap-[3px]">
              {column.map((cell) => (
                <Cell key={cell.day} cell={cell} />
              ))}
            </div>
          ))}
        </div>
      </div>

      <div className="mt-2 flex items-center justify-end gap-1.5 text-[11px] text-ink-faint">
        <span>Less</span>
        {([0, 1, 2, 3, 4] as const).map((level) => (
          <span key={level} className={`size-[11px] rounded-[3px] ${LEVEL_FILL[level]}`} />
        ))}
        <span>More</span>
      </div>
    </div>
  )
}

function Cell({ cell }: { cell: HeatmapCell }): React.JSX.Element | null {
  // A day that has not happened yet is a hole, not an empty day: drawing it as
  // "nothing dictated" makes the rest of this week look like a broken streak.
  if (cell.future) return <span className="size-[13px]" aria-hidden="true" />

  const label =
    cell.dictations === 0
      ? `${cell.day}: nothing dictated`
      : `${cell.day}: ${formatNumber(cell.words)} words across ${formatNumber(
          cell.dictations,
        )} dictations`

  return (
    <span
      title={label}
      aria-label={label}
      className={[
        'size-[13px] rounded-[3px] transition-shadow duration-200',
        LEVEL_FILL[cell.level],
        cell.inStreak ? 'ring-1 ring-accent/70 ring-offset-1 ring-offset-surface' : '',
      ]
        .join(' ')
        .trim()}
    />
  )
}

function ArrowButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string
  onClick: () => void
  disabled: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="grid size-6 place-items-center rounded-md text-ink-muted transition-colors duration-150 hover:bg-canvas hover:text-ink disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent"
    >
      <svg
        viewBox="0 0 24 24"
        aria-hidden="true"
        className="size-[14px]"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {children}
      </svg>
    </button>
  )
}
