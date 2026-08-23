import { useId } from 'react'

import { sparkline, type SparklineOptions } from '../design/sparkline'

/**
 * A sparkline: an area, a line, and a marked endpoint.
 *
 * The area is what makes it readable at 28 pixels tall. A bare stroke at this
 * size reads as a squiggle; a filled one reads as a quantity, because the eye
 * gets the mass as well as the path. The endpoint dot exists because the last
 * reading is the only one anybody actually looks up — everything to its left
 * is context for it.
 *
 * Colour comes from `currentColor`, so a tile tints its own chart by setting a
 * text colour rather than by passing a hex down. Both themes then follow.
 */
export function Sparkline({
  values,
  width = 96,
  height = 28,
  label,
  className = '',
  ...options
}: {
  values: readonly number[]
  label: string
  className?: string
} & SparklineOptions): React.JSX.Element | null {
  const gradientId = useId()
  const geometry = sparkline(values, { width, height, ...options })
  if (!geometry) return null

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      // A chart is a picture of a number the tile has already stated in words;
      // the label is here for the case where it has not.
      role="img"
      aria-label={label}
      preserveAspectRatio="none"
      className={`h-full w-full overflow-visible ${className}`.trim()}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.22" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>

      {geometry.area ? <path d={geometry.area} fill={`url(#${gradientId})`} /> : null}
      <path
        d={geometry.line}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        // The line is drawn in a box that gets stretched by
        // `preserveAspectRatio="none"`; without this the stroke stretches too
        // and the left end comes out thicker than the right.
        vectorEffect="non-scaling-stroke"
      />
      <circle cx={geometry.last.x} cy={geometry.last.y} r="2" fill="currentColor" />
    </svg>
  )
}
