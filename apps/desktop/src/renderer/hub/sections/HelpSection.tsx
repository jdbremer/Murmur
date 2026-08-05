import { useCallback, useEffect, useState } from 'react'

import type { PermissionState, PermissionsStatus } from '@murmur/shared'

import { Card, Row, Section } from '../../components/Section'

/** Help (PLAN §2.2.6) — permission status, plus the developer escape hatches. */
export function HelpSection(): React.JSX.Element {
  const [permissions, setPermissions] = useState<PermissionsStatus | null>(null)
  const [version, setVersion] = useState<string>('—')
  const [note, setNote] = useState<string | null>(null)

  const refresh = useCallback(() => {
    void window.murmur.permissions
      .status()
      .then(setPermissions)
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    refresh()
    void window.murmur.app
      .version()
      .then(setVersion)
      .catch(() => undefined)
  }, [refresh])

  const simulate = useCallback(() => {
    setNote(null)
    void window.murmur.debug.simulateDictation().catch((cause: unknown) => {
      setNote(cause instanceof Error ? cause.message : String(cause))
    })
  }, [])

  return (
    <Section
      title="Help"
      description="What Murmur needs from macOS, and what it deliberately does not do."
    >
      <Card className="mb-5">
        <Row label="Microphone" hint="Capturing what you say. Audio never leaves this machine.">
          <PermissionBadge state={permissions?.microphone} />
        </Row>
        <Row label="Accessibility" hint="Typing the finished text into the app you are using.">
          <PermissionBadge state={permissions?.accessibility} />
        </Row>
        <Row
          label="Input Monitoring"
          hint="Watching for your dictation key only — no other keystroke is read."
        >
          <PermissionBadge state={permissions?.inputMonitoring} />
        </Row>
        <Row label="Re-check">
          <button
            type="button"
            onClick={refresh}
            className="rounded-lg border border-line px-3 py-1.5 text-[13px] text-ink hover:bg-canvas"
          >
            Check again
          </button>
        </Row>
      </Card>

      <Card>
        <Row label="Version">
          <span className="select-text font-mono text-[12px] text-ink-muted">{version}</span>
        </Row>
        <Row
          label="Simulate a dictation"
          hint="Runs the Bar through every state. Development builds only."
        >
          <button
            type="button"
            onClick={simulate}
            className="rounded-lg border border-line px-3 py-1.5 text-[13px] text-ink hover:bg-canvas"
          >
            Run
          </button>
        </Row>
        {note ? <p className="pt-3 text-[12px] text-warning">{note}</p> : null}
      </Card>
    </Section>
  )
}

const LABELS: Record<PermissionState, string> = {
  granted: 'Granted',
  denied: 'Denied',
  unknown: 'Not checked',
  unavailable: 'Not applicable',
}

function PermissionBadge({ state }: { state: PermissionState | undefined }): React.JSX.Element {
  if (!state) return <span className="text-[12px] text-ink-faint">—</span>
  const tone =
    state === 'granted' ? 'text-positive' : state === 'denied' ? 'text-warning' : 'text-ink-muted'
  return <span className={`text-[12px] font-medium ${tone}`}>{LABELS[state]}</span>
}
