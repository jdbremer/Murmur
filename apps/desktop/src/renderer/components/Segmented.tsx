import { useRef } from 'react'

import { nextSegmentIndex } from '../design/segmented'

/**
 * A segmented control (PLAN §2.2.6) — two to four mutually exclusive choices,
 * all of them visible.
 *
 * Replaces the `<select>` in the places where the options were few enough to
 * show: a dropdown that has to be opened to find out it contains "Day / Week /
 * Month" is hiding three words behind a click, and hiding the current answer's
 * neighbours is exactly what makes a setting feel buried.
 *
 * It is a radio group, and behaves like one: one Tab stop for the whole
 * control, arrows to move between options, Home and End to reach the ends.
 * That is the ARIA pattern, and it is also what a Mac user's fingers already
 * expect from the same control in System Settings.
 *
 * The sliding indicator is positioned arithmetically rather than measured: the
 * grid gives every segment an equal share, so segment `i` starts at
 * `i × 100%` of one segment's width. No ResizeObserver, nothing to re-measure
 * when the window changes, and no first-frame flash at the wrong offset.
 */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  size = 'md',
}: {
  value: T
  options: readonly { value: T; label: string; title?: string }[]
  onChange: (value: T) => void
  /** Accessible name for the group as a whole. */
  label: string
  size?: 'sm' | 'md'
}): React.JSX.Element {
  const buttons = useRef<(HTMLButtonElement | null)[]>([])
  const selected = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  )

  const move = (event: React.KeyboardEvent): void => {
    const next = nextSegmentIndex(selected, event.key, options.length)
    // Null means the key was not ours — leaving it alone is what keeps Tab,
    // Enter and type-ahead working everywhere else on the page.
    if (next === null) return
    event.preventDefault()
    const option = options[next]
    if (!option) return
    onChange(option.value)
    buttons.current[next]?.focus()
  }

  const pad = size === 'sm' ? 'px-2.5 py-1 text-[12px]' : 'px-3 py-1.5 text-[13px]'

  return (
    <div
      role="radiogroup"
      aria-label={label}
      onKeyDown={move}
      className="relative grid rounded-lg border border-line bg-surface-sunken p-0.5"
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
    >
      {/* The indicator sits behind the labels and is the only thing that
          moves, so the text never re-renders or reflows as the choice changes. */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0.5 left-0.5 rounded-[7px] bg-surface elev-1 transition-transform duration-200 ease-out motion-reduce:transition-none"
        style={{
          width: `calc((100% - 0.25rem) / ${options.length})`,
          transform: `translateX(${selected * 100}%)`,
        }}
      />
      {options.map((option, index) => {
        const isSelected = index === selected
        return (
          <button
            key={option.value}
            ref={(element) => {
              buttons.current[index] = element
            }}
            type="button"
            role="radio"
            aria-checked={isSelected}
            title={option.title}
            // Roving tabindex: the group is one stop, and Tab out of it lands
            // on whatever follows rather than on the next segment.
            tabIndex={isSelected ? 0 : -1}
            onClick={() => onChange(option.value)}
            className={[
              'relative z-10 truncate rounded-[7px] font-medium transition-colors duration-150',
              pad,
              isSelected ? 'text-ink' : 'text-ink-muted hover:text-ink',
            ].join(' ')}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
