import { useCallback, useEffect, useState } from 'react'

import type {
  EngineStatus,
  PermissionKind,
  PermissionState,
  PermissionsStatus,
  UpdateState,
} from '@murmur/shared'

import {
  Badge,
  Banner,
  Button,
  Card,
  InlineError,
  ProgressBar,
  Row,
  Section,
} from '../../components/Section'
import { useCaptureStatus } from '../../hooks/useCaptureStatus'
import { useDevMode } from '../../hooks/useDevMode'
import { useEngines } from '../../hooks/useEngines'
import { useSettings } from '../../hooks/useSettings'
import { engineLabel } from '../../format'
import { dataLocation, isMacPlatform } from '../../lib/platform'
import { PERMISSIONS } from '../permissions'
import { DevToolsCard } from './DevToolsCard'

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
  const [showDevTools, setShowDevTools] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const engines = useEngines()
  const capture = useCaptureStatus()
  const dev = useDevMode()
  const mac = isMacPlatform()
  // Read live, so the "what Murmur reads" answer below is the current one
  // rather than a claim about the shipped defaults.
  const { settings } = useSettings()

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
    void window.murmur.app
      .info()
      .then((info) => setShowDevTools(info.showDevTools))
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

      {capture?.status === 'error' ? (
        <div className="mb-5">
          <Banner tone="danger" title="The microphone is not working">
            {capture.message} Dictation will fail until this is fixed — the usual causes are a
            denied permission or another app holding the device.
          </Banner>
        </div>
      ) : null}

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
            // Microphone is read live from getMediaAccessStatus, so it updates
            // without a restart. These two are answered by the OS once per
            // process and cannot.
            needsRelaunch={
              permission.kind === 'accessibility' || permission.kind === 'inputMonitoring'
            }
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
        <UpdateRow />
        <Row
          label="Where your data lives"
          hint="History, settings, dictionary and downloaded models."
        >
          <span className="select-text font-mono text-[12px] text-ink-muted">{dataLocation()}</span>
        </Row>
        <Row
          label="Setup"
          hint="Walks through the permissions, a pair of models and one practice sentence again. Nothing is reset — it is the same screens, not a fresh install."
        >
          <Button onClick={() => void window.murmur.settings.set({ onboardingCompleted: false })}>
            Run setup again
          </Button>
        </Row>
        <Row
          label="Network activity"
          hint={
            settings?.updates.checkAutomatically
              ? 'Model downloads from Hugging Face and from Murmur\u2019s own GitHub releases, when you ask for them. One thing happens on its own: Murmur asks GitHub for the latest release on launch and every few hours, which tells GitHub your IP address and which version you run \u2014 and downloads it if that is switched on. Turn either off under Settings \u203a Updates. Nothing else: no telemetry, no accounts, no audio or text.'
              : 'Model downloads from Hugging Face and from Murmur\u2019s own GitHub releases, and updates from GitHub when you press the button. Nothing else \u2014 no telemetry, no accounts, nothing on a timer.'
          }
        >
          {settings?.updates.checkAutomatically ? (
            <Badge tone="neutral" title="Everything else happens only when you ask">
              Update checks only
            </Badge>
          ) : (
            <Badge tone="positive">Only when you ask</Badge>
          )}
        </Row>
        <Row
          label="Screen content"
          hint={
            settings?.vibeCoding.variableRecognition
              ? 'On: while you dictate into VS Code, Cursor or Windsurf, Murmur reads the open editor to recognise the names in it. Nothing is stored or logged, and no other app is ever read. Turn it off under Vibe coding.'
              : 'Murmur never reads your screen. The only thing it learns about the app you are dictating into is its name — unless you switch Variable recognition on under Vibe coding, which is off by default.'
          }
        >
          {settings?.vibeCoding.variableRecognition ? (
            <Badge tone="warning">Editors only</Badge>
          ) : (
            <Badge tone="positive">Never</Badge>
          )}
        </Row>
        {dev ? (
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
        ) : null}
      </Card>

      {showDevTools ? <DevToolsCard /> : null}
    </Section>
  )
}

/**
 * Check → download → restart, each a button the user presses.
 *
 * Split into three deliberately. Nothing polls, so Help's "nothing on a timer"
 * stays true; and finding out an update exists is separate from pulling a few
 * hundred megabytes, which is not a decision to make on someone's behalf.
 */
function UpdateRow(): React.JSX.Element {
  const [state, setState] = useState<UpdateState | null>(null)

  useEffect(() => {
    void window.murmur.app
      .updateState()
      .then(setState)
      .catch(() => undefined)
    // Download progress is pushed, so the bar animates without polling.
    return window.murmur.app.onUpdateChanged(setState)
  }, [])

  const status = state?.status ?? 'idle'
  const busy = status === 'checking' || status === 'downloading'

  return (
    <Row label="Updates" hint={updateHint(state)}>
      <div className="flex items-center gap-2">
        {status === 'downloading' ? (
          <div className="w-28">
            <ProgressBar value={(state?.percent ?? 0) / 100} />
          </div>
        ) : null}

        {status === 'available' ? (
          <Button
            variant="primary"
            onClick={() => void window.murmur.app.downloadUpdate().catch(() => undefined)}
          >
            Download {state?.latestVersion}
          </Button>
        ) : null}

        {status === 'downloaded' ? (
          <Button
            variant="primary"
            onClick={() => void window.murmur.app.installUpdate().catch(() => undefined)}
          >
            Restart to install
          </Button>
        ) : null}

        {/* Self-update is impossible here, so send them somewhere it works. */}
        {status === 'unsupported' ? (
          <Button
            onClick={() =>
              void window.murmur.app
                .openReleasePage({ url: state?.url ?? '' })
                .catch(() => undefined)
            }
          >
            Open releases
          </Button>
        ) : null}

        {status === 'downloaded' ? null : (
          <Button
            disabled={busy}
            onClick={() => void window.murmur.app.checkForUpdate().catch(() => undefined)}
          >
            {status === 'checking' ? 'Checking…' : 'Check for updates'}
          </Button>
        )}
      </div>
    </Row>
  )
}

function updateHint(state: UpdateState | null): string {
  if (!state || state.status === 'idle') {
    return 'Asks GitHub whether a newer release exists. Nothing is sent until you press it, and nothing checks on its own.'
  }
  switch (state.status) {
    case 'checking':
      return 'Asking GitHub…'
    case 'available':
      return `Version ${state.latestVersion} is available — you have ${state.currentVersion}. Downloading is a separate step, because it is a few hundred megabytes.`
    case 'downloading':
      return `Downloading ${state.latestVersion}… ${state.percent ?? 0}%. You can keep using Murmur; it installs when you restart.`
    case 'downloaded':
      return `Version ${state.latestVersion} is ready. Restarting replaces this copy and reopens Murmur.`
    case 'current':
      return `You have the latest release (${state.currentVersion}).`
    case 'none':
      return 'No release has been published yet, so there is nothing to compare against.'
    case 'unsupported':
      return `${state.message ?? 'This build cannot update itself.'} You can still download a new version by hand.`
    case 'error':
      return state.message ?? 'The update check did not succeed.'
  }
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
  needsRelaunch,
  onRequest,
  onOpenSettings,
}: {
  title: string
  why: string
  notDone: string
  state: PermissionState | undefined
  /**
   * True for the permissions macOS decides once per process (Accessibility,
   * Input Monitoring). Granting one while Murmur runs changes nothing it can
   * see, so re-checking is the wrong offer — restarting is the right one.
   */
  needsRelaunch: boolean
  onRequest: () => void
  onOpenSettings: () => void
}): React.JSX.Element {
  const badge = state ? PERMISSION_LABELS[state] : null
  const stale = needsRelaunch && state === 'denied'

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
          {stale ? (
            <p className="mt-2 max-w-lg text-[12px] leading-relaxed text-warning">
              Already switched this on in System Settings? macOS decides this one when the app
              starts, so Murmur cannot see the change until it restarts — checking again will keep
              saying denied.
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          <div className="flex gap-2">
            {state !== 'granted' && state !== 'unavailable' ? (
              <Button variant="primary" onClick={onRequest}>
                Allow
              </Button>
            ) : null}
            <Button onClick={onOpenSettings} disabled={state === 'unavailable'}>
              Open System Settings
            </Button>
          </div>
          {stale ? (
            <Button onClick={() => void window.murmur.app.relaunch().catch(() => undefined)}>
              Quit and reopen
            </Button>
          ) : null}
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
