import { useEffect, useRef } from 'react'

import { barHeights, LevelEnvelope, shimmerPosition, WaveformHistory } from './level'
import { NUB, type BarShape } from './visual'

/**
 * The corner orb's interior, drawn on a canvas at 60 fps.
 *
 * Everything is polar. The origin is the screen corner itself — off in the very
 * bottom-left of the canvas box — and the three animated shapes are the pill's
 * three, bent around it:
 *
 *  - the idle dots become three faint marks on a small arc;
 *  - the listening waveform becomes a fan of rays, oldest at the bottom edge
 *    and newest at the top, so a syllable reads as a ripple travelling *around*
 *    the corner rather than across it;
 *  - the processing shimmer becomes a highlight sweeping along a thin arc.
 *
 * The canvas is a fixed {@link NUB.canvas} square while the *orb* animates its
 * radius around it under `overflow: hidden` — the same trick the pill uses, and
 * for the same two reasons: it is what makes the fan look like it emerges from
 * behind the screen edge, and it means nothing is re-measured during the morph.
 *
 * Mirroring for a bottom-right corner is done in CSS by the caller (the fan is
 * near enough symmetric that a flip is invisible), so this file only ever draws
 * the bottom-left case.
 */

const SIZE = NUB.canvas
/** Radians, measured up from the bottom edge. */
const SPAN_START = (NUB.spanStartDegrees * Math.PI) / 180
const SPAN_END = (NUB.spanEndDegrees * Math.PI) / 180

export interface NubCanvasProps {
  shape: BarShape
  /** Live 0..1 amplitude; read every frame, never rendered through React. */
  levelRef: React.RefObject<number>
  /** Restarts the shimmer phase and clears the history when the state changes. */
  epoch: number
}

export function NubCanvas({ shape, levelRef, epoch }: NubCanvasProps): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const envelopeRef = useRef(new LevelEnvelope())
  const historyRef = useRef(new WaveformHistory(NUB.rays))
  const shapeRef = useRef<BarShape>(shape)
  const startRef = useRef(0)

  useEffect(() => {
    shapeRef.current = shape
    startRef.current = 0
    if (shape === 'waveform') return
    historyRef.current.reset()
    envelopeRef.current.reset(0)
  }, [shape, epoch])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const context = canvas.getContext('2d')
    if (!context) return

    const ratio = Math.min(3, Math.max(1, window.devicePixelRatio || 1))
    canvas.width = Math.round(SIZE * ratio)
    canvas.height = Math.round(SIZE * ratio)
    context.scale(ratio, ratio)

    let frame = 0
    let previous = 0

    const draw = (timestamp: number): void => {
      // Idle dots are static: paint them once and stop scheduling. A loop
      // repainting an unchanging frame is pure battery drain, and the
      // shape-change effect above re-arms this loop when animation resumes.
      if (shapeRef.current === 'dots') {
        context.clearRect(0, 0, SIZE, SIZE)
        paintDots(context)
        previous = 0
        return
      }

      frame = requestAnimationFrame(draw)
      if (startRef.current === 0) startRef.current = timestamp
      const dt = previous === 0 ? 16 : Math.min(100, timestamp - previous)
      previous = timestamp
      const elapsed = timestamp - startRef.current

      const envelope = envelopeRef.current
      envelope.push(levelRef.current ?? 0)
      const level = envelope.advance(dt)

      context.clearRect(0, 0, SIZE, SIZE)
      switch (shapeRef.current) {
        case 'waveform': {
          historyRef.current.advance(dt, level)
          paintFan(context, historyRef.current.values())
          break
        }
        case 'shimmer':
          paintSweep(context, elapsed)
          break
        default:
          break
      }
    }

    frame = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(frame)
  }, [levelRef, shape])

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="pointer-events-none absolute bottom-0 left-0"
      style={{ width: SIZE, height: SIZE, display: 'block' }}
    />
  )
}

/** Canvas coordinates of the point `radius` from the corner at `angle`. */
function polar(radius: number, angle: number): [number, number] {
  return [radius * Math.cos(angle), SIZE - radius * Math.sin(angle)]
}

/** 0 at the ends of the span, 1 across the middle — the fan's angular taper. */
function edgeFade(t: number): number {
  const distance = Math.min(t, 1 - t)
  return Math.max(0, Math.min(1, distance / 0.12))
}

/**
 * An arc centred on the corner, with per-position opacity.
 *
 * Drawn as short segments rather than one stroke because opacity has to vary
 * *along* it, which a linear gradient cannot follow round a curve. Round caps
 * overlap just enough to hide the seams.
 */
function paintArc(
  context: CanvasRenderingContext2D,
  radius: number,
  width: number,
  alphaAt: (t: number) => number,
): void {
  const segments = 40
  context.lineWidth = width
  context.lineCap = 'round'
  for (let index = 0; index < segments; index += 1) {
    const from = index / segments
    const to = (index + 1) / segments
    const alpha = alphaAt((from + to) / 2)
    if (alpha <= 0.01) continue
    context.globalAlpha = alpha
    context.beginPath()
    // Canvas angles run clockwise on a y-down surface, so an elevation of θ
    // above the bottom edge is the canvas angle -θ, and rising means going
    // anticlockwise.
    context.arc(
      0,
      SIZE,
      radius,
      -(SPAN_START + (SPAN_END - SPAN_START) * from),
      -(SPAN_START + (SPAN_END - SPAN_START) * to),
      true,
    )
    context.stroke()
  }
  context.globalAlpha = 1
}

/** Listening: rays fanning out from the corner, newest at the top. */
function paintFan(context: CanvasRenderingContext2D, levels: readonly number[]): void {
  // The baseline the rays stand on, so the fan is seated rather than floating.
  context.strokeStyle = 'rgba(255,255,255,0.9)'
  paintArc(context, NUB.fanRadius, 1, (t) => 0.16 * edgeFade(t))

  const heights = barHeights(levels, { min: NUB.rayMinLength, max: NUB.rayMaxLength })
  // A cool cast at the tips fading to white at the base gives the rays the same
  // lit-from-within depth the pill's bars have.
  const gradient = context.createRadialGradient(
    0,
    SIZE,
    NUB.fanRadius,
    0,
    SIZE,
    NUB.fanRadius + NUB.rayMaxLength,
  )
  gradient.addColorStop(0, 'rgba(255,255,255,1)')
  gradient.addColorStop(1, 'rgba(205,213,255,0.85)')
  context.strokeStyle = gradient
  context.lineWidth = NUB.rayWidth
  context.lineCap = 'round'

  const last = Math.max(1, heights.length - 1)
  for (let index = 0; index < heights.length; index += 1) {
    const t = index / last
    const angle = SPAN_START + (SPAN_END - SPAN_START) * t
    const length = heights[index] ?? NUB.rayMinLength
    // Older rays fade as they rotate away; the leading edge stays brightest,
    // which is what makes the fan read as *travelling* rather than wobbling.
    context.globalAlpha = 0.38 + 0.6 * t
    context.beginPath()
    const [x0, y0] = polar(NUB.fanRadius, angle)
    const [x1, y1] = polar(NUB.fanRadius + length, angle)
    context.moveTo(x0, y0)
    context.lineTo(x1, y1)
    context.stroke()
  }
  context.globalAlpha = 1
}

/** Processing: the rays have collapsed into one arc, with a highlight running
 * along it (the pill's shimmer, bent round the corner). */
function paintSweep(context: CanvasRenderingContext2D, elapsedMs: number): void {
  const centre = shimmerPosition(elapsedMs)
  const reach = 0.28
  context.strokeStyle = 'rgba(255,255,255,1)'
  paintArc(context, NUB.arcRadius, 2, (t) => {
    const distance = Math.abs(t - centre)
    const highlight = distance < reach ? 0.95 * Math.pow(1 - distance / reach, 2) : 0
    return (0.2 + highlight) * edgeFade(t)
  })
}

/** Idle: a few dim marks on a small arc, hinting that the mic is there. */
function paintDots(context: CanvasRenderingContext2D): void {
  context.fillStyle = 'rgba(255,255,255,0.38)'
  const last = Math.max(1, NUB.idleDots - 1)
  for (let index = 0; index < NUB.idleDots; index += 1) {
    const angle = SPAN_START + (SPAN_END - SPAN_START) * (index / last)
    const [x, y] = polar(NUB.idleDotRadius, angle)
    context.beginPath()
    context.arc(x, y, 1.2, 0, Math.PI * 2)
    context.fill()
  }
}
