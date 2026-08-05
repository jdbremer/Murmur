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
 *  - Under Reduce Motion nothing animates. The component is not even mounted
 *    then — see `ReducedBarVisual` in Bar.tsx.
 */

export const CANVAS_WIDTH = 120
export const CANVAS_HEIGHT = BAR.height

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
      // Idle dots are static: paint them once and stop scheduling. A 60 fps
      // loop repainting an unchanging frame is pure battery drain, and the
      // shape-change effect below re-arms this loop when animation resumes.
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

  context.fillStyle = 'rgba(255,255,255,0.92)'
  for (let index = 0; index < heights.length; index += 1) {
    const height = heights[index] ?? BAR.waveformMinHeight
    const x = left + index * pitch
    roundedBar(context, x, middle - height / 2, BAR.waveformBarWidth, height)
  }
}

/**
 * Processing: the bars have collapsed into a single hairline, and a highlight
 * sweeps along it left → right (PLAN §2.1).
 */
function paintShimmer(context: CanvasRenderingContext2D, elapsedMs: number): void {
  const height = 2
  const width = 96
  const left = (CANVAS_WIDTH - width) / 2
  const top = (CANVAS_HEIGHT - height) / 2

  context.fillStyle = 'rgba(255,255,255,0.18)'
  roundedBar(context, left, top, width, height)

  const centre = left + shimmerPosition(elapsedMs) * width
  const gradient = context.createLinearGradient(centre - 26, 0, centre + 26, 0)
  gradient.addColorStop(0, 'rgba(255,255,255,0)')
  gradient.addColorStop(0.5, 'rgba(255,255,255,0.95)')
  gradient.addColorStop(1, 'rgba(255,255,255,0)')
  context.fillStyle = gradient
  roundedBar(context, left, top, width, height)
}

function paintDots(context: CanvasRenderingContext2D): void {
  const totalWidth = (IDLE_DOTS - 1) * IDLE_DOT_GAP
  const left = (CANVAS_WIDTH - totalWidth) / 2
  const middle = CANVAS_HEIGHT / 2
  context.fillStyle = 'rgba(255,255,255,0.34)'
  for (let index = 0; index < IDLE_DOTS; index += 1) {
    context.beginPath()
    context.arc(left + index * IDLE_DOT_GAP, middle, 1.1, 0, Math.PI * 2)
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
 * animated transform rather than another canvas.
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
      style={{ transformOrigin: 'center' }}
    >
      <path d="m5 12.5 4.5 4.5L19 7" />
    </svg>
  )
}
