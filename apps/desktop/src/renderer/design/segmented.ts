/**
 * Keyboard movement inside a segmented control.
 *
 * A segmented control is a radio group, and a radio group moves selection with
 * the arrow keys rather than Tab — Tab leaves the group entirely. Split out
 * because "which index does ArrowLeft land on" is a wrapping-arithmetic
 * question with an off-by-one at each end, and that is worth a test rather
 * than a squint.
 */

/**
 * The index `key` moves to, or `null` when the key is not ours to handle —
 * which the caller must treat as "do not preventDefault", or Home and End stop
 * working everywhere else on the page.
 *
 * Both axes are accepted: a segmented control is horizontal, but a screen
 * reader user arrowing vertically through a form should not hit a dead control.
 */
export function nextSegmentIndex(current: number, key: string, count: number): number | null {
  if (count <= 0) return null
  const index = Math.max(0, Math.min(count - 1, current))
  switch (key) {
    case 'ArrowLeft':
    case 'ArrowUp':
      return (index - 1 + count) % count
    case 'ArrowRight':
    case 'ArrowDown':
      return (index + 1) % count
    case 'Home':
      return 0
    case 'End':
      return count - 1
    default:
      return null
  }
}
