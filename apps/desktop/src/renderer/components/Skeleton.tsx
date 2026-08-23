import { skeletonDelay, skeletonWidths } from '../design/skeleton'
import { surfaceClasses } from '../design/elevation'

/**
 * Skeletons (PLAN §2.2.6) — the shape of what is coming, while it comes.
 *
 * These replace the spinner-in-a-dashed-box that every section used to show.
 * A spinner says "something is happening"; a skeleton says "a list of
 * dictations is happening", and the difference is that the second one does not
 * make the page jump when the content lands, because the space was already the
 * right size.
 *
 * Accessibility is the part that is easy to lose in this swap. The old
 * `LoadingState` carried `role="status"` and the words "Loading your history…",
 * which is all a screen reader ever got from it. Every skeleton here keeps
 * exactly that — an announced status region — and marks the decorative bars
 * `aria-hidden`, so the swap is a visual upgrade and an accessibility no-op
 * rather than a silent regression.
 */

/**
 * One bar. Size it with utilities; it brings its own fill and shimmer.
 *
 * The stagger goes through a custom property rather than `animationDelay`
 * because the sweep lives on `.skeleton::after` — an `animation-delay` on the
 * element itself would apply to an element that has no animation, and every
 * bar would light up in lockstep.
 */
export function Skeleton({
  className = '',
  delayMs = 0,
  width,
}: {
  className?: string
  delayMs?: number
  /** Percent, for the bars whose length is data rather than a utility class. */
  width?: number
}): React.JSX.Element {
  // A plain string map, cast at the boundary: `CSSProperties` has no index
  // signature, so a custom property cannot be assigned into one directly.
  const style: Record<string, string> = {}
  if (delayMs) style['--skeleton-delay'] = `${delayMs}ms`
  if (width !== undefined) style.width = `${width}%`
  return (
    <div
      aria-hidden="true"
      className={`skeleton ${className}`.trim()}
      style={Object.keys(style).length > 0 ? (style as React.CSSProperties) : undefined}
    />
  )
}

/**
 * The wrapper every skeleton shares: an announced busy region.
 *
 * `aria-busy` as well as `role="status"` so assistive tech can tell the
 * difference between a region that is loading and one that just changed.
 */
function Busy({
  label,
  children,
  className = '',
}: {
  label: string
  children: React.ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <div role="status" aria-busy="true" aria-label={label} className={className}>
      {children}
    </div>
  )
}

/**
 * A list of records: the History / Dictionary / Snippets / Notes shape.
 *
 * `gutter` draws the fixed-width left column History uses for wall-clock time,
 * so the skeleton and the real list share a column edge and nothing shifts
 * sideways on arrival.
 */
export function SkeletonList({
  label,
  rows = 5,
  gutter = false,
  seed = 0,
}: {
  label: string
  rows?: number
  gutter?: boolean
  seed?: number
}): React.JSX.Element {
  const widths = skeletonWidths(rows, { seed, min: 50, max: 94 })
  return (
    <Busy label={label}>
      <div className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface-raised">
        {widths.map((width, index) => (
          <div key={index} className="flex items-start gap-4 px-4 py-3.5">
            {gutter ? <Skeleton className="mt-0.5 h-3 w-10 shrink-0" /> : null}
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton className="h-3" width={width} delayMs={skeletonDelay(index)} />
              {index % 3 === 0 ? (
                <Skeleton className="h-3" width={width * 0.6} delayMs={skeletonDelay(index) + 40} />
              ) : null}
            </div>
            <Skeleton className="mt-0.5 h-3 w-12 shrink-0" delayMs={skeletonDelay(index)} />
          </div>
        ))}
      </div>
    </Busy>
  )
}

/** Card grid: the Models / Insights shape. */
export function SkeletonCards({
  label,
  count = 4,
  columns = 2,
  height = 'h-28',
}: {
  label: string
  count?: number
  columns?: 1 | 2 | 3
  height?: string
}): React.JSX.Element {
  // Container queries, like the real grids these stand in for — a skeleton
  // that lays out differently from its content defeats the point of it.
  const grid = columns === 1 ? '' : columns === 3 ? '@xl:grid-cols-3' : '@xl:grid-cols-2'
  return (
    <Busy label={label}>
      <div className={`grid gap-4 ${grid}`.trim()}>
        {Array.from({ length: count }, (_, index) => (
          <div key={index} className={surfaceClasses({ padding: 'md' })}>
            <div className={`flex ${height} flex-col justify-between`}>
              <div className="space-y-2.5">
                <Skeleton className="h-3.5 w-1/3" delayMs={skeletonDelay(index)} />
                <Skeleton className="h-3" width={88} delayMs={skeletonDelay(index) + 40} />
                <Skeleton className="h-3" width={62} delayMs={skeletonDelay(index) + 80} />
              </div>
              <div className="flex gap-2">
                <Skeleton className="h-6 w-20 rounded-lg" delayMs={skeletonDelay(index)} />
                <Skeleton className="h-6 w-14 rounded-lg" delayMs={skeletonDelay(index) + 60} />
              </div>
            </div>
          </div>
        ))}
      </div>
    </Busy>
  )
}

/** Label-and-control rows: the Settings shape. */
export function SkeletonRows({
  label,
  rows = 4,
}: {
  label: string
  rows?: number
}): React.JSX.Element {
  const widths = skeletonWidths(rows, { seed: 7, min: 30, max: 55 })
  return (
    <Busy label={label}>
      <div className={surfaceClasses({ padding: 'md' })}>
        {widths.map((width, index) => (
          <div
            key={index}
            className="flex items-center justify-between gap-6 border-b border-line py-3.5 last:border-b-0"
          >
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton className="h-3" width={width} delayMs={skeletonDelay(index)} />
              <Skeleton className="h-3" width={width * 1.5} delayMs={skeletonDelay(index) + 40} />
            </div>
            <Skeleton className="h-[22px] w-[38px] shrink-0 rounded-full" />
          </div>
        ))}
      </div>
    </Busy>
  )
}
