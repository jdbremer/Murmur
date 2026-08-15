/**
 * The chrome both indicator styles share.
 *
 * Since the cluster redesign this is just the status dots: the hover controls
 * became the shared button cluster in Bar.tsx, and the mic picker lives there
 * with it. The dots stay here because the pill puts them at its two ends and
 * the orb tucks them into its corner, and what they *mean* must never drift
 * between the two drawings.
 */

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
