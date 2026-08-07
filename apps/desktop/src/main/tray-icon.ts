import { nativeImage, type NativeImage } from 'electron'

/**
 * The menu-bar mark (PLAN §2.3): the pill's own waveform, at rest.
 *
 * Drawn here as pixels rather than shipped as a file, for the same reason the
 * cue is synthesised rather than sampled — the mark is five rectangles, and
 * five rectangles are smaller and more legible as code than as a pair of
 * base64 PNGs nobody can edit. It also means the 1x and 2x representations
 * cannot drift apart: both come from one function and one set of proportions.
 *
 * Two things make a menu-bar icon look native, and both are easy to get wrong:
 *
 *  1. **It is a template image.** Every pixel is black-on-alpha; macOS decides
 *     the colour, inverting it for dark menu bars and dimming it when the app
 *     is not frontmost. Baking in a colour is what makes third-party menu-bar
 *     icons look pasted on. The one exception is {@link TrayState.recording} —
 *     see below.
 *  2. **It is drawn on the pixel grid.** Bars are whole pixels wide at 1x and
 *     two whole pixels at 2x; anything else renders as a grey smear at the
 *     16 pt size the menu bar actually uses.
 */

/** Menu-bar icons are 16 pt; macOS asks for a 2x representation on Retina. */
const SIZE = 16

/**
 * Bar heights as a fraction of the icon, centred on the midline — the same
 * tapered profile as the app icon and the Hub's wordmark, so the three read as
 * one mark at three sizes.
 */
const BARS = [0.34, 0.62, 1, 0.62, 0.34] as const
/** While listening the outer bars lift: the mark leans into the shape the
 *  waveform makes when it hears something, without changing its footprint. */
const BARS_LISTENING = [0.62, 0.86, 1, 0.86, 0.62] as const

export type TrayState = 'idle' | 'listening' | 'recording'

/**
 * A template-mode tray image with 1x and 2x representations.
 *
 * `recording` is deliberately *not* a template image: a meeting being recorded
 * is the one thing the menu bar has to say in a colour, because it is a
 * consent signal rather than a status. Red is the convention every recorder on
 * this platform already uses, and it reads on both light and dark menu bars.
 */
export function createTrayIcon(state: TrayState = 'idle'): NativeImage {
  const icon = nativeImage.createEmpty()
  for (const scale of [1, 2]) {
    icon.addRepresentation({
      scaleFactor: scale,
      width: SIZE * scale,
      height: SIZE * scale,
      buffer: renderMark(state, scale),
    })
  }
  icon.setTemplateImage(state !== 'recording')
  return icon
}

/**
 * The mark as a BGRA buffer — the byte order `nativeImage` expects for a raw
 * bitmap representation.
 *
 * Painted by hand rather than through a canvas: the main process has no DOM,
 * and a five-rectangle glyph does not justify a native canvas dependency.
 */
function renderMark(state: TrayState, scale: number): Buffer {
  const size = SIZE * scale
  const buffer = Buffer.alloc(size * size * 4)

  const heights = state === 'listening' ? BARS_LISTENING : BARS
  const barWidth = scale // 1px at 1x, 2px at 2x — always whole pixels
  const gap = scale
  const pitch = barWidth + gap
  const totalWidth = BARS.length * pitch - gap
  // Recording shifts the waveform left to make room for the dot; the mark is
  // otherwise centred.
  const dotDiameter = state === 'recording' ? 4 * scale : 0
  const dotGap = state === 'recording' ? scale : 0
  const left = Math.round((size - (totalWidth + dotDiameter + dotGap)) / 2)
  const middle = size / 2
  // Tallest bar spans most of the icon, leaving a little breathing room so the
  // glyph does not touch the menu bar's own padding.
  const maxHeight = Math.round(size * 0.78)

  for (const [index, fraction] of heights.entries()) {
    const height = Math.max(scale, Math.round(maxHeight * fraction))
    const x = left + index * pitch
    const top = Math.round(middle - height / 2)
    fillRect(buffer, size, x, top, barWidth, height, BLACK)
  }

  if (state === 'recording') {
    const radius = dotDiameter / 2
    const cx = left + totalWidth + dotGap + radius
    fillCircle(buffer, size, cx, middle, radius, RED)
  }

  return buffer
}

/** Opaque black — the only colour a template image may contain. */
const BLACK = { b: 0, g: 0, r: 0 }
/** The recording dot. macOS will not recolour it: this image is not a template. */
const RED = { b: 60, g: 60, r: 235 }

interface Bgr {
  b: number
  g: number
  r: number
}

function fillRect(
  buffer: Buffer,
  size: number,
  x: number,
  y: number,
  width: number,
  height: number,
  colour: Bgr,
): void {
  for (let row = y; row < y + height; row += 1) {
    for (let column = x; column < x + width; column += 1) {
      setPixel(buffer, size, column, row, colour, 255)
    }
  }
}

/**
 * A filled circle with a one-pixel antialiased edge — enough to stop a 4 px
 * dot reading as a square without pulling in a rasteriser.
 */
function fillCircle(
  buffer: Buffer,
  size: number,
  cx: number,
  cy: number,
  radius: number,
  colour: Bgr,
): void {
  const from = Math.floor(cx - radius) - 1
  const to = Math.ceil(cx + radius) + 1
  for (let row = Math.floor(cy - radius) - 1; row <= Math.ceil(cy + radius) + 1; row += 1) {
    for (let column = from; column <= to; column += 1) {
      // Distance from the *centre* of the pixel, so the edge falls where the
      // eye expects it rather than half a pixel out.
      const dx = column + 0.5 - cx
      const dy = row + 0.5 - cy
      const distance = Math.sqrt(dx * dx + dy * dy)
      const coverage = Math.min(1, Math.max(0, radius + 0.5 - distance))
      if (coverage > 0) setPixel(buffer, size, column, row, colour, Math.round(coverage * 255))
    }
  }
}

function setPixel(
  buffer: Buffer,
  size: number,
  x: number,
  y: number,
  colour: Bgr,
  alpha: number,
): void {
  if (x < 0 || y < 0 || x >= size || y >= size) return
  const offset = (y * size + x) * 4
  buffer[offset] = colour.b
  buffer[offset + 1] = colour.g
  buffer[offset + 2] = colour.r
  buffer[offset + 3] = alpha
}
