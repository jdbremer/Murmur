import { useCallback, useEffect, useRef, useState } from 'react'

import type { MeetingEvent, MeetingRecord, Settings, SystemAudioAccess } from '@murmur/shared'

import {
  Badge,
  Banner,
  Button,
  Card,
  EmptyState,
  ErrorCard,
  Row,
  Section,
  Toggle,
} from '../../components/Section'
import { SkeletonList, SkeletonRows } from '../../components/Skeleton'
import { errorMessage } from '../../lib/errors'

/**
 * Meetings (PLAN §18.2) — record a call, transcribe it live, keep the file.
 *
 * The section has to hold two ideas at once without muddling them: the feature
 * is **off until asked for**, and once on, the transcript is a plain file the
 * user owns rather than something locked inside the app. So the empty state
 * leads with the switch, and every recorded meeting offers "Show in Finder"
 * before anything else.
 */
export function MeetingsSection(): React.JSX.Element {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [meetings, setMeetings] = useState<MeetingRecord[] | null>(null)
  const [live, setLive] = useState<MeetingEvent>({ state: 'idle' })
  const [access, setAccess] = useState<SystemAudioAccess | null>(null)
  const [error, setError] = useState<string | null>(null)
  const active = useRef(true)

  const reload = useCallback(async (): Promise<void> => {
    const [list, current] = await Promise.all([
      window.murmur.meetings.list(),
      window.murmur.meetings.getState(),
    ])
    if (!active.current) return
    setMeetings(list.meetings)
    setLive(current)
  }, [])

  useEffect(() => {
    active.current = true
    void Promise.all([window.murmur.settings.get(), window.murmur.meetings.systemAudioAccess()])
      .then(([next, systemAudio]) => {
        if (!active.current) return
        setSettings(next)
        setAccess(systemAudio)
      })
      .catch((cause: unknown) => setError(describe(cause)))
    void reload().catch((cause: unknown) => {
      if (active.current) {
        setError(describe(cause))
        setMeetings([])
      }
    })

    const offState = window.murmur.meetings.subscribe((event) => {
      if (!active.current) return
      setLive(event)
      // A finished meeting is a new row; refresh rather than guess at it.
      if (event.state === 'idle') void reload().catch(() => undefined)
    })
    const offSettings = window.murmur.settings.subscribe((next) => {
      if (active.current) setSettings(next)
    })
    return () => {
      active.current = false
      offState()
      offSettings()
    }
  }, [reload])

  const patchMeetings = async (patch: Partial<Settings['meetings']>): Promise<void> => {
    if (!settings) return
    try {
      const next = await window.murmur.settings.set({
        meetings: { ...settings.meetings, ...patch },
      })
      if (active.current) setSettings(next)
    } catch (cause) {
      setError(describe(cause))
    }
  }

  const recording = live.state === 'recording' || live.state === 'finishing'

  const toggleRecording = async (): Promise<void> => {
    setError(null)
    try {
      if (recording) await window.murmur.meetings.stop()
      else await window.murmur.meetings.start({ title: '', appBundleId: null })
      await reload()
    } catch (cause) {
      setError(describe(cause))
    }
  }

  if (!settings || meetings === null) {
    return (
      <Section title="Meetings" description="Record a call and transcribe it as it happens.">
        <div className="space-y-4">
          <SkeletonRows label="Loading meetings…" rows={2} />
          <SkeletonList label="Loading meetings…" rows={3} seed={9} />
        </div>
      </Section>
    )
  }

  const enabled = settings.meetings.enabled

  return (
    <Section
      title="Meetings"
      description="Record a call and transcribe it as it happens, straight to a Markdown file you own."
      actions={
        enabled ? (
          <Button variant={recording ? 'danger' : 'primary'} onClick={() => void toggleRecording()}>
            {recording ? 'Stop recording' : 'Record meeting'}
          </Button>
        ) : undefined
      }
    >
      {error ? <ErrorCard>{error}</ErrorCard> : null}

      {live.state === 'recording' ? (
        <div className="mb-4">
          <Banner tone="accent" title={`Recording “${live.title}”`}>
            {formatClock(live.elapsedMs)} · {live.segmentCount} segment
            {live.segmentCount === 1 ? '' : 's'}
            {live.hasSystemAudio ? '' : ' · microphone only'}
            {live.degraded ? ` · ${live.degraded}` : ''}
          </Banner>
        </div>
      ) : null}

      <Card className="mb-4">
        <Row
          label="Record meetings"
          hint="Off by default. Nothing is watched, captured or written until you turn this on."
        >
          <Toggle
            checked={enabled}
            onChange={(next) => void patchMeetings({ enabled: next })}
            label="Record meetings"
          />
        </Row>
        <Row
          label="Notice meetings automatically"
          hint="Offers to record when an app is using your microphone and speakers together. It always asks first."
        >
          <Toggle
            checked={settings.meetings.autoDetect}
            onChange={(next) => void patchMeetings({ autoDetect: next })}
            label="Notice meetings automatically"
            disabled={!enabled}
          />
        </Row>
        <Row
          label="Transcripts folder"
          hint={settings.meetings.folder ?? 'Documents › Murmur Meetings'}
        >
          <Button onClick={() => void window.murmur.meetings.openFolder()}>Open folder</Button>
        </Row>
      </Card>

      {enabled && access && access.status !== 'granted' ? (
        <div className="mb-4">
          <SystemAudioNotice
            access={access}
            onRequest={async () => {
              const next = await window.murmur.meetings.requestSystemAudio()
              if (active.current) setAccess(next)
            }}
          />
        </div>
      ) : null}

      {meetings.length === 0 ? (
        <EmptyState
          icon="meetings"
          title={enabled ? 'No meetings recorded yet' : 'Meeting capture is off'}
        >
          {enabled
            ? 'Hit Record meeting when you are on a call. Murmur captures both sides, transcribes as it goes, and writes a Markdown file you own.'
            : 'Turn it on above to record and transcribe a call. Nothing is captured until you press Record.'}
        </EmptyState>
      ) : (
        <div className="flex flex-col gap-2">
          {meetings.map((meeting) => (
            <MeetingRow
              key={meeting.id}
              meeting={meeting}
              onChanged={() => void reload().catch(() => undefined)}
            />
          ))}
        </div>
      )}
    </Section>
  )
}

function MeetingRow({
  meeting,
  onChanged,
}: {
  meeting: MeetingRecord
  onChanged: () => void
}): React.JSX.Element {
  return (
    <Card>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="truncate text-[13px] font-medium text-ink">{meeting.title}</p>
          <p className="mt-0.5 text-[12px] text-ink-muted">
            {new Date(meeting.startedAt).toLocaleString()} · {formatClock(meeting.durationMs)} ·{' '}
            {meeting.segmentCount} segment{meeting.segmentCount === 1 ? '' : 's'}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {meeting.hadSystemAudio ? (
            <Badge tone="positive" title="Both sides of the call were captured">
              Both sides
            </Badge>
          ) : (
            <Badge tone="neutral" title="Only your microphone was captured">
              Mic only
            </Badge>
          )}
          <Button onClick={() => void window.murmur.meetings.reveal({ id: meeting.id })}>
            Show in Finder
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              void window.murmur.meetings.delete({ id: meeting.id }).then(onChanged)
            }}
            title="Deletes the transcript file as well"
          >
            Delete
          </Button>
        </div>
      </div>
    </Card>
  )
}

/**
 * Explains the system-audio permission, and why it lives under a pane called
 * "Screen & System Audio Recording".
 *
 * That naming is macOS's, not ours, and it is alarming enough that saying
 * nothing would be the dishonest choice — the tap captures audio only and
 * never has access to the screen.
 */
function SystemAudioNotice({
  access,
  onRequest,
}: {
  access: SystemAudioAccess
  onRequest: () => Promise<void>
}): React.JSX.Element {
  if (access.mode === 'unsupported') {
    return (
      <Banner tone="warning" title="Meetings will record your microphone only">
        {access.detail || 'This Mac cannot capture the other participants.'}
      </Banner>
    )
  }

  return (
    <Banner
      tone={access.status === 'denied' ? 'warning' : 'accent'}
      title={
        access.status === 'denied'
          ? 'Only your voice will be recorded'
          : 'Let Murmur hear the other participants'
      }
      actions={
        <Button variant="primary" onClick={() => void onRequest()}>
          {access.status === 'denied' ? 'Open System Settings' : 'Allow system audio'}
        </Button>
      }
    >
      Without this, a transcript has your half of the conversation and nothing else. macOS files
      this permission under <em>Screen &amp; System Audio Recording</em> — Murmur captures audio
      only and never reads your screen.
      {access.detail ? <> {access.detail}</> : null}
    </Banner>
  )
}

function formatClock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const s = total % 60
  const m = Math.floor(total / 60) % 60
  const h = Math.floor(total / 3600)
  const p = (n: number): string => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`
}

function describe(cause: unknown): string {
  return errorMessage(cause)
}
