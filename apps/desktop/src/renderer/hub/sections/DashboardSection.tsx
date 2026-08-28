import { useCallback, useEffect, useState } from 'react'

import {
  hotkeyLabel,
  type DictationRecord,
  type EngineStatus,
  type ModelsList,
  type PermissionsStatus,
  type Settings,
} from '@murmur/shared'

import { Button, Card, Section, Select } from '../../components/Section'
import { SkeletonCards, SkeletonList } from '../../components/Skeleton'
import { StatTile } from '../../components/StatTile'
import { formatClock, formatNumber } from '../../format'
import { useEngines } from '../../hooks/useEngines'
import { useInsights } from '../../hooks/useInsights'
import { useSettings } from '../../hooks/useSettings'
import { useNavigate, type SectionId } from '../navigation'
import { useToast } from '../components/ToastHost'
import { greeting, readiness, type Readiness, type ReadinessIssue } from './dashboard/readiness'
import { dailyWords } from './insights/series'
import { errorMessage } from '../../lib/errors'

/**
 * The Dashboard (PLAN §2.2.0) — what the Hub opens on.
 *
 * It used to open on History, which is a log. A log is the right thing to have
 * and the wrong thing to land on: it answers "what did I say" for a user who
 * came to ask "is this working", and it has nothing at all to say to the user
 * who opened the app for the first time and has no history yet.
 *
 * Four questions, in the order someone actually asks them:
 *
 *  1. **Can I dictate right now?** The readiness hero, first and largest,
 *     naming the one thing in the way and the button that fixes it.
 *  2. **Is it doing anything for me?** Three figures, each a link into the
 *     depth behind it.
 *  3. **What is it running?** Both model slots with their live engine state,
 *     swappable without leaving the page.
 *  4. **What did I just say?** The last few dictations.
 *
 * Everything here is a summary with a way through to the real section. The
 * Dashboard deliberately owns no data of its own: anything you can only do here
 * is something the section it summarises is now missing.
 */
export function DashboardSection(): React.JSX.Element {
  const { settings } = useSettings()
  const engines = useEngines()
  const { insights } = useInsights()
  const navigate = useNavigate()

  const [permissions, setPermissions] = useState<PermissionsStatus | null>(null)
  const [recent, setRecent] = useState<DictationRecord[] | null>(null)
  const [models, setModels] = useState<ModelsList | null>(null)

  useEffect(() => {
    let active = true
    void window.murmur.permissions
      .status()
      .then((value) => {
        if (active) setPermissions(value)
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    let active = true
    const load = (): void => {
      void window.murmur.history
        .query({ search: '', limit: RECENT_COUNT, offset: 0 })
        .then((page) => {
          if (active) setRecent(page.records)
        })
        .catch(() => {
          if (active) setRecent([])
        })
    }
    load()
    // The same broadcast History listens to: a dictation landing while the
    // Dashboard is open should show up here too.
    const unsubscribe = window.murmur.history.subscribe(load)
    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  const reloadModels = useCallback((): void => {
    void window.murmur.models
      .list()
      .then(setModels)
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    let active = true
    void window.murmur.models
      .list()
      .then((value) => {
        if (active) setModels(value)
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [])

  const status = readiness({
    permissions,
    engines,
    sttModelId: settings?.sttModelId ?? null,
    polishModelId: settings?.polishModelId ?? null,
    polishingDisabled: settings?.polishingLevel === 'off',
  })

  return (
    <Section
      title={greeting(new Date().getHours())}
      description="How Murmur is set up, what it has been doing, and what you said last."
    >
      <div className="space-y-4">
        <ReadinessHero status={status} settings={settings} onNavigate={navigate} />

        {insights ? (
          <div className="grid gap-4 @xl:grid-cols-3">
            <StatTile
              label="Words dictated"
              value={formatNumber(insights.totals.words)}
              hint={`across ${formatNumber(insights.totals.dictations)} dictations`}
              series={dailyWords(insights.days, insights.today, 14)}
              onClick={() => navigate('insights')}
            />
            <StatTile
              label="Speaking rate"
              value={formatNumber(insights.totals.avgWpm)}
              unit="wpm"
              hint="Averaged over every timed dictation"
              onClick={() => navigate('insights')}
            />
            <StatTile
              label="Daily streak"
              value={formatNumber(insights.streak.current)}
              unit={insights.streak.current === 1 ? 'day' : 'days'}
              hint={`Best run: ${formatNumber(insights.streak.longest)}`}
              tone="positive"
              onClick={() => navigate('insights')}
            />
          </div>
        ) : (
          <SkeletonCards label="Adding up your numbers…" count={3} columns={3} height="h-16" />
        )}

        <div className="grid gap-4 @2xl:grid-cols-5">
          <div className="lg:col-span-3">
            <RecentDictations records={recent} onNavigate={navigate} />
          </div>
          <div className="lg:col-span-2">
            <ActiveModels
              models={models}
              settings={settings}
              stt={engines?.stt ?? null}
              polish={engines?.polish ?? null}
              onNavigate={navigate}
              onSwapped={reloadModels}
            />
          </div>
        </div>

        <QuickActions onNavigate={navigate} />
      </div>
    </Section>
  )
}

const RECENT_COUNT = 4

// ---------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------

const HERO_TONE = {
  ready: { dot: 'bg-positive', ring: 'bg-positive/15', text: 'text-positive' },
  degraded: { dot: 'bg-warning', ring: 'bg-warning/15', text: 'text-warning' },
  blocked: { dot: 'bg-danger', ring: 'bg-danger/15', text: 'text-danger' },
  checking: { dot: 'bg-ink-faint', ring: 'bg-ink/8', text: 'text-ink-muted' },
} as const

function ReadinessHero({
  status,
  settings,
  onNavigate,
}: {
  status: Readiness
  settings: Settings | null
  onNavigate: (section: SectionId) => void
}): React.JSX.Element {
  const tone = HERO_TONE[status.level]
  const key = settings ? hotkeyLabel(settings.hotkey.key) : null

  return (
    <Card
      padding="lg"
      tone={
        status.level === 'blocked' ? 'danger' : status.level === 'degraded' ? 'warning' : 'default'
      }
    >
      <div className="flex items-start gap-4">
        {/* State in form as well as in words: a pulsing dot reads before the
            sentence does, and reads at a glance from across the desk. */}
        <span className={`relative mt-1 grid size-3 shrink-0 place-items-center`}>
          <span className={`absolute size-3 rounded-full ${tone.ring}`} />
          <span className={`size-1.5 rounded-full ${tone.dot}`} />
        </span>

        <div className="min-w-0 flex-1">
          <h2 className="text-[17px] font-semibold tracking-tight text-ink">{status.headline}</h2>

          {status.level === 'ready' ? (
            <p className="mt-1 text-[13px] leading-relaxed text-ink-muted">
              {key ? (
                <>
                  Hold <kbd>{key}</kbd> anywhere on your Mac and speak. What you say lands in
                  whatever you were typing into.
                </>
              ) : (
                'Hold your dictation key anywhere on your Mac and speak.'
              )}
            </p>
          ) : status.level === 'checking' ? (
            <p className="mt-1 text-[13px] text-ink-muted">Reading permissions and engine state.</p>
          ) : (
            <ul className="mt-2.5 space-y-2">
              {status.issues.map((issue) => (
                <IssueRow key={issue.id} issue={issue} onNavigate={onNavigate} />
              ))}
            </ul>
          )}
        </div>
      </div>
    </Card>
  )
}

function IssueRow({
  issue,
  onNavigate,
}: {
  issue: ReadinessIssue
  onNavigate: (section: SectionId) => void
}): React.JSX.Element {
  return (
    <li className="flex items-start justify-between gap-4 border-b border-line pb-2 last:border-b-0 last:pb-0">
      <div className="min-w-0">
        <p className="text-[13px] font-medium text-ink">
          {issue.label}
          {/* Blocking and merely-degrading problems are listed together but
              never look the same — the whole point of the distinction. */}
          {!issue.blocking ? (
            <span className="ml-2 text-[11px] font-normal text-ink-faint">
              dictation still works
            </span>
          ) : null}
        </p>
        <p className="mt-0.5 text-[12px] leading-relaxed text-ink-muted">{issue.detail}</p>
      </div>
      <div className="shrink-0">
        <Button
          variant={issue.blocking ? 'primary' : 'secondary'}
          onClick={() => onNavigate(issue.section)}
        >
          {issue.actionLabel}
        </Button>
      </div>
    </li>
  )
}

// ---------------------------------------------------------------------------
// Recent dictations
// ---------------------------------------------------------------------------

function RecentDictations({
  records,
  onNavigate,
}: {
  records: DictationRecord[] | null
  onNavigate: (section: SectionId) => void
}): React.JSX.Element {
  const toast = useToast()

  const copy = async (record: DictationRecord): Promise<void> => {
    try {
      await window.murmur.app.copyText({ text: record.polishedText ?? record.rawText })
      toast.show({ message: 'Copied to the clipboard', tone: 'positive' })
    } catch (cause) {
      toast.show({
        message: 'Could not copy that',
        detail: errorMessage(cause),
        tone: 'danger',
      })
    }
  }

  if (records === null) {
    return <SkeletonList label="Loading what you said last…" rows={3} gutter seed={11} />
  }

  return (
    <Card padding="none" className="overflow-hidden">
      <div className="flex items-center justify-between gap-4 border-b border-line px-4 py-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.07em] text-ink-faint">
          Latest dictations
        </h2>
        <button
          type="button"
          onClick={() => onNavigate('history')}
          className="text-[12px] font-medium text-accent transition-opacity hover:opacity-70"
        >
          All history →
        </button>
      </div>

      {records.length === 0 ? (
        <p className="px-4 py-8 text-center text-[13px] leading-relaxed text-ink-muted">
          Nothing yet. The last few things you dictate will show up here.
        </p>
      ) : (
        <ul className="divide-y divide-line">
          {records.map((record) => (
            <li
              key={record.id}
              className="group flex items-start gap-3 px-4 py-3 transition-colors duration-150 hover:bg-surface-sunken/60"
            >
              <span className="w-14 shrink-0 pt-px text-[12px] tabular-nums text-ink-faint">
                {formatClock(record.ts)}
              </span>
              {/* Two lines, then it stops. This is a glance, not the archive —
                  History is one click away and shows the whole thing. */}
              <p className="line-clamp-2 min-w-0 flex-1 select-text text-[13px] leading-relaxed text-ink">
                {record.polishedText ?? record.rawText}
              </p>
              <button
                type="button"
                onClick={() => void copy(record)}
                className="shrink-0 rounded-md px-2 py-0.5 text-[12px] font-medium text-ink-muted opacity-0 transition-opacity duration-150 hover:bg-surface-sunken hover:text-ink focus-visible:opacity-100 group-hover:opacity-100"
              >
                Copy
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Active models
// ---------------------------------------------------------------------------

function ActiveModels({
  models,
  settings,
  stt,
  polish,
  onNavigate,
  onSwapped,
}: {
  models: ModelsList | null
  settings: Settings | null
  stt: EngineStatus | null
  polish: EngineStatus | null
  onNavigate: (section: SectionId) => void
  onSwapped: () => void
}): React.JSX.Element {
  return (
    <Card padding="none" className="overflow-hidden">
      <div className="flex items-center justify-between gap-4 border-b border-line px-4 py-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.07em] text-ink-faint">
          Running locally
        </h2>
        <button
          type="button"
          onClick={() => onNavigate('models')}
          className="text-[12px] font-medium text-accent transition-opacity hover:opacity-70"
        >
          Manage →
        </button>
      </div>

      <div className="divide-y divide-line">
        <ModelSlot
          kind="stt"
          role="Speech"
          modelId={settings?.sttModelId ?? null}
          models={models}
          engine={stt}
          onSwapped={onSwapped}
        />
        <ModelSlot
          kind="polish"
          role="Polish"
          modelId={settings?.polishModelId ?? null}
          models={models}
          engine={polish}
          onSwapped={onSwapped}
        />
      </div>
    </Card>
  )
}

const ENGINE_DOT: Record<string, string> = {
  ready: 'bg-positive',
  loading: 'bg-warning',
  // Asleep is a working state, so it is not greyed out with the ones that
  // need the user to do something.
  sleeping: 'bg-positive/50',
  idle: 'bg-ink-faint',
  unavailable: 'bg-danger',
  error: 'bg-danger',
}

/**
 * One model slot: what is loaded, whether it is running, and — when more than
 * one model of this kind is on disk — a way to change it without leaving the
 * page.
 *
 * The picker lists only what is *installed*, deliberately. Offering the whole
 * catalog here would make a two-gigabyte download look like a dropdown choice;
 * downloading belongs in Models, where the size, the licence and the hardware
 * fit are all on screen next to the button.
 */
function ModelSlot({
  kind,
  role,
  modelId,
  models,
  engine,
  onSwapped,
}: {
  kind: 'stt' | 'polish'
  role: string
  modelId: string | null
  models: ModelsList | null
  engine: EngineStatus | null
  onSwapped: () => void
}): React.JSX.Element {
  const toast = useToast()
  const [busy, setBusy] = useState(false)

  const nameOf = (id: string): string =>
    models?.catalog.models.find((entry) => entry.id === id)?.displayName ??
    models?.imported.find((entry) => entry.id === id)?.displayName ??
    id

  const options = (models?.installed ?? [])
    .filter((installed) => installed.kind === kind)
    .map((installed) => ({ value: installed.modelId, label: nameOf(installed.modelId) }))

  // `idle` means two unrelated things, and showing both as "Idle" is what made
  // a model that had merely gone to sleep look broken: the bundled server
  // frees its RAM after ten quiet minutes and wakes on the next dictation, so
  // idle-with-a-model is a resting state, not a missing one.
  const raw = engine?.state ?? 'idle'
  const state = raw === 'idle' && engine?.modelId ? 'sleeping' : raw

  const swap = async (nextId: string): Promise<void> => {
    setBusy(true)
    try {
      await window.murmur.models.select({ kind, modelId: nextId })
      onSwapped()
      toast.show({ message: `Now using ${nameOf(nextId)}`, tone: 'positive' })
    } catch (cause) {
      toast.show({
        message: 'Could not switch model',
        detail: errorMessage(cause),
        tone: 'danger',
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[11px] uppercase tracking-[0.06em] text-ink-faint">{role}</p>
        <span
          className="flex shrink-0 items-center gap-1.5 text-[11px] text-ink-muted"
          title={engine?.detail || undefined}
        >
          <span className={`size-1.5 rounded-full ${ENGINE_DOT[state] ?? 'bg-ink-faint'}`} />
          {ENGINE_STATE_LABEL[state] ?? state}
        </span>
      </div>

      {options.length > 1 && modelId ? (
        <div className="mt-1.5">
          <Select
            label={`${role} model`}
            value={modelId}
            options={options}
            onChange={(next) => {
              if (next !== modelId && !busy) void swap(next)
            }}
          />
        </div>
      ) : (
        <p className="mt-0.5 truncate text-[13px] font-medium text-ink">
          {modelId ? nameOf(modelId) : 'None chosen'}
        </p>
      )}
    </div>
  )
}

const ENGINE_STATE_LABEL: Record<string, string> = {
  ready: 'Loaded',
  loading: 'Loading',
  sleeping: 'Sleeping',
  idle: 'Idle',
  unavailable: 'Unavailable',
  error: 'Error',
}

// ---------------------------------------------------------------------------
// Quick actions
// ---------------------------------------------------------------------------

interface QuickAction {
  label: string
  detail: string
  section: SectionId
  icon: string
}

const QUICK_ACTIONS: readonly QuickAction[] = [
  {
    label: 'Transcribe a file',
    detail: 'A recording, a voice memo, a video',
    section: 'transcribe',
    icon: 'M6 4h8l4 4v12H6zM14 4v4h4M9 14v2.5M12 12.5v5.5M15 14v2.5',
  },
  {
    label: 'Open the Scratchpad',
    detail: 'Somewhere to think out loud',
    section: 'notes',
    icon: 'M6 4h8l4 4v12H6zM14 4v4h4M9 13h6M9 16.5h4',
  },
  {
    label: 'Record a meeting',
    detail: 'Both sides of a call, transcribed live',
    section: 'meetings',
    icon: 'M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zM8 10v4M12 8v8M16 11v2',
  },
  {
    label: 'Teach it a word',
    detail: 'Names and jargon it keeps getting wrong',
    section: 'dictionary',
    icon: 'M5 4h11a2 2 0 0 1 2 2v14H7a2 2 0 0 1-2-2zm2 0v12h11',
  },
]

function QuickActions({
  onNavigate,
}: {
  onNavigate: (section: SectionId) => void
}): React.JSX.Element {
  return (
    <div>
      <h2 className="mb-2.5 text-[11px] font-semibold uppercase tracking-[0.07em] text-ink-faint">
        Start something
      </h2>
      <div className="grid gap-3 @md:grid-cols-2 @4xl:grid-cols-4">
        {QUICK_ACTIONS.map((action) => (
          <button
            key={action.section}
            type="button"
            onClick={() => onNavigate(action.section)}
            className="rounded-card elev-lift border border-line bg-surface-raised p-3.5 text-left active:scale-[0.99]"
          >
            <svg
              viewBox="0 0 24 24"
              aria-hidden="true"
              className="mb-2.5 size-[18px] text-accent"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d={action.icon} />
            </svg>
            <p className="text-[13px] font-medium text-ink">{action.label}</p>
            <p className="mt-0.5 text-[12px] leading-relaxed text-ink-muted">{action.detail}</p>
          </button>
        ))}
      </div>
    </div>
  )
}
