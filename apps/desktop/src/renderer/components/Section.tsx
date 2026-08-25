import type { ReactNode } from 'react'

import { surfaceClasses, type SurfaceOptions } from '../design/elevation'

export function Section({
  title,
  description,
  children,
  actions,
  fill = false,
}: {
  title: string
  description: string
  children?: ReactNode
  /** Right-aligned header controls, e.g. a "Check again" button. */
  actions?: ReactNode | undefined
  /**
   * App-like sections (Ask) own their scrolling: the header stays put and a
   * region inside the children scrolls. `fill` makes this section a column
   * that hands its children the remaining height — it only does something
   * when `App.tsx` has also put the section in `FILL_SECTIONS`, which is what
   * stops the *pane* from scrolling.
   */
  fill?: boolean
}): React.JSX.Element {
  return (
    <section className={fill ? 'flex h-full min-h-0 flex-col' : undefined}>
      <header className="mb-6 flex shrink-0 items-start justify-between gap-4">
        <div>
          {/* One per screen, and the label the content region is named by. */}
          <h1 id="section-title" className="text-[24px] font-semibold tracking-tight text-ink">
            {title}
          </h1>
          <p className="mt-1.5 text-[13px] leading-relaxed text-ink-muted">{description}</p>
        </div>
        {actions ? <div className="shrink-0 pt-1">{actions}</div> : null}
      </header>
      {children}
    </section>
  )
}

/**
 * A raised surface. Everything about how it looks comes from the elevation
 * scale — see `design/elevation.ts` for why the two themes get there by
 * different routes.
 */
export function Card({
  children,
  className = '',
  elevation,
  padding,
  tone,
  interactive,
}: { children: ReactNode; className?: string } & Pick<
  SurfaceOptions,
  'elevation' | 'padding' | 'tone' | 'interactive'
>): React.JSX.Element {
  return (
    <div className={surfaceClasses({ elevation, padding, tone, interactive, className })}>
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
 *
 * An empty state is also the most-seen screen in the app for exactly one user
 * — the one who just installed it — so it is worth more than a grey sentence
 * in a dashed box. Three parts, and the third is the one that earns its place:
 * a glyph so the space reads as designed rather than broken, a sentence saying
 * what would fill it, and a button that goes and does that. An empty state with
 * no way out of it is a dead end dressed as an explanation.
 */
export function EmptyState({
  icon,
  title,
  children,
  action,
}: {
  icon?: EmptyIconName | undefined
  title?: string | undefined
  children: ReactNode
  action?: ReactNode | undefined
}): React.JSX.Element {
  return (
    <div className={surfaceClasses({ tone: 'dashed', elevation: 0, padding: 'lg' })}>
      <div className="mx-auto flex max-w-sm flex-col items-center py-6 text-center">
        {icon ? <EmptyIcon name={icon} /> : null}
        {title ? <p className="mb-1.5 text-[14px] font-medium text-ink">{title}</p> : null}
        <p className="text-[13px] leading-relaxed text-ink-muted">{children}</p>
        {action ? <div className="mt-4 flex flex-wrap justify-center gap-2">{action}</div> : null}
      </div>
    </div>
  )
}

export type EmptyIconName =
  | 'history'
  | 'search'
  | 'dictionary'
  | 'snippets'
  | 'notes'
  | 'models'
  | 'meetings'
  | 'transcribe'
  | 'apps'

/**
 * Empty-state glyphs, drawn from the same 24×24 stroked vocabulary as the
 * sidebar so the illustration in a section matches the icon that got you there.
 */
const EMPTY_ICONS: Record<EmptyIconName, string> = {
  history: 'M12 21a9 9 0 1 0-8.9-10.4M12 7v5l3.5 2M3 4v4h4',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM16 16l5 5',
  dictionary: 'M5 4h11a2 2 0 0 1 2 2v14H7a2 2 0 0 1-2-2zm2 0v12h11',
  snippets: 'M13 3 5 14h6l-1 7 8-11h-6z',
  notes: 'M6 4h8l4 4v12H6zM14 4v4h4M9 13h6M9 16.5h4',
  models: 'M12 3 4 7.5v9L12 21l8-4.5v-9zM4 7.5 12 12l8-4.5M12 12v9',
  meetings:
    'M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zM8 10v4M12 8v8M16 11v2',
  transcribe: 'M6 4h8l4 4v12H6zM14 4v4h4M9 14v2.5M12 12.5v5.5M15 14v2.5',
  apps: 'M4 5h6v6H4zM14 5h6v6h-6zM4 15h6v6H4zM14 15h6v6h-6z',
}

function EmptyIcon({ name }: { name: EmptyIconName }): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      className="mb-3.5 grid size-11 place-items-center rounded-full bg-accent-soft text-accent"
    >
      <svg
        viewBox="0 0 24 24"
        className="size-[21px]"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d={EMPTY_ICONS[name]} />
      </svg>
    </span>
  )
}

export function Spinner(): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className="size-4 animate-spin text-ink-faint motion-reduce:hidden"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
    >
      <path d="M12 3a9 9 0 1 1-6.4 2.6" />
    </svg>
  )
}

/** A small stroked glyph, shared by the error/banner components. */
function ToneIcon({ tone }: { tone: 'danger' | 'warning' | 'accent' }): React.JSX.Element {
  const color =
    tone === 'danger' ? 'text-danger' : tone === 'accent' ? 'text-accent' : 'text-warning'
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className={`mt-px size-[15px] shrink-0 ${color}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {tone === 'accent' ? (
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 11v5M12 7.5h.01" />
        </>
      ) : (
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7.5v5.5M12 16.5h.01" />
        </>
      )}
    </svg>
  )
}

export function ErrorCard({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <Card tone="danger" className="mb-5">
      <div className="flex items-start gap-2.5" role="alert">
        <ToneIcon tone="danger" />
        <p className="text-[13px] leading-relaxed text-danger">{children}</p>
      </div>
    </Card>
  )
}

type ButtonVariant = 'primary' | 'secondary' | 'danger'

const BUTTON_STYLES: Record<ButtonVariant, string> = {
  primary: 'border-accent bg-accent text-surface shadow-xs hover:opacity-90',
  secondary: 'border-line bg-surface text-ink hover:border-ink-faint hover:bg-canvas',
  danger: 'border-line bg-surface text-danger hover:border-danger/50 hover:bg-danger/5',
}

export function Button({
  children,
  onClick,
  variant = 'secondary',
  disabled = false,
  type = 'button',
  title,
}: {
  children: ReactNode
  onClick?: () => void
  variant?: ButtonVariant
  disabled?: boolean
  type?: 'button' | 'submit'
  title?: string | undefined
}): React.JSX.Element {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={[
        'rounded-lg border px-3 py-1.5 text-[13px] font-medium transition-[background-color,border-color,transform,opacity] duration-150',
        'active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-line disabled:active:scale-100',
        BUTTON_STYLES[variant],
      ].join(' ')}
    >
      {children}
    </button>
  )
}

type BadgeTone = 'neutral' | 'positive' | 'warning' | 'accent' | 'danger'

const BADGE_TONES: Record<BadgeTone, string> = {
  neutral: 'border-line bg-canvas text-ink-muted',
  positive: 'border-positive/30 bg-positive/8 text-positive',
  warning: 'border-warning/30 bg-warning/8 text-warning',
  accent: 'border-accent/30 bg-accent/8 text-accent',
  danger: 'border-danger/30 bg-danger/8 text-danger',
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

/** Determinate when `value` is a 0..1 fraction; indeterminate when null. */
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
      {value === null ? (
        // No number to show, so show movement: a segment sweeping the track.
        <div className="progress-sweep h-full w-1/3 rounded-full bg-accent/70" />
      ) : (
        <div
          className="h-full rounded-full bg-accent transition-[width] duration-200"
          style={{ width: `${pct}%` }}
        />
      )}
    </div>
  )
}

export function TextInput({
  value,
  onChange,
  placeholder,
  ariaLabel,
  onKeyDown,
  inputRef,
}: {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  ariaLabel: string
  onKeyDown?: (event: React.KeyboardEvent<HTMLInputElement>) => void
  /** So a section can put the cursor here — see `useFocusShortcut`. */
  inputRef?: React.RefObject<HTMLInputElement | null> | undefined
}): React.JSX.Element {
  return (
    <input
      ref={inputRef}
      type="text"
      value={value}
      aria-label={ariaLabel}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={onKeyDown}
      className="w-full rounded-lg border border-line bg-surface px-2.5 py-1.5 text-[13px] text-ink outline-none transition-[border-color,box-shadow] duration-150 placeholder:text-ink-faint focus:border-accent focus:ring-2 focus:ring-accent/15"
    />
  )
}

export function Stat({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div>
      {/* Serif numerals — the reference product's stats signature. */}
      <p className="font-serif text-[26px] tracking-tight text-ink tabular-nums">{value}</p>
      <p className="mt-0.5 text-[12px] text-ink-muted">{label}</p>
    </div>
  )
}

export function Row({
  label,
  hint,
  children,
  htmlFor,
}: {
  label: string
  hint?: string | undefined
  children: ReactNode
  /** When the control is a labellable element, connect it for screen readers. */
  htmlFor?: string | undefined
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
  id,
  label,
}: {
  value: T
  options: readonly { value: T; label: string }[]
  onChange: (value: T) => void
  id?: string | undefined
  /** Accessible name for selects whose `Row` label is not linked via `id`. */
  label?: string | undefined
}): React.JSX.Element {
  return (
    <select
      id={id}
      aria-label={label}
      value={value}
      onChange={(event) => onChange(event.target.value as T)}
      className="rounded-lg border border-line bg-surface px-2.5 py-1.5 text-[13px] text-ink outline-none transition-[border-color,box-shadow] duration-150 hover:border-ink-faint focus:border-accent focus:ring-2 focus:ring-accent/15"
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
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
  const text =
    tone === 'danger' ? 'text-danger' : tone === 'accent' ? 'text-accent' : 'text-warning'
  return (
    <div className={surfaceClasses({ tone, padding: 'sm' })} role="status">
      <div className="flex items-start gap-2.5">
        <ToneIcon tone={tone} />
        <div className="min-w-0 flex-1">
          <p className={`text-[13px] font-medium ${text}`}>{title}</p>
          {children ? (
            <div className="mt-1 text-[12px] leading-relaxed text-ink-muted">{children}</div>
          ) : null}
          {actions ? <div className="mt-3 flex flex-wrap gap-2">{actions}</div> : null}
        </div>
      </div>
    </div>
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
      className="w-full select-text resize-y rounded-lg border border-line bg-surface px-2.5 py-2 text-[13px] leading-relaxed text-ink outline-none transition-[border-color,box-shadow] duration-150 placeholder:text-ink-faint focus:border-accent focus:ring-2 focus:ring-accent/15"
    />
  )
}

/** A one-line "that did not work" under a control, never a dialog. */
export function InlineError({ children }: { children: ReactNode }): React.JSX.Element | null {
  if (!children) return null
  return (
    <p
      role="alert"
      className="mb-4 flex items-start gap-1.5 text-[12px] leading-relaxed text-danger"
    >
      <svg
        viewBox="0 0 24 24"
        aria-hidden="true"
        className="mt-px size-[13px] shrink-0"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7.5v5.5M12 16.5h.01" />
      </svg>
      <span>{children}</span>
    </p>
  )
}

export function Toggle({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
  /** For settings this build cannot honour — the Row hint says why. */
  disabled?: boolean
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={[
        'h-[22px] w-[38px] rounded-full border transition-colors duration-200',
        checked ? 'border-accent bg-accent' : 'border-line bg-canvas hover:border-ink-faint',
        disabled ? 'cursor-not-allowed opacity-40' : '',
      ].join(' ')}
    >
      <span
        className={[
          'block size-[16px] rounded-full bg-surface shadow-sm ring-1 ring-black/5 transition-transform duration-200 ease-out',
          checked ? 'translate-x-[18px]' : 'translate-x-[2px]',
        ].join(' ')}
      />
    </button>
  )
}
