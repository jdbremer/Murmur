import { surfaceClasses } from '../design/elevation'
import { Sparkline } from './Sparkline'

/**
 * One headline number (PLAN §2.2.6), with the context that makes it mean
 * something.
 *
 * Murmur's stats signature is the serif numeral — it is what the History rail
 * and Insights already do, and it is the one place the app deliberately steps
 * outside the system font. This tile is that treatment made reusable, plus the
 * two things a bare number is missing: which way it is going, and what it has
 * been doing lately.
 *
 * The trend is optional and stays optional. A tile that has to invent a
 * comparison in order to have something to show is worse than a tile with a
 * number on it, so `trend` accepts null and simply renders nothing — a rise
 * from zero is not a percentage, and saying "+100%" because the arithmetic
 * allows it is how a stat becomes noise.
 */

export type StatTone = 'accent' | 'positive' | 'warning' | 'danger' | 'neutral'

const TONE_TEXT: Record<StatTone, string> = {
  accent: 'text-accent',
  positive: 'text-positive',
  warning: 'text-warning',
  danger: 'text-danger',
  neutral: 'text-ink-faint',
}

export function StatTile({
  label,
  value,
  unit,
  hint,
  trend,
  trendLabel = 'vs recent average',
  series,
  tone = 'accent',
  onClick,
}: {
  label: string
  value: string
  /** Set beside the numeral, small — "wpm", "words". */
  unit?: string | undefined
  hint?: string | undefined
  /** Percent change; sign decides the wording and the colour. */
  trend?: number | null | undefined
  /**
   * What the trend is measured against. Always stated, never implied: "+40%"
   * on its own is not a fact, and two tiles comparing against different
   * baselines look identical without it.
   */
  trendLabel?: string
  /** Recent readings, oldest first. */
  series?: readonly number[] | undefined
  tone?: StatTone
  onClick?: (() => void) | undefined
}): React.JSX.Element {
  const body = (
    <>
      <p className="text-[11px] font-semibold uppercase tracking-[0.07em] text-ink-faint">
        {label}
      </p>

      <div className="mt-2 flex items-baseline gap-1.5">
        <span className="font-serif text-[30px] leading-none tracking-tight text-ink tabular-nums">
          {value}
        </span>
        {unit ? <span className="text-[13px] text-ink-muted">{unit}</span> : null}
      </div>

      {trend !== null && trend !== undefined ? (
        <p
          className={`mt-1.5 flex items-center gap-1 text-[12px] ${
            trend >= 0 ? 'text-positive' : 'text-ink-muted'
          }`}
        >
          <Arrow up={trend >= 0} />
          {Math.abs(trend)}% <span className="text-ink-muted">{trendLabel}</span>
        </p>
      ) : null}

      {hint ? <p className="mt-1.5 text-[12px] text-ink-muted">{hint}</p> : null}

      {/* An all-zero series is not a chart of anything — it is a flat line
          restating the 0 already printed above it, and it reads as a broken
          graph rather than an honest one. The tile drops it entirely until
          there is a shape to show. */}
      {series && series.length > 1 && series.some((value) => value !== 0) ? (
        <div className={`mt-3 h-8 ${TONE_TEXT[tone]}`}>
          <Sparkline values={series} label={`${label} over the last ${series.length} days`} />
        </div>
      ) : null}
    </>
  )

  // A tile is only a button when it goes somewhere. Wrapping a static figure in
  // a button hands the keyboard a stop that does nothing when it gets there.
  if (!onClick) {
    return <div className={surfaceClasses({ padding: 'md' })}>{body}</div>
  }

  return (
    <button
      type="button"
      onClick={onClick}
      className={`${surfaceClasses({ padding: 'md', interactive: true })} w-full text-left active:scale-[0.995]`}
    >
      {body}
    </button>
  )
}

function Arrow({ up }: { up: boolean }): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className={`size-[13px] ${up ? '' : 'rotate-180'}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 19V6M6 12l6-6 6 6" />
    </svg>
  )
}
