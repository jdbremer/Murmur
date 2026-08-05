import { useCallback, useEffect, useState } from 'react'

import type {
  EngineStatus,
  PermissionKind,
  PermissionState,
  PermissionsStatus,
} from '@murmur/shared'

import { Badge, Button, Card, InlineError, Row, Section } from '../../components/Section'
import { useEngines } from '../../hooks/useEngines'
import { engineLabel } from '../../format'
import { dataLocation, isMacPlatform } from '../../lib/platform'
import { PERMISSIONS } from '../permissions'

/**
 * Help (PLAN §2.2.6).
 *
 * Three questions, answered without hedging: what has Murmur been allowed to
 * do, what are its two engines actually doing, and where does it keep things.
 * Each permission card says what the permission is *not* used for, because on a
 * tool that reads a keyboard tap and types into other apps, that is the part a
 * careful user wants in writing.
 */
export function HelpSection(): React.JSX.Element {
  const [permissions, setPermissions] = useState<PermissionsStatus | null>(null)
  const [version, setVersion] = useState('—')
  const [error, setError] = useState<string | null>(null)
  const engines = useEngines()
  const mac = isMacPlatform()

  const refresh = useCallback(() => {
    void window.murmur.permissions
      .status()
      .then((value) => {
        setPermissions(value)
        setError(null)
      })
      .catch((cause: unknown) => setError(messageOf(cause)))
  }, [])

  useEffect(() => {
    refresh()
    void window.murmur.app
      .version()
      .then(setVersion)
      .catch(() => undefined)
  }, [refresh])

  const request = useCallback((kind: PermissionKind) => {
    void window.murmur.permissions
      .request({ kind })
      .then(setPermissions)
      .catch((cause: unknown) => setError(messageOf(cause)))
  }, [])

  const openSettings = useCallback((kind: PermissionKind) => {
    void window.murmur.permissions
      .openSystemSettings({ kind })
      .catch((cause: unknown) => setError(messageOf(cause)))
  }, [])

  return (
    <Section
      title="Help"
      description="What Murmur has been allowed to do, what its engines are doing, and where everything is kept."
      actions={<Button onClick={refresh}>Check again</Button>}
    >
      <InlineError>{error}</InlineError>

      {!mac ? (
        <Card className="mb-5 border-dashed">
          <p className="text-[13px] leading-relaxed text-ink-muted">
            These permissions are macOS concepts. On this platform they read “not applicable”, the
            event tap never starts and text insertion refuses — the rest of the app still runs,
            which is what makes it developable here.
          </p>
        </Card>
      ) : null}

      <div className="mb-6 space-y-2">
        {PERMISSIONS.map((permission) => (
          <PermissionCard
            key={permission.kind}
            title={permission.title}
            why={permission.why}
            notDone={permission.notDone}
            state={permissions?.[permission.kind]}
            onRequest={() => request(permission.kind)}
            onOpenSettings={() => openSettings(permission.kind)}
          />
        ))}
      </div>

      <h2 className="mb-2 text-[13px] font-semibold text-ink">Engines</h2>
      <div className="mb-6 space-y-2">
        <EngineCard title="Speech to text" status={engines?.stt ?? null} />
        <EngineCard title="Polishing" status={engines?.polish ?? null} />
      </div>

      <h2 className="mb-2 text-[13px] font-semibold text-ink">About</h2>
      <Card>
        <Row label="Version">
          <span className="select-text font-mono text-[12px] text-ink-muted">{version}</span>
        </Row>
        <Row
          label="Where your data lives"
          hint="History, settings, dictionary and downloaded models."
        >
          <span className="select-text font-mono text-[12px] text-ink-muted">{dataLocation()}</span>
        </Row>
        <Row
          label="Network activity"
          hint="Model downloads from Hugging Face, started by you. Nothing else — no telemetry, no accounts, no update pings."
        >
          <Badge tone="positive">Downloads only</Badge>
        </Row>
        <Row
          label="Simulate a dictation"
          hint="Runs the Bar through every state without a microphone or a model. Development builds only."
        >
          <Button
            onClick={() => {
              void window.murmur.debug.simulateDictation().catch((cause: unknown) => {
                setError(messageOf(cause))
              })
            }}
          >
            Run
          </Button>
        </Row>
      </Card>
    </Section>
  )
}

const PERMISSION_LABELS: Record<
  PermissionState,
  { label: string; tone: 'positive' | 'danger' | 'neutral' | 'warning' }
> = {
  granted: { label: 'Granted', tone: 'positive' },
  denied: { label: 'Denied', tone: 'danger' },
  unknown: { label: 'Not checked', tone: 'neutral' },
  unavailable: { label: 'Not applicable', tone: 'neutral' },
}

export function PermissionCard({
  title,
  why,
  notDone,
  state,
  onRequest,
  onOpenSettings,
}: {
  title: string
  why: string
  notDone: string
  state: PermissionState | undefined
  onRequest: () => void
  onOpenSettings: () => void
}): React.JSX.Element {
  const badge = state ? PERMISSION_LABELS[state] : null

  return (
    <Card>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-[14px] font-medium text-ink">
            {title}
            {badge ? <Badge tone={badge.tone}>{badge.label}</Badge> : null}
          </p>
          <p className="mt-1 max-w-lg text-[12px] leading-relaxed text-ink-muted">{why}</p>
          <p className="mt-1 max-w-lg text-[12px] leading-relaxed text-ink-faint">{notDone}</p>
        </div>
        <div className="flex shrink-0 gap-2">
          {state !== 'granted' && state !== 'unavailable' ? (
            <Button variant="primary" onClick={onRequest}>
              Allow
            </Button>
          ) : null}
          <Button onClick={onOpenSettings} disabled={state === 'unavailable'}>
            Open System Settings
          </Button>
        </div>
      </div>
    </Card>
  )
}

function EngineCard({
  title,
  status,
}: {
  title: string
  status: EngineStatus | null
}): React.JSX.Element {
  const tone =
    status?.state === 'ready'
      ? 'positive'
      : status?.state === 'error'
        ? 'danger'
        : status?.state === 'unavailable'
          ? 'warning'
          : 'neutral'

  return (
    <Card>
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-[14px] font-medium text-ink">{title}</p>
        <Badge tone={tone}>{status?.state ?? '—'}</Badge>
        {status?.engine ? <Badge tone="neutral">{engineLabel(status.engine)}</Badge> : null}
        {status?.modelId ? <Badge tone="neutral">{status.modelId}</Badge> : null}
        {status?.reason ? <Badge tone="warning">{status.reason}</Badge> : null}
      </div>
      {status?.detail ? (
        <p className="mt-2 select-text text-[12px] leading-relaxed text-ink-muted">
          {status.detail}
        </p>
      ) : null}
      {status && status.warnings.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {status.warnings.map((warning) => (
            <Badge key={warning} tone="warning" title={warning}>
              {warning}
            </Badge>
          ))}
        </div>
      ) : null}
    </Card>
  )
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
