import type { ReactNode } from 'react'

export function Section({
  title,
  description,
  children,
}: {
  title: string
  description: string
  children?: ReactNode
}): React.JSX.Element {
  return (
    <section>
      <header className="mb-6">
        <h1 className="text-[22px] font-semibold tracking-tight text-ink">{title}</h1>
        <p className="mt-1.5 text-[13px] leading-relaxed text-ink-muted">{description}</p>
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
  className?: string
}): React.JSX.Element {
  return (
    <div className={`rounded-card border border-line bg-surface p-5 ${className}`.trim()}>
      {children}
    </div>
  )
}

/**
 * The "there is genuinely nothing here yet" state.
 *
 * Distinct from an error: an empty dictionary and a dictionary that failed to
 * load should never look the same, because only one of them is the user's fault
 * to fix.
 */
export function EmptyState({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <Card className="border-dashed">
      <p className="text-[13px] leading-relaxed text-ink-muted">{children}</p>
    </Card>
  )
}

export function ErrorCard({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <Card className="mb-5 border-warning/40">
      <p className="text-[13px] leading-relaxed text-warning">{children}</p>
    </Card>
  )
}

type ButtonVariant = 'primary' | 'secondary' | 'danger'

const BUTTON_STYLES: Record<ButtonVariant, string> = {
  primary: 'border-accent bg-accent text-surface hover:opacity-90',
  secondary: 'border-line bg-surface text-ink hover:border-ink-faint',
  danger: 'border-line bg-surface text-warning hover:border-warning/60',
}

export function Button({
  children,
  onClick,
  variant = 'secondary',
  disabled = false,
  type = 'button',
}: {
  children: ReactNode
  onClick?: () => void
  variant?: ButtonVariant
  disabled?: boolean
  type?: 'button' | 'submit'
}): React.JSX.Element {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={[
        'rounded-lg border px-3 py-1.5 text-[13px] font-medium transition-colors',
        'disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-line',
        BUTTON_STYLES[variant],
      ].join(' ')}
    >
      {children}
    </button>
  )
}

type BadgeTone = 'neutral' | 'positive' | 'warning' | 'accent'

const BADGE_TONES: Record<BadgeTone, string> = {
  neutral: 'border-line text-ink-muted',
  positive: 'border-positive/40 text-positive',
  warning: 'border-warning/40 text-warning',
  accent: 'border-accent/40 text-accent',
}

export function Badge({
  children,
  tone = 'neutral',
  title,
}: {
  children: ReactNode
  tone?: BadgeTone
  title?: string
}): React.JSX.Element {
  return (
    <span
      title={title}
      className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${BADGE_TONES[tone]}`}
    >
      {children}
    </span>
  )
}

/** Determinate when `value` is a 0..1 fraction; indeterminate-ish when null. */
export function ProgressBar({ value }: { value: number | null }): React.JSX.Element {
  const pct = value === null ? 100 : Math.round(Math.min(1, Math.max(0, value)) * 100)
  return (
    <div
      role="progressbar"
      aria-valuenow={value === null ? undefined : pct}
      aria-valuemin={0}
      aria-valuemax={100}
      className="h-1.5 w-full overflow-hidden rounded-full bg-line"
    >
      <div
        className={`h-full rounded-full bg-accent transition-[width] duration-200 ${
          value === null ? 'animate-pulse' : ''
        }`}
        style={{ width: `${pct}%` }}
      />
    </div>
  )
}

export function TextInput({
  value,
  onChange,
  placeholder,
  ariaLabel,
  onKeyDown,
}: {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  ariaLabel: string
  onKeyDown?: (event: React.KeyboardEvent<HTMLInputElement>) => void
}): React.JSX.Element {
  return (
    <input
      type="text"
      value={value}
      aria-label={ariaLabel}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={onKeyDown}
      className="w-full rounded-lg border border-line bg-surface px-2.5 py-1.5 text-[13px] text-ink outline-none placeholder:text-ink-faint focus:border-accent"
    />
  )
}

export function Stat({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div>
      <p className="text-[26px] font-semibold tracking-tight text-ink tabular-nums">{value}</p>
      <p className="mt-0.5 text-[12px] text-ink-muted">{label}</p>
    </div>
  )
}

export function Row({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: ReactNode
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-6 border-b border-line py-3 last:border-b-0">
      <div className="min-w-0">
        <p className="text-[13px] font-medium text-ink">{label}</p>
        {hint ? <p className="mt-0.5 text-[12px] text-ink-muted">{hint}</p> : null}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

export function Select<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T
  options: readonly { value: T; label: string }[]
  onChange: (value: T) => void
}): React.JSX.Element {
  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value as T)}
      className="rounded-lg border border-line bg-surface px-2.5 py-1.5 text-[13px] text-ink outline-none focus:border-accent"
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
