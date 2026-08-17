import { useEffect, useRef } from 'react'

import {
  barHeights,
  checkPulseScale,
  LevelEnvelope,
  shimmerPosition,
  WaveformHistory,
} from './level'
import { BAR, type BarShape } from './visual'

/**
 * The pill's interior, drawn on a canvas at 60 fps (PLAN §2.1).
 *
 * One canvas covers three of the five shapes — the idle dots, the listening
 * waveform and the processing shimmer — because they are the same object in
 * different states and drawing them in one place is what lets them morph into
 * each other instead of swapping.
 *
 * Deliberate design choices worth knowing:
 *
 *  - The canvas is a fixed 120 × 22 CSS px, centred, while the *pill* animates
 *    its width around it under `overflow: hidden`. That is what makes the
 *    waveform look like it grows out of the capsule, and it means no
 *    `ResizeObserver` fires 60 times a second during a 150 ms morph.
 *  - The level arrives through a ref, not through props: a 30 Hz prop update
 *    would re-render React for something only the canvas can see.
 *  - The idle dots are static — painted once, no scheduled frames. An idle
 *    pill must be perfectly still (and cost nothing while it is).
 *  - Under Reduce Motion nothing animates. The component is not even mounted
 *    then — see `StaticLevel` in Bar.tsx.
 */

export const CANVAS_WIDTH = 120
export const CANVAS_HEIGHT = BAR.activeHeight

/** Idle: a few dim dots hinting at the mic (PLAN §2.1). */
const IDLE_DOTS = 5
const IDLE_DOT_GAP = 7

export interface BarCanvasProps {
  shape: BarShape
  /** Live 0..1 amplitude; read every frame, never rendered through React. */
  levelRef: React.RefObject<number>
  /** Restarts the ✓ pulse and the shimmer phase when the state changes. */
  epoch: number
}

export function BarCanvas({ shape, levelRef, epoch }: BarCanvasProps): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const envelopeRef = useRef(new LevelEnvelope())
  const historyRef = useRef(new WaveformHistory())
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
    canvas.width = Math.round(CANVAS_WIDTH * ratio)
    canvas.height = Math.round(CANVAS_HEIGHT * ratio)
    context.scale(ratio, ratio)

    let frame = 0
    let previous = 0

    const draw = (timestamp: number): void => {
      // Idle dots are static: paint them once and stop scheduling. A loop
      // repainting an unchanging frame is pure battery drain, and the
      // shape-change effect above re-arms this loop when animation resumes.
      if (shapeRef.current === 'dots') {
        context.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT)
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

      context.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT)
      switch (shapeRef.current) {
        case 'waveform': {
          historyRef.current.advance(dt, level)
          paintWaveform(context, historyRef.current.values())
          break
        }
        case 'shimmer':
          paintShimmer(context, elapsed)
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
      style={{ width: CANVAS_WIDTH, height: CANVAS_HEIGHT, display: 'block' }}
    />
  )
}

function paintWaveform(context: CanvasRenderingContext2D, levels: readonly number[]): void {
  const heights = barHeights(levels)
  const pitch = BAR.waveformBarWidth + BAR.waveformBarGap
  const totalWidth = levels.length * pitch - BAR.waveformBarGap
  const left = (CANVAS_WIDTH - totalWidth) / 2
  const middle = CANVAS_HEIGHT / 2
  const last = Math.max(1, heights.length - 1)

  // A cool cast at the tips fading to pure white at the centreline gives the
  // bars a lit-from-within depth that flat white lacks.
  const gradient = context.createLinearGradient(
    0,
    middle - BAR.waveformMaxHeight / 2,
    0,
    middle + BAR.waveformMaxHeight / 2,
  )
  gradient.addColorStop(0, 'rgba(205,213,255,0.9)')
  gradient.addColorStop(0.5, 'rgba(255,255,255,1)')
  gradient.addColorStop(1, 'rgba(205,213,255,0.9)')
  context.fillStyle = gradient

  for (let index = 0; index < heights.length; index += 1) {
    const height = heights[index] ?? BAR.waveformMinHeight
    const x = left + index * pitch
    // Older bars fade as they scroll away; the leading edge stays brightest,
    // which is what makes the waveform read as *moving* rather than wiggling.
    context.globalAlpha = 0.38 + 0.6 * (index / last)
    roundedBar(context, x, middle - height / 2, BAR.waveformBarWidth, height)
  }
  context.globalAlpha = 1
}

/**
 * Processing: the bars have collapsed into a single hairline, and a highlight
 * sweeps along it left → right (PLAN §2.1). The baseline fades out at its ends
 * so it appears to condense out of the capsule rather than being clipped by it.
 */
function paintShimmer(context: CanvasRenderingContext2D, elapsedMs: number): void {
  const height = 2
  // Narrower than the processing capsule (92) with room to spare. It used to
  // be 96 against a 120 px pill; left at that, the narrower capsule would clip
  // the hairline's faded ends and the sweep would appear to start and stop
  // abruptly at a hard edge instead of condensing out of the glass.
  const width = 68
  const left = (CANVAS_WIDTH - width) / 2
  const top = (CANVAS_HEIGHT - height) / 2

  const base = context.createLinearGradient(left, 0, left + width, 0)
  base.addColorStop(0, 'rgba(255,255,255,0)')
  base.addColorStop(0.12, 'rgba(255,255,255,0.20)')
  base.addColorStop(0.88, 'rgba(255,255,255,0.20)')
  base.addColorStop(1, 'rgba(255,255,255,0)')
  context.fillStyle = base
  roundedBar(context, left, top, width, height)

  const centre = left + shimmerPosition(elapsedMs) * width
  const highlight = context.createLinearGradient(centre - 22, 0, centre + 22, 0)
  highlight.addColorStop(0, 'rgba(255,255,255,0)')
  highlight.addColorStop(0.5, 'rgba(255,255,255,0.95)')
  highlight.addColorStop(1, 'rgba(255,255,255,0)')
  context.fillStyle = highlight
  roundedBar(context, left, top, width, height)
}

function paintDots(context: CanvasRenderingContext2D): void {
  const totalWidth = (IDLE_DOTS - 1) * IDLE_DOT_GAP
  const left = (CANVAS_WIDTH - totalWidth) / 2
  const middle = CANVAS_HEIGHT / 2
  context.fillStyle = 'rgba(255,255,255,0.38)'
  for (let index = 0; index < IDLE_DOTS; index += 1) {
    context.beginPath()
    context.arc(left + index * IDLE_DOT_GAP, middle, 1.2, 0, Math.PI * 2)
    context.fill()
  }
}

function roundedBar(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  const radius = Math.min(width, height) / 2
  context.beginPath()
  context.roundRect(x, y, width, height, radius)
  context.fill()
}

/**
 * The ✓ pulse (PLAN §2.1 "Inserted"). Small enough to be an SVG with an
 * animated transform rather than another canvas. Tinted the same green as the
 * capsule's success glow, with a soft halo of its own.
 */
export function CheckPulse({ reducedMotion }: { reducedMotion: boolean }): React.JSX.Element {
  const ref = useRef<SVGSVGElement | null>(null)

  useEffect(() => {
    const element = ref.current
    if (!element || reducedMotion) return
    let frame = 0
    let start = 0
    const step = (timestamp: number): void => {
      if (start === 0) start = timestamp
      const scale = checkPulseScale(timestamp - start)
      element.style.transform = `scale(${scale.toFixed(3)})`
      if (timestamp - start < 340) frame = requestAnimationFrame(step)
    }
    frame = requestAnimationFrame(step)
    return () => cancelAnimationFrame(frame)
  }, [reducedMotion])

  return (
    <svg
      ref={ref}
      viewBox="0 0 24 24"
      aria-hidden="true"
      width={14}
      height={14}
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{
        transformOrigin: 'center',
        color: '#86efac',
        filter: 'drop-shadow(0 0 5px rgba(110,231,168,0.55))',
      }}
    >
      {/* pathLength=1 normalises the dash space so the draw-on keyframes in
          bar.css can speak in fractions instead of measured pixels. */}
      <path d="m5 12.5 4.5 4.5L19 7" pathLength={1} className="bar-check-draw" />
    </svg>
  )
}
