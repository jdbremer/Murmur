import { useEffect, useRef, useState } from 'react'

import type {
  EngineStatus,
  HardwareFit,
  ImportedModel,
  ModelDownloadProgress,
  ModelEngine,
  ModelEntry,
  ModelKind,
  ModelsList,
} from '@murmur/shared'

import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorCard,
  ProgressBar,
  Section,
  Select,
  TextInput,
  Toggle,
} from '../../components/Section'
import { Segmented } from '../../components/Segmented'
import { SkeletonCards } from '../../components/Skeleton'
import { isWindowsPlatform } from '../../lib/platform'
import { useFocusShortcut } from '../../hooks/useFocusShortcut'
import { useModels } from '../../hooks/useModels'
import { useSettings } from '../../hooks/useSettings'
import { formatBytes, formatLanguages } from '../../format'
import {
  bestForMachine,
  catalogView,
  DownloadRate,
  formatRate,
  formatRemaining,
  type ModelSort,
} from './models/catalog-view'
import { errorMessage } from '../../lib/errors'

/**
 * Models (PLAN §8).
 *
 * The catalog shown here has already passed the origin policy in the main
 * process — anything out of policy was rejected at load, not filtered here, so
 * an empty list means "the catalog failed validation", which is why
 * `catalogError` gets its own loud treatment rather than rendering as "no
 * models found".
 *
 * The screen is built around one observation: almost nobody wants to *browse*
 * seventeen models. They want the right one. So the page opens with a single
 * recommendation for this specific machine and its reasoning, and the full
 * catalog sits underneath it for the minority who came to compare — searchable
 * by publisher and licence, because "IBM" and "Apache-2.0" are what people
 * actually narrow by.
 *
 * The machine facts and disk usage used to be the first card on the page. They
 * are now the last line of it: true, occasionally useful, and not what anyone
 * opened this section to find out.
 *
 * Every card still states its provenance — organisation, origin, licence —
 * because that is the claim the whole product rests on. What moved into a
 * disclosure is the paragraph *behind* that claim, which is worth reading once
 * and worth collapsing every time after.
 */

const FIT_LABEL: Record<HardwareFit, string> = {
  runsWell: 'Runs well',
  tight: 'Tight',
  notRecommended: 'Not recommended',
}

const FIT_TONE: Record<HardwareFit, 'positive' | 'warning' | 'neutral'> = {
  runsWell: 'positive',
  tight: 'warning',
  notRecommended: 'neutral',
}

const ENGINE_LABEL: Record<ModelEngine, string> = {
  'whisper-cpp': 'whisper.cpp',
  'onnx-runtime': 'ONNX Runtime',
  'llama-cpp': 'llama.cpp',
}

const KIND_TITLE: Record<ModelKind, string> = {
  stt: 'Speech-to-text',
  polish: 'Polishing',
}

const KIND_OPTIONS = [
  { value: 'stt' as const, label: 'Speech' },
  { value: 'polish' as const, label: 'Polishing' },
]

const SORT_OPTIONS: readonly { value: ModelSort; label: string }[] = [
  { value: 'best', label: 'Best first' },
  { value: 'name', label: 'Name' },
  { value: 'size', label: 'Size' },
]

/** What a download is currently doing, per model id. */
interface RateReading {
  bytesPerSecond: number | null
  remainingMs: number | null
}

export function ModelsSection(): React.JSX.Element {
  const {
    models,
    engines,
    downloads,
    error,
    busyModelId,
    download,
    cancel,
    select,
    remove,
    refresh,
  } = useModels()
  const { settings } = useSettings()

  const [kind, setKind] = useState<ModelKind>('stt')
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<ModelSort>('best')
  const [installedOnly, setInstalledOnly] = useState(false)

  const rates = useDownloadRates(downloads)
  const searchRef = useRef<HTMLInputElement | null>(null)
  useFocusShortcut(searchRef)

  if (!models) {
    return (
      <Section
        title="Models"
        description="Choose the speech-to-text and polishing models Murmur runs locally."
      >
        <SkeletonCards label="Loading the catalog…" count={4} columns={2} height="h-24" />
      </Section>
    )
  }

  const selectedFor = (which: ModelKind): string | null =>
    which === 'stt' ? (settings?.sttModelId ?? null) : (settings?.polishModelId ?? null)

  const installedIds = new Set(models.installed.map((model) => model.modelId))
  const runtimeReady =
    kind === 'polish'
      ? engines?.sidecars?.llama?.installed === true
      : engines?.sidecars?.whisper?.installed === true

  // The catalog's `recommended` flag is one-per-memory-tier, so on a 32 GB
  // machine both the 8 GB and the 16 GB default carry it — and a list showing
  // two "Recommended" badges is recommending for somebody else's Mac. Only the
  // pick for *this* machine gets the badge, which is also what the hero shows,
  // so the two halves of the page agree.
  const bestId = bestForMachine(models.catalog.models, kind, models.hardware.fits)?.id ?? null

  const visible = catalogView({
    entries: models.catalog.models,
    kind,
    fits: models.hardware.fits,
    query,
    sort,
    installedIds,
    installedOnly,
  })
  const imported = models.imported.filter((entry) => entry.kind === kind)
  const engine = kind === 'stt' ? engines?.stt : engines?.polish

  const rowProps = (entry: ModelEntry): ModelCardProps => ({
    entry,
    fit: models.hardware.fits[entry.id],
    installed: installedIds.has(entry.id),
    selected: selectedFor(kind) === entry.id,
    progress: downloads[entry.id],
    rate: rates[entry.id],
    busy: busyModelId === entry.id,
    showRecommended: entry.id === bestId && runtimeReady,
    runtimeReady,
    onDownload: () => void download(entry.id),
    onPause: () => void cancel(entry.id),
    onSelect: () => void select(kind, entry.id),
    onDeselect: () => void select(kind, null),
    onRemove: () => void remove(entry.id),
  })

  return (
    <Section
      title="Models"
      description="Everything Murmur runs, it runs on this machine. Pick what it should use."
    >
      {error ? <ErrorCard>{error}</ErrorCard> : null}
      {models.catalogError ? (
        <ErrorCard>
          The shipped catalog was rejected: {models.catalogError} — no models can be listed until it
          validates against the origin policy.
        </ErrorCard>
      ) : null}

      <BestForThisMac
        models={models}
        installedIds={installedIds}
        sttSelected={selectedFor('stt')}
        polishSelected={selectedFor('polish')}
        downloads={downloads}
        busyModelId={busyModelId}
        onDownload={download}
        onSelect={select}
        onBrowse={setKind}
      />

      {/* The in-app download flow ships Windows builds only (engines.installSidecar
          refuses elsewhere); mac/linux keep the engine badge + searched-paths story. */}
      {kind === 'polish' && !runtimeReady && isWindowsPlatform() ? (
        <SidecarInstallCard
          title="Polishing needs llama-server"
          body="Gemma and other polish models are weights only. Murmur also needs the local llama-server runtime (like whisper-server for speech). Without it, dictation still works — text is inserted raw."
          which="llama-server"
          onInstalled={() => void refresh()}
        />
      ) : null}
      {kind === 'stt' && !runtimeReady && isWindowsPlatform() ? (
        <SidecarInstallCard
          title="Speech needs whisper-server"
          body="Whisper models need the local whisper-server binary next to the app."
          which="whisper-server"
          onInstalled={() => void refresh()}
        />
      ) : null}

      <div className="mb-4 mt-7 flex flex-wrap items-center gap-2">
        <Segmented
          label="Model kind"
          value={kind}
          options={KIND_OPTIONS}
          onChange={(next) => {
            setKind(next)
            // A query that matched a speech model almost never matches a
            // polish one; carrying it across the switch just shows an empty
            // list and blames the user for it.
            setQuery('')
          }}
        />
        <div className="min-w-[180px] flex-1">
          <TextInput
            inputRef={searchRef}
            value={query}
            onChange={setQuery}
            ariaLabel={`Search ${KIND_TITLE[kind].toLowerCase()} models`}
            placeholder="Search by name, publisher or licence…"
          />
        </div>
        <Select label="Sort models" value={sort} options={SORT_OPTIONS} onChange={setSort} />
      </div>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <label className="flex cursor-pointer items-center gap-2">
          <Toggle
            checked={installedOnly}
            onChange={setInstalledOnly}
            label="Show only models on this machine"
          />
          <span className="text-[12px] text-ink-muted">On this machine only</span>
        </label>

        <div className="flex items-center gap-2.5">
          <span className="text-[12px] tabular-nums text-ink-faint">
            {visible.length} of {countOfKind(models, kind)}
          </span>
          {/* The engine's own state, beside the list it governs — a model can
              be downloaded and selected and still not run. */}
          {engine ? <EngineBadge engine={engine} /> : null}
        </div>
      </div>

      {visible.length === 0 && imported.length === 0 ? (
        query || installedOnly ? (
          <EmptyState
            icon="search"
            title="Nothing matches"
            action={
              <Button
                onClick={() => {
                  setQuery('')
                  setInstalledOnly(false)
                }}
              >
                Clear filters
              </Button>
            }
          >
            No {KIND_TITLE[kind].toLowerCase()} model matches what you are looking for.
          </EmptyState>
        ) : (
          <EmptyState icon="models" title="Nothing in the catalog">
            No {KIND_TITLE[kind].toLowerCase()} models are listed. You can still add one from a file
            you already have.
          </EmptyState>
        )
      ) : (
        <div className="grid gap-3 @2xl:grid-cols-2">
          {visible.map((entry) => (
            <ModelCard key={entry.id} {...rowProps(entry)} />
          ))}
          {imported.map((entry) => (
            <ImportedCard
              key={entry.id}
              entry={entry}
              selected={selectedFor(kind) === entry.id}
              busy={busyModelId === entry.id}
              onSelect={() => void select(kind, entry.id)}
              onDeselect={() => void select(kind, null)}
              onRemove={() => void remove(entry.id)}
            />
          ))}
        </div>
      )}

      <div className="mt-7 space-y-4">
        <ImportCard />
        <MachineStrip models={models} />
      </div>
    </Section>
  )
}

function countOfKind(models: ModelsList, kind: ModelKind): number {
  return models.catalog.models.filter((entry) => entry.kind === kind).length
}

/**
 * Download speed and time-remaining for every in-flight download.
 *
 * One interval for the whole page rather than one per card: the progress
 * events arrive far too often and far too unevenly to render directly, and N
 * timers would mean N re-renders a second on a screen that is otherwise still.
 * Sampling on a fixed tick is also what makes the smoothing in `DownloadRate`
 * behave — an exponential average over irregular intervals is not an average
 * of anything.
 */
function useDownloadRates(
  downloads: Record<string, ModelDownloadProgress>,
): Record<string, RateReading> {
  const [rates, setRates] = useState<Record<string, RateReading>>({})
  const latest = useRef(downloads)
  const trackers = useRef(new Map<string, DownloadRate>())

  useEffect(() => {
    latest.current = downloads
  }, [downloads])

  useEffect(() => {
    const timer = window.setInterval(() => {
      const now = Date.now()
      const next: Record<string, RateReading> = {}

      for (const [modelId, progress] of Object.entries(latest.current)) {
        if (progress.status !== 'downloading') {
          trackers.current.delete(modelId)
          continue
        }
        let tracker = trackers.current.get(modelId)
        if (!tracker) {
          tracker = new DownloadRate()
          trackers.current.set(modelId, tracker)
        }
        tracker.sample(progress.receivedBytes, now)
        next[modelId] = {
          bytesPerSecond: tracker.bytesPerSecond,
          remainingMs: tracker.remainingMs(progress.receivedBytes, progress.totalBytes),
        }
      }

      // Nothing downloading and nothing to clear: do not re-render a still page
      // twice a second for the rest of the session.
      setRates((current) =>
        Object.keys(next).length === 0 && Object.keys(current).length === 0 ? current : next,
      )
    }, SAMPLE_INTERVAL_MS)

    return () => window.clearInterval(timer)
  }, [])

  return rates
}

const SAMPLE_INTERVAL_MS = 500

// ---------------------------------------------------------------------------
// Best for this Mac
// ---------------------------------------------------------------------------

/**
 * The answer, before the catalog.
 *
 * Two rows — one per slot — each naming the model this machine should run and
 * saying why in the same breath. When a slot is already filled with that
 * model, the row says so and stops asking; when it is filled with a *different*
 * model, the row leaves it alone, because a recommendation that keeps
 * second-guessing a choice the user already made is nagging rather than help.
 */
function BestForThisMac({
  models,
  installedIds,
  sttSelected,
  polishSelected,
  downloads,
  busyModelId,
  onDownload,
  onSelect,
  onBrowse,
}: {
  models: ModelsList
  installedIds: ReadonlySet<string>
  sttSelected: string | null
  polishSelected: string | null
  downloads: Record<string, ModelDownloadProgress>
  busyModelId: string | null
  onDownload: (modelId: string) => Promise<void>
  onSelect: (kind: ModelKind, modelId: string | null) => Promise<void>
  onBrowse: (kind: ModelKind) => void
}): React.JSX.Element | null {
  const machine = models.hardware.machine
  const picks = (['stt', 'polish'] as const)
    .map((kind) => ({
      kind,
      entry: bestForMachine(models.catalog.models, kind, models.hardware.fits),
    }))
    .filter((pick): pick is { kind: ModelKind; entry: ModelEntry } => pick.entry !== null)

  if (picks.length === 0) return null

  return (
    <Card padding="none" tone="accent" className="overflow-hidden">
      <div className="border-b border-line px-5 py-3.5">
        <h2 className="text-[15px] font-semibold tracking-tight text-ink">Best for this Mac</h2>
        <p className="mt-0.5 text-[12px] text-ink-muted">
          Chosen for {machine.appleSilicon ? 'Apple Silicon' : 'an Intel Mac'} with{' '}
          {machine.totalRamGb} GB of memory. You can pick something else below.
        </p>
      </div>

      <div className="divide-y divide-line">
        {picks.map(({ kind, entry }) => (
          <BestRow
            key={kind}
            kind={kind}
            entry={entry}
            fit={models.hardware.fits[entry.id]}
            installed={installedIds.has(entry.id)}
            inUse={(kind === 'stt' ? sttSelected : polishSelected) === entry.id}
            slotFilled={Boolean(kind === 'stt' ? sttSelected : polishSelected)}
            downloading={isActive(downloads[entry.id])}
            busy={busyModelId === entry.id}
            onDownload={() => void onDownload(entry.id)}
            onUse={() => void onSelect(kind, entry.id)}
            onBrowse={() => onBrowse(kind)}
          />
        ))}
      </div>
    </Card>
  )
}

function BestRow({
  kind,
  entry,
  fit,
  installed,
  inUse,
  slotFilled,
  downloading,
  busy,
  onDownload,
  onUse,
  onBrowse,
}: {
  kind: ModelKind
  entry: ModelEntry
  fit: HardwareFit | undefined
  installed: boolean
  inUse: boolean
  slotFilled: boolean
  downloading: boolean
  busy: boolean
  onDownload: () => void
  onUse: () => void
  onBrowse: () => void
}): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5">
      <div className="min-w-0">
        <p className="text-[11px] uppercase tracking-[0.06em] text-ink-faint">{KIND_TITLE[kind]}</p>
        <div className="mt-0.5 flex flex-wrap items-center gap-2">
          <p className="text-[14px] font-medium text-ink">{entry.displayName}</p>
          {fit ? <Badge tone={FIT_TONE[fit]}>{FIT_LABEL[fit]}</Badge> : null}
          {inUse ? <Badge tone="accent">In use</Badge> : null}
        </div>
        <p className="mt-0.5 text-[12px] text-ink-muted">
          {entry.org} · {entry.license} · {formatBytes(entry.sizeBytes)}
        </p>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {inUse ? (
          <span className="flex items-center gap-1.5 text-[12px] text-positive">
            <Check /> Set up
          </span>
        ) : downloading ? (
          <span className="text-[12px] text-ink-muted">Downloading…</span>
        ) : installed ? (
          <Button variant="primary" disabled={busy} onClick={onUse}>
            Use this
          </Button>
        ) : (
          <Button variant="primary" disabled={busy} onClick={onDownload}>
            Download · {formatBytes(entry.sizeBytes)}
          </Button>
        )}
        {/* Present even when the slot is already filled: the point of a
            recommendation is that it can be declined. */}
        {inUse || !slotFilled ? (
          <Button onClick={onBrowse}>Browse</Button>
        ) : (
          <Button onClick={onBrowse}>Compare</Button>
        )}
      </div>
    </div>
  )
}

function Check(): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className="size-[14px]"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  )
}

function isActive(progress: ModelDownloadProgress | undefined): boolean {
  return (
    progress?.status === 'queued' ||
    progress?.status === 'downloading' ||
    progress?.status === 'verifying'
  )
}

// ---------------------------------------------------------------------------
// Catalog cards
// ---------------------------------------------------------------------------

interface ModelCardProps {
  entry: ModelEntry
  fit: HardwareFit | undefined
  installed: boolean
  selected: boolean
  progress: ModelDownloadProgress | undefined
  rate: RateReading | undefined
  busy: boolean
  showRecommended: boolean
  runtimeReady: boolean
  onDownload: () => void
  onPause: () => void
  onSelect: () => void
  onDeselect: () => void
  onRemove: () => void
}

function ModelCard({
  entry,
  fit,
  installed,
  selected,
  progress,
  rate,
  busy,
  showRecommended,
  runtimeReady,
  onDownload,
  onPause,
  onSelect,
  onDeselect,
  onRemove,
}: ModelCardProps): React.JSX.Element {
  const downloading = isActive(progress)
  const failed = progress?.status === 'error'
  // The main process keeps the partial file on cancel and resumes from it, so
  // the honest word for the button that stopped it is Pause, and the honest
  // word for starting again is Resume. Calling both of them what they are is
  // the whole change — the capability was already there and invisible.
  const paused = progress?.status === 'cancelled' && progress.receivedBytes > 0

  return (
    <Card tone={selected ? 'accent' : 'default'} padding="sm" className="flex flex-col">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-[13px] font-semibold text-ink">{entry.displayName}</h3>
          <p className="mt-0.5 text-[12px] text-ink-muted">
            {entry.org} · {entry.license}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
          {selected ? <Badge tone="accent">In use</Badge> : null}
          {showRecommended && !selected ? (
            <Badge tone="accent" title="The best fit for this machine">
              Best here
            </Badge>
          ) : null}
          {fit ? (
            <Badge tone={FIT_TONE[fit]} title={`Wants ${entry.ramTierGb} GB of memory`}>
              {FIT_LABEL[fit]}
            </Badge>
          ) : null}
          {!runtimeReady && entry.kind === 'polish' ? (
            <Badge tone="warning" title="Install llama-server first">
              Needs runtime
            </Badge>
          ) : null}
        </div>
      </div>

      <p className="mt-1.5 text-[12px] tabular-nums text-ink-faint">
        {formatBytes(entry.sizeBytes)} · {entry.quant} · {formatLanguages(entry.languages)}
      </p>

      {progress && downloading ? (
        <DownloadProgress progress={progress} entry={entry} rate={rate} />
      ) : progress && progress.status !== 'complete' ? (
        <p className={`mt-2 text-[12px] ${failed ? 'text-warning' : 'text-ink-muted'}`}>
          {failed
            ? (progress.message ?? 'The download failed.')
            : paused
              ? `Paused at ${formatBytes(progress.receivedBytes)}. Resuming picks up where it stopped.`
              : (progress.message ?? '')}
        </p>
      ) : null}

      <div className="mt-3 flex items-center justify-between gap-2">
        <Details entry={entry} />

        <div className="flex shrink-0 items-center gap-2">
          {downloading ? (
            <Button onClick={onPause}>Pause</Button>
          ) : installed ? (
            <>
              {selected ? (
                <Button onClick={onDeselect} disabled={busy}>
                  Stop using
                </Button>
              ) : (
                <Button onClick={onSelect} variant="primary" disabled={busy}>
                  Use
                </Button>
              )}
              <Button onClick={onRemove} variant="danger" disabled={busy}>
                Delete
              </Button>
            </>
          ) : (
            <Button onClick={onDownload} variant="primary" disabled={busy}>
              {failed ? 'Try again' : paused ? 'Resume' : 'Download'}
            </Button>
          )}
        </div>
      </div>
    </Card>
  )
}

/**
 * The provenance paragraph, folded away.
 *
 * It is the most valuable text on the page and the least often needed: it is
 * how someone decides whether to trust a model, which happens once, against a
 * card they will scan a hundred times. A `<details>` rather than a modal — it
 * expands in place, prints, and needs no state of its own.
 */
function Details({ entry }: { entry: ModelEntry }): React.JSX.Element {
  return (
    <details className="group min-w-0 flex-1">
      <summary className="inline-flex cursor-pointer select-none items-center gap-1 text-[12px] text-ink-muted transition-colors hover:text-ink">
        <svg
          viewBox="0 0 24 24"
          aria-hidden="true"
          className="size-[13px] transition-transform duration-150 group-open:rotate-90"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="m9 6 6 6-6 6" />
        </svg>
        Details
      </summary>
      <dl className="mt-2 space-y-1 text-[12px]">
        <DetailRow label="Runtime" value={ENGINE_LABEL[entry.engine]} />
        <DetailRow label="Wants" value={`${entry.ramTierGb} GB of memory`} />
        <DetailRow label="Origin" value={entry.origin} />
      </dl>
      {entry.notes ? (
        <p className="mt-2 select-text text-[12px] leading-relaxed text-ink-muted">{entry.notes}</p>
      ) : null}
    </details>
  )
}

function DetailRow({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-ink-faint">{label}</dt>
      <dd className="text-ink-muted">{value}</dd>
    </div>
  )
}

function DownloadProgress({
  progress,
  entry,
  rate,
}: {
  progress: ModelDownloadProgress
  entry: ModelEntry
  rate: RateReading | undefined
}): React.JSX.Element {
  const total = progress.totalBytes || entry.sizeBytes
  // `verifying` has no byte progress to report — the bar goes indeterminate
  // rather than sitting at 100% pretending to still be downloading.
  const fraction =
    progress.status === 'verifying' || total <= 0 ? null : progress.receivedBytes / total

  const speed = formatRate(rate?.bytesPerSecond ?? null)
  const left = formatRemaining(rate?.remainingMs ?? null)

  return (
    <div className="mt-3">
      <ProgressBar value={fraction} />
      <div className="mt-1.5 flex justify-between gap-3 text-[12px] text-ink-muted">
        <span className="tabular-nums">
          {progress.status === 'queued'
            ? 'Queued…'
            : progress.status === 'verifying'
              ? 'Checking the download matches its published checksum…'
              : `${formatBytes(progress.receivedBytes)} of ${formatBytes(total)}`}
        </span>
        {/* Speed and time only once there is a measurement — an ETA invented
            from the first two packets is worse than no ETA. */}
        {speed || left ? (
          <span className="shrink-0 tabular-nums text-ink-faint">
            {[speed, left].filter(Boolean).join(' · ')}
          </span>
        ) : null}
      </div>
    </div>
  )
}

function ImportedCard({
  entry,
  selected,
  busy,
  onSelect,
  onDeselect,
  onRemove,
}: {
  entry: ImportedModel
  selected: boolean
  busy: boolean
  onSelect: () => void
  onDeselect: () => void
  onRemove: () => void
}): React.JSX.Element {
  return (
    <Card tone={selected ? 'accent' : 'default'} padding="sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-[13px] font-semibold text-ink">{entry.displayName}</h3>
          <p className="mt-0.5 truncate text-[12px] text-ink-faint" title={entry.path}>
            {entry.path}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
          {selected ? <Badge tone="accent">In use</Badge> : null}
          <Badge tone="warning" title="Imported models bypass the catalog's origin policy">
            Origin unverified
          </Badge>
        </div>
      </div>

      <div className="mt-3 flex justify-end gap-2">
        {selected ? (
          <Button onClick={onDeselect} disabled={busy}>
            Stop using
          </Button>
        ) : (
          <Button onClick={onSelect} variant="primary" disabled={busy}>
            Use
          </Button>
        )}
        <Button onClick={onRemove} variant="danger" disabled={busy}>
          Remove
        </Button>
      </div>
    </Card>
  )
}

/**
 * The machine facts, demoted.
 *
 * These used to be the first card on the page — three rows of true, mildly
 * interesting information standing between the user and the thing they came
 * for. They belong at the bottom, in one line, where they answer "why did it
 * badge that model Tight" for the one person in fifty who asks.
 */
function MachineStrip({ models }: { models: ModelsList }): React.JSX.Element {
  const machine = models.hardware.machine
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 px-1 text-[12px] text-ink-faint">
      <span>{machine.appleSilicon ? 'Apple Silicon' : 'Intel'}</span>
      <Dot />
      <span className="tabular-nums">{machine.totalRamGb} GB memory</span>
      <Dot />
      <span className="tabular-nums">{formatBytes(models.diskUsageBytes)} of models on disk</span>
      <Dot />
      <span title="Enforced when the catalog loads, not merely displayed">
        Origin policy: {models.catalog.originPolicy.join(', ') || '—'}
      </span>
    </p>
  )
}

function Dot(): React.JSX.Element {
  return <span aria-hidden="true">·</span>
}

// ---------------------------------------------------------------------------
// Import, sidecars, engine badge
// ---------------------------------------------------------------------------

/**
 * Bring your own model (PLAN §8 "Custom models").
 *
 * The engine has to be stated explicitly rather than sniffed from the
 * extension: a `.gguf` is loadable by both llama.cpp and whisper.cpp, and
 * guessing wrong produces a sidecar that starts and then fails on the first
 * request, which is a far worse experience than one extra dropdown.
 */
function ImportCard(): React.JSX.Element {
  const { importFile, error } = useModels()
  const [kind, setKind] = useState<ModelKind>('polish')
  const [engine, setEngine] = useState<ModelEngine>('llama-cpp')
  const [status, setStatus] = useState<string | null>(null)

  const choose = async (): Promise<void> => {
    const path = await window.murmur.models.chooseFile()
    if (!path) return
    const displayName = path.split('/').pop() ?? path
    await importFile({ kind, engine, displayName, path })
    setStatus(`Imported ${displayName}.`)
  }

  return (
    <Card>
      <h2 className="text-[15px] font-semibold text-ink">Import a model</h2>
      <p className="mt-1 text-[12px] leading-relaxed text-ink-muted">
        Point Murmur at a file you already have. Imported models skip the catalog, so their origin
        and licence cannot be verified — they are labelled accordingly.
      </p>

      <div className="mt-3.5 flex flex-wrap items-center gap-2">
        <select
          value={kind}
          aria-label="Model kind"
          onChange={(event) => setKind(event.target.value as ModelKind)}
          className="rounded-lg border border-line bg-surface px-2.5 py-1.5 text-[13px] text-ink outline-none focus:border-accent"
        >
          <option value="stt">Speech-to-text</option>
          <option value="polish">Polishing</option>
        </select>

        <select
          value={engine}
          aria-label="Runtime"
          onChange={(event) => setEngine(event.target.value as ModelEngine)}
          className="rounded-lg border border-line bg-surface px-2.5 py-1.5 text-[13px] text-ink outline-none focus:border-accent"
        >
          <option value="llama-cpp">llama.cpp (GGUF)</option>
          <option value="whisper-cpp">whisper.cpp (GGUF / bin)</option>
          <option value="onnx-runtime">ONNX Runtime</option>
        </select>

        <Button onClick={() => void choose()}>Choose file…</Button>
      </div>

      {status ? <p className="mt-2.5 text-[12px] text-positive">{status}</p> : null}
      {error ? <p className="mt-2.5 text-[12px] text-warning">{error}</p> : null}
    </Card>
  )
}

function SidecarInstallCard({
  title,
  body,
  which,
  onInstalled,
}: {
  title: string
  body: string
  which: 'llama-server' | 'whisper-server'
  onInstalled: () => void
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  const install = async (): Promise<void> => {
    // Ask *before* going busy: setting it first put the button in its
    // "Installing…" state behind the modal, so the confirm appeared over a UI
    // claiming work had already started.
    const ok = window.confirm(
      which === 'llama-server'
        ? 'Install llama-server so polishing models (Gemma, etc.) can run locally?\n\nMurmur will download an official Windows build from ggml-org/llama.cpp (a few hundred MB). Nothing leaves your machine except this download.'
        : 'Install whisper-server so speech-to-text models can run locally?\n\nMurmur will download an official Windows build from ggml-org/whisper.cpp.',
    )
    if (!ok) return

    setBusy(true)
    // Several hundred megabytes with no progress channel: without this the
    // button just sits there, indistinguishable from a hang.
    setNote('Downloading… this can take a few minutes.')
    try {
      const result = await window.murmur.engines.installSidecar({ which })
      if (result.ok) {
        setNote(result.detail)
        onInstalled()
      } else {
        setNote(result.detail || result.error || 'Install failed')
      }
    } catch (cause) {
      setNote(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card tone="warning" className="mb-3">
      <p className="text-[13px] font-semibold text-ink">{title}</p>
      <p className="mt-1 text-[12px] leading-relaxed text-ink-muted">{body}</p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button variant="primary" disabled={busy} onClick={() => void install()}>
          {busy ? 'Installing…' : `Install ${which}`}
        </Button>
        {note ? <span className="text-[12px] text-ink-muted">{note}</span> : null}
      </div>
    </Card>
  )
}

/**
 * The engine's own view of whether it can actually run.
 *
 * A model can be downloaded and selected and still not work — the sidecar
 * binary may be missing, or `onnxruntime-node` may not have loaded. Saying so
 * next to the model list is the difference between "why is nothing happening"
 * and "ah, I need to build the sidecars".
 */
function EngineBadge({ engine }: { engine: EngineStatus }): React.JSX.Element | null {
  switch (engine.state) {
    case 'ready':
      return <Badge tone="positive">Ready</Badge>
    case 'loading':
      return <Badge tone="neutral">Loading…</Badge>
    case 'unavailable':
    case 'error':
      return (
        <Badge tone="warning" title={engine.detail}>
          {engine.detail || engine.reason || 'Unavailable'}
        </Badge>
      )
    case 'idle':
      return null
  }
}
