import { useCallback, useEffect, useMemo, useState } from 'react'

import type { PermissionKind, PermissionsStatus, Settings } from '@murmur/shared'

import {
  Badge,
  Banner,
  Button,
  Card,
  InlineError,
  ProgressBar,
  TextArea,
} from '../../components/Section'
import { useDevMode } from '../../hooks/useDevMode'
import { useDictationState } from '../../hooks/useDictationState'
import { useModels } from '../../hooks/useModels'
import { downloadPercent, formatBytes } from '../../format'
import { detectPlatform } from '../../lib/platform'
import { PermissionCard } from '../sections/HelpSection'
import { permissionCopy } from '../permissions'
import {
  buildSteps,
  isLastStep,
  isSkippable,
  nextStep,
  previousStep,
  progressLabel,
  starterOptions,
  stepIndex,
  type OnboardingStepId,
} from './steps'

/**
 * First run (PLAN §2.4).
 *
 * Hosted inside the Hub rather than in a window of its own: it is the same
 * three permissions, the same model picker and the same hotkey the Hub explains
 * for the rest of the app's life, and a separate window would mean maintaining
 * two of each. Finishing sets `onboardingCompleted`, which is what the Hub
 * gates on.
 *
 * Every screen can be skipped. On a machine where the permissions do not exist
 * — this repository is developed on Linux — they all read "not applicable", and
 * refusing to let anyone past that would make the app unusable for its own
 * authors.
 */
export function Onboarding({
  settings,
  onFinish,
}: {
  settings: Settings
  onFinish: () => void
}): React.JSX.Element {
  const steps = useMemo(
    () =>
      buildSteps({ platform: detectPlatform(navigator.userAgent), hotkeyKey: settings.hotkey.key }),
    [settings.hotkey.key],
  )
  const [step, setStep] = useState<OnboardingStepId>('welcome')
  const [permissions, setPermissions] = useState<PermissionsStatus | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refreshPermissions = useCallback(() => {
    void window.murmur.permissions
      .status()
      .then(setPermissions)
      .catch((cause: unknown) => setError(messageOf(cause)))
  }, [])

  useEffect(() => {
    refreshPermissions()
  }, [refreshPermissions])

  const advance = useCallback(() => setStep((current) => nextStep(steps, current)), [steps])
  const back = useCallback(() => setStep((current) => previousStep(steps, current)), [steps])

  const finish = useCallback(() => {
    void window.murmur.settings
      .set({ onboardingCompleted: true })
      .then(onFinish)
      .catch((cause: unknown) => setError(messageOf(cause)))
  }, [onFinish])

  const index = stepIndex(steps, step)
  const last = isLastStep(steps, step)

  return (
    <div className="mx-auto flex h-full max-w-2xl flex-col px-10 py-9">
      <header className="mb-6">
        <div className="flex items-center justify-between gap-4">
          <p className="text-[12px] font-medium text-ink-muted">{progressLabel(steps, step)}</p>
          {!last ? (
            <Button variant="secondary" onClick={finish}>
              Skip setup
            </Button>
          ) : null}
        </div>
        <div className="mt-2">
          <ProgressBar value={(index + 1) / steps.length} />
        </div>
      </header>

      {/* Keyed on the step so each screen drifts in instead of snapping. */}
      <div key={step} className="hub-section flex-1">
        <InlineError>{error}</InlineError>

        {step === 'welcome' ? <Welcome /> : null}
        {step === 'microphone' || step === 'accessibility' || step === 'inputMonitoring' ? (
          <PermissionStep
            kind={
              step === 'microphone'
                ? 'microphone'
                : step === 'accessibility'
                  ? 'accessibility'
                  : 'inputMonitoring'
            }
            permissions={permissions}
            onRefresh={refreshPermissions}
            onChanged={setPermissions}
          />
        ) : null}
        {step === 'models' ? <ModelStep settings={settings} /> : null}
        {step === 'tutorial' ? <TutorialStep /> : null}
        {step === 'dictationConflict' ? <DictationConflictStep /> : null}
        {step === 'done' ? <DoneStep /> : null}
      </div>

      <footer className="mt-8 flex items-center justify-between gap-4 border-t border-line pt-5">
        <Button variant="secondary" onClick={back} disabled={index === 0}>
          Back
        </Button>
        <div className="flex items-center gap-2">
          {isSkippable(step) ? (
            <Button variant="secondary" onClick={advance}>
              Skip this step
            </Button>
          ) : null}
          <Button variant="primary" onClick={last ? finish : advance}>
            {last ? 'Start dictating' : 'Continue'}
          </Button>
        </div>
      </footer>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------

function Welcome(): React.JSX.Element {
  return (
    <div>
      <h1 className="text-[26px] font-semibold tracking-tight text-ink">Welcome to Murmur</h1>
      <p className="mt-2 max-w-lg text-[14px] leading-relaxed text-ink-muted">
        Hold a key, say what you mean, let go. The finished text appears wherever your cursor is.
      </p>

      <Card className="mt-6">
        <p className="text-[13px] font-medium text-ink">Everything happens on this machine</p>
        <ul className="mt-2 space-y-1.5 text-[13px] leading-relaxed text-ink-muted">
          <li>· Speech recognition and text polishing both run on models you download and own.</li>
          <li>· Audio is held in memory and discarded once it has been transcribed.</li>
          <li>
            · No accounts, no telemetry, no analytics. The only network traffic is you asking for a
            model.
          </li>
        </ul>
      </Card>

      <p className="mt-6 text-[13px] leading-relaxed text-ink-muted">
        Setup takes about a minute: three macOS permissions, a pair of models to download, and one
        practice sentence.
      </p>
    </div>
  )
}

function PermissionStep({
  kind,
  permissions,
  onRefresh,
  onChanged,
}: {
  kind: PermissionKind
  permissions: PermissionsStatus | null
  onRefresh: () => void
  onChanged: (status: PermissionsStatus) => void
}): React.JSX.Element {
  const copy = permissionCopy(kind)
  const state = permissions?.[kind]

  return (
    <div>
      <h1 className="text-[22px] font-semibold tracking-tight text-ink">{copy.title}</h1>
      <p className="mt-2 max-w-lg text-[14px] leading-relaxed text-ink-muted">{copy.why}</p>

      <div className="mt-6">
        <PermissionCard
          title={copy.title}
          why={copy.why}
          notDone={copy.notDone}
          state={state}
          onRequest={() => {
            void window.murmur.permissions
              .request({ kind })
              .then(onChanged)
              .catch(() => undefined)
          }}
          onOpenSettings={() => {
            void window.murmur.permissions.openSystemSettings({ kind }).catch(() => undefined)
          }}
        />
      </div>

      <div className="mt-4 flex items-center gap-3">
        <Button onClick={onRefresh}>Check again</Button>
        <p className="text-[12px] text-ink-faint">
          macOS sometimes needs a moment — or a relaunch — after a permission is granted.
        </p>
      </div>

      {state === 'unavailable' ? (
        <div className="mt-5">
          <Banner tone="accent" title="Not applicable on this platform">
            This is a macOS permission. Continue — Murmur will ask again on a Mac.
          </Banner>
        </div>
      ) : state !== 'granted' ? (
        <div className="mt-5">
          <Banner tone="warning" title="You can skip this">
            {copy.ifSkipped} You can grant it later in Help.
          </Banner>
        </div>
      ) : null}
    </div>
  )
}

function ModelStep({ settings }: { settings: Settings }): React.JSX.Element {
  const { models, downloads, download, error } = useModels()
  const [chosen, setChosen] = useState<string | null>(null)

  const options = useMemo(
    () => starterOptions(models?.hardware ?? null, models?.catalog.models ?? []),
    [models],
  )

  const choose = useCallback(
    (optionId: string) => {
      const option = options.find((candidate) => candidate.id === optionId)
      if (!option) return
      setChosen(optionId)

      void window.murmur.models
        .select({ kind: 'stt', modelId: option.sttId })
        .catch(() => undefined)
      void window.murmur.models
        .select({ kind: 'polish', modelId: option.polishId })
        .catch(() => undefined)

      for (const entry of option.entries) {
        const installed = (models?.installed ?? []).some(
          (candidate) => candidate.modelId === entry.id,
        )
        // Also skip anything already in flight: main dedupes too, but the UI
        // should not fire requests it can see are redundant.
        const progress = downloads[entry.id]
        const inFlight =
          progress &&
          progress.status !== 'complete' &&
          progress.status !== 'cancelled' &&
          progress.status !== 'error'
        if (!installed && !inFlight) void download(entry.id)
      }
    },
    [models, options, downloads, download],
  )

  return (
    <div>
      <h1 className="text-[22px] font-semibold tracking-tight text-ink">Choose your models</h1>
      <p className="mt-2 max-w-lg text-[14px] leading-relaxed text-ink-muted">
        One model turns your voice into text, the other tidies it up. Both are downloaded once and
        then run entirely on this machine — every model listed comes from a US-based organisation, a
        rule the catalog enforces rather than advertises.
      </p>

      <InlineError>{error}</InlineError>

      {models?.catalogError ? (
        <div className="mt-6">
          <Banner tone="danger" title="The model catalog was rejected">
            {models.catalogError} Nothing can be downloaded until it validates; you can continue and
            sort it out from the Models section.
          </Banner>
        </div>
      ) : null}

      <div className="mt-6 space-y-3">
        {options.map((option) => {
          const active = chosen === option.id
          return (
            <Card key={option.id} className={active ? 'border-accent/50' : ''}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="flex items-center gap-2 text-[14px] font-medium text-ink">
                    {option.title}
                    {active ? <Badge tone="accent">Chosen</Badge> : null}
                  </p>
                  <p className="mt-1 max-w-lg text-[12px] leading-relaxed text-ink-muted">
                    {option.description}
                  </p>
                  <ul className="mt-2 space-y-0.5">
                    {option.entries.map((entry) => (
                      <li key={entry.id} className="text-[12px] text-ink-muted">
                        {entry.displayName}{' '}
                        <span className="text-ink-faint">
                          · {entry.org} · {formatBytes(entry.sizeBytes)}
                        </span>
                      </li>
                    ))}
                    {option.polishId === null ? (
                      <li className="text-[12px] text-ink-faint">Polishing off — raw transcript</li>
                    ) : null}
                  </ul>
                </div>
                <div className="text-right">
                  <p className="text-[13px] font-medium tabular-nums text-ink">
                    {formatBytes(option.totalBytes)}
                  </p>
                  <div className="mt-2">
                    <Button
                      variant={active ? 'secondary' : 'primary'}
                      disabled={active}
                      onClick={() => choose(option.id)}
                    >
                      {active ? 'Downloading' : 'Download this pair'}
                    </Button>
                  </div>
                </div>
              </div>

              <div className="mt-3 space-y-2">
                {option.entries.map((entry) => {
                  const progress = downloads[entry.id]
                  if (!progress) return null
                  const total = progress.totalBytes > 0 ? progress.totalBytes : entry.sizeBytes
                  const percent = downloadPercent(progress.receivedBytes, total)
                  return (
                    <div key={entry.id}>
                      <ProgressBar value={percent / 100} />
                      <p className="mt-1 text-[11px] tabular-nums text-ink-muted">
                        {entry.displayName} · {statusLabel(progress.status, percent)}
                      </p>
                    </div>
                  )
                })}
              </div>
            </Card>
          )
        })}

        {options.length === 0 ? (
          <Card className="border-dashed">
            <p className="text-[13px] text-ink-muted">
              No models are available to suggest. Open the Models section once the catalog is
              readable.
            </p>
          </Card>
        ) : null}
      </div>

      <p className="mt-4 text-[12px] text-ink-faint">
        Downloads continue in the background — you can carry on with setup. Current choice:{' '}
        {settings.sttModelId ?? 'none'} for speech, {settings.polishModelId ?? 'none'} for
        polishing.
      </p>
    </div>
  )
}

function statusLabel(status: string, percent: number): string {
  if (status === 'verifying') return 'verifying checksum…'
  if (status === 'complete') return 'ready'
  if (status === 'cancelled') return 'cancelled'
  if (status === 'error') return 'failed — try again from Models'
  if (status === 'queued') return 'starting…'
  return `${percent}%`
}

function TutorialStep(): React.JSX.Element {
  const event = useDictationState()
  const dev = useDevMode()
  const [practice, setPractice] = useState('')
  const [simulating, setSimulating] = useState(false)

  const simulate = useCallback(() => {
    setSimulating(true)
    void window.murmur.debug
      .simulateHotkey({ action: 'down' })
      .then(
        () =>
          new Promise<void>((resolve) => {
            setTimeout(resolve, 1500)
          }),
      )
      .then(() => window.murmur.debug.simulateHotkey({ action: 'up' }))
      .catch(() => undefined)
      .finally(() => setSimulating(false))
  }, [])

  return (
    <div>
      <h1 className="text-[22px] font-semibold tracking-tight text-ink">Try it</h1>
      <p className="mt-2 max-w-lg text-[14px] leading-relaxed text-ink-muted">
        Click into the box below, hold your dictation key, and say{' '}
        <em className="text-ink">“testing one two three”</em>. Let go — the words appear where your
        cursor is.
      </p>

      <div className="mt-6">
        <TextArea
          label="Practice area"
          rows={5}
          value={practice}
          onChange={setPractice}
          placeholder="Your dictation lands here…"
        />
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3 rounded-lg border border-line bg-canvas px-3 py-2">
        <Badge tone={event.state === 'idle' ? 'neutral' : 'accent'}>{event.state}</Badge>
        <p aria-live="polite" className="flex-1 text-[12px] text-ink-muted">
          {event.state === 'listening'
            ? 'Listening…'
            : event.state === 'processing'
              ? 'Working on it…'
              : event.state === 'inserted'
                ? 'That is all there is to it.'
                : event.state === 'error'
                  ? event.message
                  : 'Waiting for your key.'}
        </p>
        {dev ? (
          <Button variant="secondary" onClick={simulate} disabled={simulating}>
            Simulate a hotkey
          </Button>
        ) : null}
      </div>

      <p className="mt-3 text-[12px] leading-relaxed text-ink-faint">
        Nothing happening? The event tap needs Input Monitoring, and it only exists on macOS. The
        Simulate button runs the same pipeline without it, so you can still see the loop work.
      </p>
    </div>
  )
}

/**
 * macOS listens for a double-tap of `fn` itself and opens its own dictation
 * (PLAN §2.4.7). Two things reacting to one key is a bad time; this screen says
 * so and opens the pane where it is turned off.
 */
function DictationConflictStep(): React.JSX.Element {
  return (
    <div>
      <h1 className="text-[22px] font-semibold tracking-tight text-ink">
        One macOS setting to check
      </h1>
      <p className="mt-2 max-w-lg text-[14px] leading-relaxed text-ink-muted">
        macOS has its own dictation, and by default it is triggered by pressing <kbd>fn</kbd> twice
        — the same key Murmur listens for. While Murmur is running it claims the key, so the two
        never fight; but when Murmur is paused or closed, that double-press summons Apple’s
        dictation instead, which can be confusing.
      </p>

      <Card className="mt-6">
        <p className="text-[13px] font-medium text-ink">How to turn it off</p>
        {/* Plain instructions, no deep-link button: the renderer's window.open
            is default-denied (security.ts) and non-http schemes never reach the
            OS, so a button here would be one that does nothing. */}
        <ol className="mt-2 space-y-1.5 text-[13px] leading-relaxed text-ink-muted">
          <li>1. Open System Settings and go to Keyboard.</li>
          <li>2. Find “Dictation”.</li>
          <li>
            3. Either switch it off, or set its shortcut to something other than pressing{' '}
            <kbd>fn</kbd> twice.
          </li>
        </ol>
      </Card>

      <p className="mt-4 text-[12px] leading-relaxed text-ink-faint">
        Prefer to keep Apple’s dictation? Change Murmur’s key to Right ⌘ or Right ⌥ in Settings and
        the two never meet.
      </p>
    </div>
  )
}

function DoneStep(): React.JSX.Element {
  return (
    <div>
      <h1 className="text-[26px] font-semibold tracking-tight text-ink">You are set up</h1>
      <p className="mt-2 max-w-lg text-[14px] leading-relaxed text-ink-muted">
        Murmur lives in the menu bar. Hold your key anywhere, speak, and let go.
      </p>

      <Card className="mt-6">
        <p className="text-[13px] font-medium text-ink">Worth knowing</p>
        <ul className="mt-2 space-y-1.5 text-[13px] leading-relaxed text-ink-muted">
          <li>
            · <span className="text-ink">Dictionary</span> teaches it names and jargon it keeps
            getting wrong.
          </li>
          <li>
            · <span className="text-ink">Style</span> decides how much it may change what you said —
            per kind of app.
          </li>
          <li>
            · <span className="text-ink">Esc</span> cancels while it is listening.
          </li>
          <li>
            · Every permission and both engines have a live status in{' '}
            <span className="text-ink">Help</span>.
          </li>
        </ul>
      </Card>
    </div>
  )
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
