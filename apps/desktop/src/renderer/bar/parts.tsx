import type { AudioDevice } from '@murmur/shared'

import { BAR_SHADOW } from './visual'

/**
 * The chrome both indicator styles share.
 *
 * The pill and the corner orb are two drawings of one state machine, so the
 * hover controls, the microphone picker and the status dots are written once
 * here and positioned by whichever style is mounted. Only the geometry belongs
 * to the style; none of the behaviour does.
 */

/** Hover controls: cancel · mic picker · open Hub (PLAN §2.1). */
export function Controls({
  onCancel,
  onMic,
  onHub,
  menuOpen,
  className = '',
}: {
  onCancel: () => void
  onMic: () => void
  onHub: () => void
  menuOpen: boolean
  className?: string
}): React.JSX.Element {
  return (
    <div className={`bar-controls flex items-center gap-[3px] ${className}`.trim()}>
      <ControlButton label="Cancel dictation" onClick={onCancel} destructive>
        <path d="M6 6l12 12M18 6L6 18" />
      </ControlButton>
      <ControlButton label="Choose microphone" onClick={onMic} pressed={menuOpen}>
        <path d="M12 4a2.5 2.5 0 0 1 2.5 2.5v5a2.5 2.5 0 0 1-5 0v-5A2.5 2.5 0 0 1 12 4zM6 11a6 6 0 0 0 12 0M12 17v3" />
      </ControlButton>
      <ControlButton label="Open the Murmur hub" onClick={onHub}>
        <path d="M5 5h6M5 5v6M5 5l7 7M19 19h-6M19 19v-6M19 19l-7-7" />
      </ControlButton>
    </div>
  )
}

function ControlButton({
  label,
  onClick,
  pressed,
  destructive = false,
  children,
}: {
  label: string
  onClick: () => void
  pressed?: boolean
  /**
   * Throws the current utterance away. Warm on hover rather than always red:
   * three identical grey glyphs give the eye no way to tell the one that
   * discards your dictation from the two that do not — and it is the leftmost,
   * where the pointer arrives first.
   */
  destructive?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      onClick={onClick}
      className={[
        'grid size-[18px] cursor-pointer place-items-center rounded-full transition-all duration-150',
        'active:scale-90',
        destructive
          ? 'hover:bg-red-500/25 hover:text-red-200 active:bg-red-500/35'
          : 'hover:bg-white/15 hover:text-white active:bg-white/20',
        pressed ? 'bg-white/15 text-white' : 'text-white/70',
      ].join(' ')}
    >
      <svg
        viewBox="0 0 24 24"
        aria-hidden="true"
        className="size-[11px]"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {children}
      </svg>
    </button>
  )
}

/**
 * The mic picker, opening upward into the transparent space above the
 * indicator — which is why the Bar window is taller than anything it draws
 * (see main/windows/bar-layout.ts).
 */
export function MicMenu({
  panelRef,
  devices,
  selected,
  onSelect,
  className = '',
}: {
  /** Only where the menu is its own hit-test target — the corner style makes
   * the whole stack above the orb one region instead. */
  panelRef?: React.RefObject<HTMLDivElement | null>
  devices: AudioDevice[]
  selected: string | null
  onSelect: (deviceId: string | null) => void
  className?: string
}): React.JSX.Element {
  return (
    <div
      ref={panelRef}
      role="menu"
      aria-label="Microphone"
      className={`bar-pill bar-menu max-h-[150px] w-[240px] overflow-y-auto rounded-xl p-1 text-[11px] text-white/90 ${className}`.trim()}
      style={{
        background: 'rgba(19,19,24,0.96)',
        border: '1px solid rgba(255,255,255,0.10)',
        boxShadow: BAR_SHADOW,
        backdropFilter: 'blur(14px)',
      }}
    >
      <p className="px-2 pb-1 pt-1.5 text-[9px] font-semibold uppercase tracking-[0.08em] text-white/40">
        Microphone
      </p>
      <MicOption label="System default" active={selected === null} onClick={() => onSelect(null)} />
      {devices.map((device, index) => (
        <MicOption
          key={device.deviceId}
          label={device.label || `Microphone ${index + 1}`}
          active={selected === device.deviceId}
          onClick={() => onSelect(device.deviceId)}
        />
      ))}
      {devices.length === 0 ? (
        <p className="px-2 py-1.5 text-white/50">
          No microphones listed yet — grant access and they appear here.
        </p>
      ) : null}
    </div>
  )
}

function MicOption({
  label,
  active,
  onClick,
}: {
  label: string
  active: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={active}
      onClick={onClick}
      className={[
        'flex w-full cursor-pointer items-center gap-1.5 truncate rounded-lg px-2 py-1.5 text-left transition-colors duration-100',
        active ? 'bg-white/15 text-white' : 'text-white/80 hover:bg-white/10 active:bg-white/15',
      ].join(' ')}
    >
      <svg
        viewBox="0 0 24 24"
        aria-hidden="true"
        className={`size-[10px] shrink-0 ${active ? 'opacity-100' : 'opacity-0'}`}
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="m5 12.5 4.5 4.5L19 7" />
      </svg>
      <span className="truncate">{label}</span>
    </button>
  )
}

/**
 * The small state lights: hands-free, command mode, meeting recording.
 *
 * Each style places them itself — the pill puts them at its two ends, the orb
 * tucks them into the corner — but what they mean and how they are drawn is
 * fixed here so the two can never drift apart.
 */
export const STATUS_DOTS = {
  /** Latched hands-free dictation (PLAN §2.1). */
  handsFree: {
    title: 'Hands-free — tap your key again or press Esc to stop',
    colour: '#6ee7a8',
    glow: 'rgba(110,231,168,0.8)',
    pulse: true,
  },
  /** This utterance edits the selection instead of typing over it. */
  command: {
    title: 'Editing your selection — speak the instruction',
    colour: '#7aa2ff',
    glow: 'rgba(122,162,255,0.85)',
    pulse: true,
  },
  /**
   * A meeting is being recorded.
   *
   * Red and steady rather than pulsing: this is the universal "recording"
   * signal, and a blinking light is easier to mistake for an animation than for
   * a state. It is the only always-visible sign that other people are being
   * recorded, so `isBarVisible` forces the indicator on screen whenever it is
   * lit — including when the user has set the Bar to Hidden.
   */
  recording: {
    title: 'Recording this meeting',
    colour: '#f87171',
    glow: 'rgba(248,113,113,0.85)',
    pulse: false,
  },
} as const

export function StatusDot({
  kind,
  className = '',
  style,
}: {
  kind: keyof typeof STATUS_DOTS
  className?: string
  style?: React.CSSProperties
}): React.JSX.Element {
  const dot = STATUS_DOTS[kind]
  return (
    <span
      title={dot.title}
      className={`absolute size-[5px] rounded-full ${dot.pulse ? 'bar-dot-pulse' : ''} ${className}`.trim()}
      style={{ background: dot.colour, boxShadow: `0 0 6px ${dot.glow}`, ...style }}
    />
  )
}
