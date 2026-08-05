import { useCallback, useEffect, useRef, useState } from 'react'

import type {
  AppInfo,
  AudioCaptureStatus,
  DictationEvent,
  EngineStatus,
  EnginesStatus,
} from '@murmur/shared'

import { Badge, Button, Card, ProgressBar, Row } from '../../components/Section'

/**
 * Unpackaged-only iteration controls (WINDOWS-HANDOFF Phase A).
 *
 * Drives the *real* dictation pipeline without a native hotkey, and surfaces
 * mic + engine status so Windows (and Mac) work can iterate visually.
 *
 * Kept in its own file so HelpSection stays short and Mac copy can evolve
 * without thrashing this panel.
 */

const HOLD_MS = 1500

export function DevToolsCard(): React.JSX.Element {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [engines, setEngines] = useState<EnginesStatus | null>(null)
  const [dictation, setDictation] = useState<DictationEvent | null>(null)
  const [capture, setCapture] = useState<AudioCaptureStatus | null>(null)
  const [level, setLevel] = useState(0)
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    void window.murmur.app
      .info()
      .then(setInfo)
      .catch(() => undefined)
    void window.murmur.engines
      .status()
      .then(setEngines)
      .catch(() => undefined)
    void window.murmur.dictation
      .getState()
      .then(setDictation)
      .catch(() => undefined)

    const unsubs = [
      window.murmur.engines.subscribe(setEngines),
      window.murmur.dictation.subscribe(setDictation),
      window.murmur.dictation.onLevel((event) => setLevel(event.level)),
      window.murmur.audio.onCaptureStatus(setCapture),
    ]
    return () => {
      for (const off of unsubs) off()
      if (holdTimer.current) clearTimeout(holdTimer.current)
    }
  }, [])

  const run = useCallback(async (label: string, action: () => Promise<void>) => {
    setNote(null)
    setBusy(true)
    try {
      await action()
      setNote(label)
    } catch (cause: unknown) {
      setNote(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }, [])

  const edge = useCallback(
    (action: 'down' | 'up' | 'doubleTap', label: string) =>
      run(label, () => window.murmur.debug.simulateHotkey({ action })),
    [run],
  )

  const holdThenRelease = useCallback(() => {
    void run(`Hold ${HOLD_MS} ms → release`, async () => {
      await window.murmur.debug.simulateHotkey({ action: 'down' })
      await new Promise<void>((resolve) => {
        holdTimer.current = setTimeout(resolve, HOLD_MS)
      })
      await window.murmur.debug.simulateHotkey({ action: 'up' })
    })
  }, [run])

  return (
    <Card className="mb-5">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <h2 className="text-[14px] font-semibold text-ink">Developer</h2>
        {info ? (
          <>
            <Badge tone="accent">{info.platform}</Badge>
            <Badge>{info.arch}</Badge>
            {info.isDev ? <Badge tone="positive">dev</Badge> : null}
          </>
        ) : null}
      </div>
      <p className="mb-4 text-[12px] leading-relaxed text-ink-muted">
        Unpackaged builds only. Real pipeline edges replace the native hotkey so you can exercise
        capture → STT → polish → insert without Input Monitoring or a Windows hook.
      </p>

      <Row label="Native" hint={info?.native ?? '…'}>
        <span className="select-text font-mono text-[11px] text-ink-muted">
          {info ? (info.native.startsWith('@murmur/native: active') ? 'active' : 'stub') : '—'}
        </span>
      </Row>

      <Row label="Dictation state">
        <Badge tone={dictationTone(dictation)}>{describeDictation(dictation)}</Badge>
      </Row>

      <Row label="STT engine" {...hintProps(engineHint(engines?.stt))}>
        <Badge tone={engineTone(engines?.stt)}>{engines?.stt.state ?? '—'}</Badge>
      </Row>
      <Row label="Polish engine" {...hintProps(engineHint(engines?.polish))}>
        <Badge tone={engineTone(engines?.polish)}>{engines?.polish.state ?? '—'}</Badge>
      </Row>

      <Row label="Microphone" {...hintProps(captureHint(capture))}>
        <Badge tone={captureTone(capture)}>{capture?.status ?? 'unknown'}</Badge>
      </Row>

      <Row label="Mic level" hint="Live amplitude while the capture stream is warm or listening.">
        <div className="w-40">
          <ProgressBar value={level} />
        </div>
      </Row>

      <div className="mt-4 border-t border-line pt-4">
        <p className="mb-2 text-[12px] font-medium text-ink">Real pipeline (hotkey edges)</p>
        <div className="flex flex-wrap gap-2">
          <Button disabled={busy} onClick={() => void edge('down', 'Hotkey down → listening')}>
            Hold (down)
          </Button>
          <Button disabled={busy} onClick={() => void edge('up', 'Hotkey up → finish')}>
            Release (up)
          </Button>
          <Button disabled={busy} onClick={() => void holdThenRelease()}>
            Hold {HOLD_MS / 1000}s then release
          </Button>
          <Button
            disabled={busy}
            onClick={() => void edge('doubleTap', 'Double-tap → hands-free')}
          >
            Double-tap
          </Button>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          disabled={busy}
          onClick={() =>
            void run('Bar tour finished', () => window.murmur.debug.simulateDictation())
          }
        >
          Bar state tour
        </Button>
        <Button
          disabled={busy}
          onClick={() => void run('Mic warm sent', () => window.murmur.debug.warmMic())}
        >
          Re-warm mic
        </Button>
        <Button disabled={busy} variant="danger" onClick={() => void window.murmur.dictation.cancel()}>
          Cancel
        </Button>
      </div>

      {note ? <p className="mt-3 text-[12px] text-ink-muted">{note}</p> : null}
      {capture?.status === 'error' ? (
        <p className="mt-2 text-[12px] text-warning">{capture.message}</p>
      ) : null}
    </Card>
  )
}

function describeDictation(event: DictationEvent | null): string {
  if (!event) return '—'
  switch (event.state) {
    case 'listening':
      return event.handsFree ? 'listening (hands-free)' : 'listening'
    case 'processing':
      return `processing (${event.stage})`
    case 'inserting':
      return 'inserting'
    case 'inserted':
      return `inserted (${event.charCount})`
    case 'error':
      return `error: ${event.code}`
    default:
      return event.state
  }
}

function dictationTone(
  event: DictationEvent | null,
): 'neutral' | 'positive' | 'warning' | 'accent' {
  if (!event) return 'neutral'
  if (event.state === 'error') return 'warning'
  if (event.state === 'inserted') return 'positive'
  if (event.state === 'idle') return 'neutral'
  return 'accent'
}

function engineTone(status: EngineStatus | undefined): 'neutral' | 'positive' | 'warning' {
  if (!status) return 'neutral'
  if (status.state === 'ready') return 'positive'
  if (status.state === 'unavailable' || status.state === 'error') return 'warning'
  return 'neutral'
}

function engineHint(status: EngineStatus | undefined): string | undefined {
  if (!status) return undefined
  const bits = [status.engine, status.modelId, status.reason, status.detail].filter(Boolean)
  return bits.length > 0 ? bits.join(' · ') : undefined
}

function captureTone(
  status: AudioCaptureStatus | null,
): 'neutral' | 'positive' | 'warning' {
  if (!status) return 'neutral'
  if (status.status === 'ready') return 'positive'
  if (status.status === 'error') return 'warning'
  return 'neutral'
}

function captureHint(status: AudioCaptureStatus | null): string | undefined {
  if (!status) return 'No status yet — try Re-warm mic.'
  if (status.status === 'ready') {
    return `device ${status.deviceId ?? 'default'} @ ${status.sampleRate} Hz`
  }
  if (status.status === 'error') return status.message
  return undefined
}

/** exactOptionalPropertyTypes: only pass `hint` when it is a real string. */
function hintProps(hint: string | undefined): { hint: string } | object {
  return hint === undefined ? {} : { hint }
}
