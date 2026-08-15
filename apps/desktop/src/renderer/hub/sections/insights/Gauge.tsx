import { fasterThanPercentOfTypists } from '@murmur/shared'

import { useReducedMotion } from '../../../hooks/useReducedMotion'

/**
 * Average speaking rate, on a semicircular dial.
 *
 * A dial rather than another big number because this is the one Insights figure
 * that means nothing in isolation: 96 is only interesting once you know where it
 * sits. The arc supplies that context at a glance, and the caption underneath
 * says exactly what it is being compared against — *typing* speed, from a
 * published distribution, not other Murmur users. There is no server here and
 * therefore no cohort, and a percentile that implied one would be invented.
 */

/** Where the dial tops out. Beyond this the needle simply pins. */
const MAX_WPM = 160

const SIZE = { width: 176, height: 104 }
/** Centre of the arc, in the same user units as the viewBox. */
const CENTRE = { x: 88, y: 88 }
const RADIUS = 68
const STROKE = 9

export function WpmGauge({ wpm }: { wpm: number }): React.JSX.Element {
  const reducedMotion = useReducedMotion()
  const fraction = Math.min(1, Math.max(0, wpm / MAX_WPM))
  const arcLength = Math.PI * RADIUS

  const percentile = fasterThanPercentOfTypists(wpm)

  return (
    <div className="flex flex-col items-center">
      <svg
        viewBox={`0 0 ${SIZE.width} ${SIZE.height}`}
        className="w-full max-w-[176px]"
        role="img"
        aria-label={
          wpm > 0
            ? `${Math.round(wpm)} words per minute, faster than ${percentile}% of typists`
            : 'No speaking rate measured yet'
        }
      >
        {/* Track. */}
        <path
          d={semicircle()}
          fill="none"
          stroke="var(--color-line)"
          strokeWidth={STROKE}
          strokeLinecap="round"
        />
        {/* Value. Drawn as a dash offset rather than a second arc path so the
            two are guaranteed to be the same curve. */}
        <path
          d={semicircle()}
          fill="none"
          stroke="var(--color-accent)"
          strokeWidth={STROKE}
          strokeLinecap="round"
          strokeDasharray={arcLength}
          strokeDashoffset={arcLength * (1 - fraction)}
          style={
            reducedMotion
              ? undefined
              : { transition: 'stroke-dashoffset 600ms cubic-bezier(0.2, 0.8, 0.3, 1)' }
          }
        />
        <text
          x={CENTRE.x}
          y={CENTRE.y - 16}
          textAnchor="middle"
          className="fill-ink font-serif text-[28px] tabular-nums"
        >
          {wpm > 0 ? Math.round(wpm) : '—'}
        </text>
        <text
          x={CENTRE.x}
          y={CENTRE.y + 2}
          textAnchor="middle"
          className="fill-ink-muted text-[11px] font-medium"
        >
          words / min
        </text>
      </svg>

      <p className="mt-1 text-center text-[12px] leading-relaxed text-ink-muted">
        {wpm > 0 ? (
          <>
            Faster than <span className="font-medium text-ink">{percentile}%</span> of typists
          </>
        ) : (
          'Dictate something and your rate appears here.'
        )}
      </p>
    </div>
  )
}

/** Left-to-right semicircle over the top of {@link CENTRE}. */
function semicircle(): string {
  const start = `${CENTRE.x - RADIUS} ${CENTRE.y}`
  const end = `${CENTRE.x + RADIUS} ${CENTRE.y}`
  return `M ${start} A ${RADIUS} ${RADIUS} 0 0 1 ${end}`
}
