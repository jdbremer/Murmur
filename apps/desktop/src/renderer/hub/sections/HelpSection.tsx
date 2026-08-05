import { useCallback, useEffect, useState } from 'react'

import type { AppInfo, PermissionState, PermissionsStatus } from '@murmur/shared'

import { Card, Row, Section } from '../../components/Section'
import { DevToolsCard } from './DevToolsCard'

/**
 * Help (PLAN §2.2.6) — permission status, plus the developer escape hatches.
 *
 * Permissions copy branches on platform so Windows does not show macOS TCC
 * rituals (WINDOWS-HANDOFF Phase B starts here; full Settings hotkey lists follow).
 */

export function HelpSection(): React.JSX.Element {
  const [permissions, setPermissions] = useState<PermissionsStatus | null>(null)
  const [info, setInfo] = useState<AppInfo | null>(null)

  const refresh = useCallback(() => {
    void window.murmur.permissions
      .status()
      .then(setPermissions)
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    refresh()
    void window.murmur.app
      .info()
      .then(setInfo)
      .catch(() => {
        // Older preload without app.info — fall back to version only.
        void window.murmur.app
          .version()
          .then((version) =>
            setInfo({
              version,
              platform: 'unknown',
              arch: 'unknown',
              isDev: true,
              native: 'unknown',
            }),
          )
          .catch(() => undefined)
      })
  }, [refresh])

  const isWindows = info?.platform === 'win32'
  const isMac = info?.platform === 'darwin'

  return (
    <Section title="Help" description={helpDescription(info)}>
      {info?.isDev ? <DevToolsCard /> : null}

      <Card className="mb-5">
        {isWindows ? <WindowsPermissions permissions={permissions} onRefresh={refresh} /> : null}
        {isMac || !info ? <MacPermissions permissions={permissions} onRefresh={refresh} /> : null}
        {!isWindows && !isMac && info ? (
          <Row label="Permissions">
            <span className="text-[12px] text-ink-muted">
              This platform reports OS permission APIs as unavailable; microphone access is handled
              by the browser/Electron prompt when capture starts.
            </span>
          </Row>
        ) : null}
      </Card>

      <Card>
        <Row label="Version">
          <span className="select-text font-mono text-[12px] text-ink-muted">
            {info?.version ?? '—'}
            {info ? ` · ${info.platform}/${info.arch}` : ''}
          </span>
        </Row>
        <Row label="Native module">
          <span className="select-text font-mono text-[11px] leading-snug text-ink-muted">
            {info?.native ?? '—'}
          </span>
        </Row>
      </Card>
    </Section>
  )
}

function helpDescription(info: AppInfo | null): string {
  if (info?.platform === 'win32') {
    return 'What Murmur needs on Windows, and tools for local development.'
  }
  if (info?.platform === 'darwin') {
    return 'What Murmur needs from macOS, and what it deliberately does not do.'
  }
  return 'Permissions, version, and development tools.'
}

function MacPermissions({
  permissions,
  onRefresh,
}: {
  permissions: PermissionsStatus | null
  onRefresh: () => void
}): React.JSX.Element {
  return (
    <>
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
          onClick={onRefresh}
          className="rounded-lg border border-line px-3 py-1.5 text-[13px] text-ink hover:bg-canvas"
        >
          Check again
        </button>
      </Row>
    </>
  )
}

function WindowsPermissions({
  permissions,
  onRefresh,
}: {
  permissions: PermissionsStatus | null
  onRefresh: () => void
}): React.JSX.Element {
  return (
    <>
      <Row
        label="Microphone"
        hint="Windows privacy settings + the in-app prompt. Audio never leaves this machine."
      >
        <PermissionBadge state={permissions?.microphone} />
      </Row>
      <Row
        label="Global hotkey / paste"
        hint="Provided by Murmur’s native helper when built for Windows — not separate OS toggles like on macOS."
      >
        <span className="text-[12px] text-ink-muted">
          {permissions?.accessibility === 'unavailable'
            ? 'Native helper not loaded yet (stub).'
            : 'See native status below.'}
        </span>
      </Row>
      <Row label="Re-check">
        <button
          type="button"
          onClick={onRefresh}
          className="rounded-lg border border-line px-3 py-1.5 text-[13px] text-ink hover:bg-canvas"
        >
          Check again
        </button>
      </Row>
    </>
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
