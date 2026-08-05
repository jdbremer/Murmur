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

/** Marks UI whose backing implementation lands in a later stage. */
export function ComingSoon({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <Card className="border-dashed">
      <p className="text-[13px] leading-relaxed text-ink-muted">{children}</p>
    </Card>
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
