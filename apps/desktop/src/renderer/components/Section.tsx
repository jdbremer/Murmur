import type { ReactNode } from 'react'

/**
 * The Hub's building blocks (PLAN §2.2).
 *
 * Hand-rolled on the semantic theme tokens rather than pulled from a component
 * library: the whole set is smaller than the dependency would be, and every
 * control here has to satisfy PLAN §15.5 anyway — a label, a visible focus
 * ring, and the same appearance in both themes. Colours are always tokens
 * (`bg-surface`, `text-ink-muted`), never `dark:` variants, because a theme
 * switch is a variable re-declaration (see theme.css).
 */

/** Shared by every focusable control, so a keyboard user always sees where they are. */
export const FOCUS_RING =
  'outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent'

export function Section({
  title,
  description,
  actions,
  children,
}: {
  title: string
  description: string
  actions?: ReactNode | undefined
  children?: ReactNode
}): React.JSX.Element {
  return (
    <section>
      <header className="mb-6 flex items-start justify-between gap-6">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight text-ink">{title}</h1>
          <p className="mt-1.5 max-w-xl text-[13px] leading-relaxed text-ink-muted">
            {description}
          </p>
        </div>
        {actions ? <div className="shrink-0 pt-1">{actions}</div> : null}
      </header>
      {children}
    </section>
  )
}

export function Card({
  children,
  className = '',
}: {
  children: ReactNode
  className?: string | undefined
}): React.JSX.Element {
  return (
    <div className={`rounded-card border border-line bg-surface p-5 ${className}`.trim()}>
      {children}
    </div>
  )
}

export function Stat({
  label,
  value,
  hint,
}: {
  label: string
  value: string
  hint?: string | undefined
}): React.JSX.Element {
  return (
    <div>
      <p className="text-[26px] font-semibold tracking-tight tabular-nums text-ink">{value}</p>
      <p className="mt-0.5 text-[12px] text-ink-muted">{label}</p>
      {hint ? <p className="mt-0.5 text-[11px] text-ink-faint">{hint}</p> : null}
    </div>
  )
}

export function Row({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string
  hint?: string | undefined
  /** Set when the control is a labelable element, so the label is clickable. */
  htmlFor?: string | undefined
  children: ReactNode
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-6 border-b border-line py-3 last:border-b-0">
      <div className="min-w-0">
        {htmlFor ? (
          <label htmlFor={htmlFor} className="text-[13px] font-medium text-ink">
            {label}
          </label>
        ) : (
          <p className="text-[13px] font-medium text-ink">{label}</p>
        )}
        {hint ? (
          <p className="mt-0.5 max-w-md text-[12px] leading-relaxed text-ink-muted">{hint}</p>
        ) : null}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

export function Select<T extends string>({
  value,
  options,
  onChange,
  label,
  id,
  className = '',
}: {
  value: T
  options: readonly { value: T; label: string }[]
  onChange: (value: T) => void
  /** Required when no visible `<label>` points at this control. */
  label?: string | undefined
  id?: string | undefined
  className?: string | undefined
}): React.JSX.Element {
  return (
    <select
      id={id}
      aria-label={label}
      value={value}
      onChange={(event) => onChange(event.target.value as T)}
      className={`rounded-lg border border-line bg-surface px-2.5 py-1.5 text-[13px] text-ink ${FOCUS_RING} ${className}`.trim()}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  )
}

export function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={[
        'h-[22px] w-[38px] rounded-full border transition-colors',
        checked ? 'border-accent bg-accent' : 'border-line bg-canvas',
        FOCUS_RING,
      ].join(' ')}
    >
      <span
        className={[
          'block size-[16px] rounded-full bg-surface transition-transform',
          checked ? 'translate-x-[18px]' : 'translate-x-[2px]',
        ].join(' ')}
      />
    </button>
  )
}

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

type ButtonTone = 'primary' | 'secondary' | 'ghost' | 'danger'

const BUTTON_TONES: Record<ButtonTone, string> = {
  primary: 'border-accent bg-accent text-surface hover:opacity-90',
  secondary: 'border-line bg-surface text-ink hover:bg-canvas',
  ghost: 'border-transparent bg-transparent text-ink-muted hover:bg-canvas hover:text-ink',
  danger: 'border-line bg-surface text-danger hover:bg-canvas',
}

export function Button({
  children,
  onClick,
  tone = 'secondary',
  disabled,
  type = 'button',
  title,
  label,
  className = '',
}: {
  children: ReactNode
  onClick?: () => void
  tone?: ButtonTone
  disabled?: boolean | undefined
  type?: 'button' | 'submit'
  title?: string | undefined
  /** Use when the visible text is not descriptive enough on its own. */
  label?: string | undefined
  className?: string | undefined
}): React.JSX.Element {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={label}
      className={[
        'rounded-lg border px-3 py-1.5 text-[13px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45',
        BUTTON_TONES[tone],
        FOCUS_RING,
        className,
      ]
        .join(' ')
        .trim()}
    >
      {children}
    </button>
  )
}

/** A square icon button — the row-level copy and delete affordances. */
export function IconButton({
  label,
  onClick,
  children,
  tone = 'ghost',
  disabled,
}: {
  label: string
  onClick: () => void
  children: ReactNode
  tone?: 'ghost' | 'danger'
  disabled?: boolean | undefined
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={[
        'grid size-7 place-items-center rounded-lg transition-colors disabled:opacity-40',
        tone === 'danger'
          ? 'text-ink-faint hover:bg-canvas hover:text-danger'
          : 'text-ink-faint hover:bg-canvas hover:text-ink',
        FOCUS_RING,
      ].join(' ')}
    >
      <svg
        viewBox="0 0 24 24"
        aria-hidden="true"
        className="size-[15px]"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {children}
      </svg>
    </button>
  )
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export function TextInput({
  value,
  onChange,
  placeholder,
  label,
  id,
  onKeyDown,
  className = '',
}: {
  value: string
  onChange: (value: string) => void
  placeholder?: string | undefined
  label: string
  id?: string | undefined
  onKeyDown?: ((event: React.KeyboardEvent<HTMLInputElement>) => void) | undefined
  className?: string | undefined
}): React.JSX.Element {
  return (
    <input
      id={id}
      type="text"
      value={value}
      aria-label={label}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={onKeyDown}
      className={`w-full select-text rounded-lg border border-line bg-surface px-2.5 py-1.5 text-[13px] text-ink placeholder:text-ink-faint ${FOCUS_RING} ${className}`.trim()}
    />
  )
}

export function TextArea({
  value,
  onChange,
  placeholder,
  label,
  id,
  rows = 3,
}: {
  value: string
  onChange: (value: string) => void
  placeholder?: string | undefined
  label: string
  id?: string | undefined
  rows?: number
}): React.JSX.Element {
  return (
    <textarea
      id={id}
      rows={rows}
      value={value}
      aria-label={label}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
      className={`w-full select-text resize-y rounded-lg border border-line bg-surface px-2.5 py-2 text-[13px] leading-relaxed text-ink placeholder:text-ink-faint ${FOCUS_RING}`}
    />
  )
}

export function SearchInput({
  value,
  onChange,
  placeholder,
  label,
}: {
  value: string
  onChange: (value: string) => void
  placeholder: string
  label: string
}): React.JSX.Element {
  return (
    <div className="relative">
      <svg
        viewBox="0 0 24 24"
        aria-hidden="true"
        className="pointer-events-none absolute left-3 top-1/2 size-[15px] -translate-y-1/2 text-ink-faint"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      >
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-3.5-3.5" />
      </svg>
      <input
        type="search"
        value={value}
        aria-label={label}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className={`w-full select-text rounded-lg border border-line bg-surface py-2 pl-9 pr-3 text-[13px] text-ink placeholder:text-ink-faint ${FOCUS_RING}`}
      />
    </div>
  )
}

/** A labelled control with an optional explanation underneath. */
export function Field({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string
  hint?: string | undefined
  htmlFor: string
  children: ReactNode
}): React.JSX.Element {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block text-[12px] font-medium text-ink">
        {label}
      </label>
      {children}
      {hint ? <p className="text-[11px] leading-relaxed text-ink-muted">{hint}</p> : null}
    </div>
  )
}

/**
 * A radio group that looks like a segmented control.
 *
 * A real `radiogroup` rather than a row of buttons, so a keyboard user gets the
 * behaviour they expect from one (PLAN §15.5).
 */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T
  options: readonly { value: T; label: string; hint?: string }[]
  onChange: (value: T) => void
  label: string
}): React.JSX.Element {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="inline-flex rounded-lg border border-line bg-canvas p-0.5"
    >
      {options.map((option) => {
        const active = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            title={option.hint}
            onClick={() => onChange(option.value)}
            className={[
              'rounded-[6px] px-2.5 py-1 text-[12px] font-medium transition-colors',
              active ? 'bg-surface text-ink shadow-sm' : 'text-ink-muted hover:text-ink',
              FOCUS_RING,
            ].join(' ')}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

type BadgeTone = 'neutral' | 'accent' | 'positive' | 'warning' | 'danger'

const BADGE_TONES: Record<BadgeTone, string> = {
  neutral: 'border-line text-ink-muted',
  accent: 'border-accent/40 bg-accent-soft text-accent',
  positive: 'border-positive/40 text-positive',
  warning: 'border-warning/40 text-warning',
  danger: 'border-danger/40 text-danger',
}

export function Badge({
  children,
  tone = 'neutral',
  title,
}: {
  children: ReactNode
  tone?: BadgeTone | undefined
  title?: string | undefined
}): React.JSX.Element {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${BADGE_TONES[tone]}`}
    >
      {children}
    </span>
  )
}

export function Banner({
  tone = 'warning',
  title,
  children,
  actions,
}: {
  tone?: 'warning' | 'danger' | 'accent'
  title: string
  children?: ReactNode
  actions?: ReactNode | undefined
}): React.JSX.Element {
  const border =
    tone === 'danger'
      ? 'border-danger/40'
      : tone === 'accent'
        ? 'border-accent/40'
        : 'border-warning/40'
  const text =
    tone === 'danger' ? 'text-danger' : tone === 'accent' ? 'text-accent' : 'text-warning'
  return (
    <div className={`rounded-card border ${border} bg-surface p-4`} role="status">
      <p className={`text-[13px] font-medium ${text}`}>{title}</p>
      {children ? (
        <div className="mt-1 text-[12px] leading-relaxed text-ink-muted">{children}</div>
      ) : null}
      {actions ? <div className="mt-3 flex flex-wrap gap-2">{actions}</div> : null}
    </div>
  )
}

export function EmptyState({
  title,
  children,
  actions,
}: {
  title: string
  children: ReactNode
  actions?: ReactNode | undefined
}): React.JSX.Element {
  return (
    <Card className="border-dashed text-center">
      <p className="text-[13px] font-medium text-ink">{title}</p>
      <p className="mx-auto mt-1.5 max-w-md text-[13px] leading-relaxed text-ink-muted">
        {children}
      </p>
      {actions ? <div className="mt-4 flex justify-center gap-2">{actions}</div> : null}
    </Card>
  )
}

export function ProgressBar({
  percent,
  label,
}: {
  percent: number
  label: string
}): React.JSX.Element {
  const clamped = Math.max(0, Math.min(100, percent))
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuenow={Math.round(clamped)}
      aria-valuemin={0}
      aria-valuemax={100}
      className="h-1.5 w-full overflow-hidden rounded-full bg-canvas"
    >
      <div
        className="h-full rounded-full bg-accent transition-[width] duration-200"
        style={{ width: `${clamped}%` }}
      />
    </div>
  )
}

/** A one-line "that did not work" under a control, never a dialog. */
export function InlineError({ children }: { children: ReactNode }): React.JSX.Element | null {
  if (!children) return null
  return (
    <p role="alert" className="mt-2 text-[12px] leading-relaxed text-danger">
      {children}
    </p>
  )
}
