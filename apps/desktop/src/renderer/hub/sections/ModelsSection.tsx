import { useState } from 'react'

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
  Row,
  Section,
} from '../../components/Section'
import { isWindowsPlatform } from '../../lib/platform'
import { useModels } from '../../hooks/useModels'
import { useSettings } from '../../hooks/useSettings'
import { formatBytes, formatLanguages } from '../../format'

/**
 * Models (PLAN §8).
 *
 * The catalog shown here has already passed the origin policy in the main
 * process — anything out of policy was rejected at load, not filtered here, so
 * an empty list means "the catalog failed validation", which is why
 * `catalogError` gets its own loud treatment rather than rendering as "no
 * models found".
 *
 * Every row states its provenance (organisation, origin, licence) because that
 * is the claim the whole product rests on, and the hardware badge next to it is
 * the one thing that stops someone downloading 4.5 GB onto a machine that
 * cannot run it.
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

  if (!models) {
    return <Section title="Models" description="Loading the catalog…" />
  }

  const selectedFor = (kind: ModelKind): string | null =>
    kind === 'stt' ? (settings?.sttModelId ?? null) : (settings?.polishModelId ?? null)

  const installedIds = new Set(models.installed.map((model) => model.modelId))

  return (
    <Section
      title="Models"
      description="Choose the speech-to-text and polishing models Murmur runs locally. Both stay on this machine."
    >
      {error ? <ErrorCard>{error}</ErrorCard> : null}
      {models.catalogError ? (
        <ErrorCard>
          The shipped catalog was rejected: {models.catalogError} — no models can be listed until it
          validates against the origin policy.
        </ErrorCard>
      ) : null}

      <Card className="mb-5">
        <Row label="Origin policy" hint="Enforced when the catalog loads, not merely displayed.">
          <Badge tone="accent">{models.catalog.originPolicy.join(', ') || '—'}</Badge>
        </Row>
        <Row label="This machine" hint="Drives the per-model fit badges.">
          <span className="text-[13px] text-ink">
            {models.hardware.machine.appleSilicon ? 'Apple Silicon' : 'Intel'} ·{' '}
            {models.hardware.machine.totalRamGb} GB RAM
          </span>
        </Row>
        <Row label="Disk used" hint="Downloaded weights under Application Support.">
          <span className="text-[13px] tabular-nums text-ink">
            {formatBytes(models.diskUsageBytes)}
          </span>
        </Row>
      </Card>

      {(['stt', 'polish'] as const).map((kind) => (
        <ModelGroup
          key={kind}
          kind={kind}
          models={models}
          engine={kind === 'stt' ? engines?.stt : engines?.polish}
          llamaRuntimeReady={engines?.sidecars?.llama?.installed === true}
          whisperRuntimeReady={engines?.sidecars?.whisper?.installed === true}
          selectedId={selectedFor(kind)}
          installedIds={installedIds}
          downloads={downloads}
          busyModelId={busyModelId}
          onDownload={download}
          onCancel={cancel}
          onSelect={select}
          onRemove={remove}
          onRefresh={() => void refreshModels(refresh)}
        />
      ))}

      <ImportCard />
    </Section>
  )
}

function ModelGroup({
  kind,
  models,
  engine,
  llamaRuntimeReady,
  whisperRuntimeReady,
  selectedId,
  installedIds,
  downloads,
  busyModelId,
  onDownload,
  onCancel,
  onSelect,
  onRemove,
  onRefresh,
}: {
  kind: ModelKind
  models: ModelsList
  engine: EngineStatus | undefined
  llamaRuntimeReady: boolean
  whisperRuntimeReady: boolean
  selectedId: string | null
  installedIds: ReadonlySet<string>
  downloads: Record<string, ModelDownloadProgress>
  busyModelId: string | null
  onDownload: (modelId: string) => Promise<void>
  onCancel: (modelId: string) => Promise<void>
  onSelect: (kind: ModelKind, modelId: string | null) => Promise<void>
  onRemove: (modelId: string) => Promise<void>
  onRefresh: () => void
}): React.JSX.Element {
  const entries = models.catalog.models.filter((entry) => entry.kind === kind)
  const imported = models.imported.filter((entry) => entry.kind === kind)
  const runtimeReady = kind === 'polish' ? llamaRuntimeReady : whisperRuntimeReady

  return (
    <div className="mb-7">
      <div className="mb-2.5 flex items-baseline justify-between">
        <h2 className="text-[15px] font-semibold text-ink">{KIND_TITLE[kind]}</h2>
        {engine ? <EngineBadge engine={engine} /> : null}
      </div>

      {/* The in-app download flow ships Windows builds only (engines.installSidecar
          refuses elsewhere); mac/linux keep the engine badge + searched-paths story. */}
      {kind === 'polish' && !llamaRuntimeReady && isWindowsPlatform() ? (
        <SidecarInstallCard
          title="Polishing needs llama-server"
          body="Gemma and other polish models are weights only. Murmur also needs the local llama-server runtime (like whisper-server for speech). Without it, dictation still works — text is inserted raw."
          which="llama-server"
          onInstalled={onRefresh}
        />
      ) : null}
      {kind === 'stt' && !whisperRuntimeReady && isWindowsPlatform() ? (
        <SidecarInstallCard
          title="Speech needs whisper-server"
          body="Whisper models need the local whisper-server binary next to the app."
          which="whisper-server"
          onInstalled={onRefresh}
        />
      ) : null}

      {entries.length === 0 && imported.length === 0 ? (
        <EmptyState>
          No {KIND_TITLE[kind].toLowerCase()} models are listed in the catalog.
        </EmptyState>
      ) : (
        <ul className="space-y-2">
          {entries.map((entry) => (
            <li key={entry.id}>
              <ModelRow
                entry={entry}
                fit={models.hardware.fits[entry.id]}
                installed={installedIds.has(entry.id)}
                selected={selectedId === entry.id}
                progress={downloads[entry.id]}
                busy={busyModelId === entry.id}
                showRecommended={Boolean(entry.recommended) && runtimeReady}
                runtimeReady={runtimeReady}
                onDownload={() => void onDownload(entry.id)}
                onCancel={() => void onCancel(entry.id)}
                onSelect={() => void onSelect(kind, entry.id)}
                onDeselect={() => void onSelect(kind, null)}
                onRemove={() => void onRemove(entry.id)}
              />
            </li>
          ))}
          {imported.map((entry) => (
            <li key={entry.id}>
              <ImportedRow
                entry={entry}
                selected={selectedId === entry.id}
                busy={busyModelId === entry.id}
                onSelect={() => void onSelect(kind, entry.id)}
                onDeselect={() => void onSelect(kind, null)}
                onRemove={() => void onRemove(entry.id)}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function ModelRow({
  entry,
  fit,
  installed,
  selected,
  progress,
  busy,
  showRecommended,
  runtimeReady,
  onDownload,
  onCancel,
  onSelect,
  onDeselect,
  onRemove,
}: {
  entry: ModelEntry
  fit: HardwareFit | undefined
  installed: boolean
  selected: boolean
  progress: ModelDownloadProgress | undefined
  busy: boolean
  showRecommended: boolean
  runtimeReady: boolean
  onDownload: () => void
  onCancel: () => void
  onSelect: () => void
  onDeselect: () => void
  onRemove: () => void
}): React.JSX.Element {
  const downloading =
    progress?.status === 'queued' ||
    progress?.status === 'downloading' ||
    progress?.status === 'verifying'
  const failed = progress?.status === 'error'

  return (
    <Card className={selected ? 'border-accent/50' : ''}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-[13px] font-semibold text-ink">{entry.displayName}</h3>
            {showRecommended ? <Badge tone="accent">Recommended</Badge> : null}
            {!runtimeReady && entry.kind === 'polish' ? (
              <Badge tone="warning" title="Install llama-server first (button above)">
                Needs runtime
              </Badge>
            ) : null}
            {selected ? <Badge tone="positive">In use</Badge> : null}
            {fit ? (
              <Badge
                tone={FIT_TONE[fit]}
                title={`Based on ${entry.ramTierGb} GB recommended memory`}
              >
                {FIT_LABEL[fit]}
              </Badge>
            ) : null}
          </div>
          <p className="mt-1 text-[12px] text-ink-muted">
            {entry.org} · {entry.origin} · {entry.license}
          </p>
          <p className="mt-0.5 text-[12px] text-ink-faint">
            {formatBytes(entry.sizeBytes)} · {entry.quant} · {ENGINE_LABEL[entry.engine]} ·{' '}
            {formatLanguages(entry.languages)}
          </p>
          {entry.notes ? <p className="mt-1.5 text-[12px] text-ink-muted">{entry.notes}</p> : null}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {downloading ? (
            <Button onClick={onCancel} variant="secondary">
              Cancel
            </Button>
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
              {failed ? 'Retry' : 'Download'}
            </Button>
          )}
        </div>
      </div>

      {downloading ? <DownloadProgress progress={progress} entry={entry} /> : null}

      {progress && !downloading && progress.status !== 'complete' ? (
        <p
          className={`mt-2.5 text-[12px] ${
            progress.status === 'error' ? 'text-warning' : 'text-ink-muted'
          }`}
        >
          {progress.message ?? (progress.status === 'cancelled' ? 'Cancelled.' : '')}
        </p>
      ) : null}
    </Card>
  )
}

function DownloadProgress({
  progress,
  entry,
}: {
  progress: ModelDownloadProgress
  entry: ModelEntry
}): React.JSX.Element {
  const total = progress.totalBytes || entry.sizeBytes
  // `verifying` has no byte progress to report — the bar goes indeterminate
  // rather than sitting at 100% pretending to still be downloading.
  const fraction =
    progress.status === 'verifying' || total <= 0 ? null : progress.receivedBytes / total

  return (
    <div className="mt-3">
      <ProgressBar value={fraction} />
      <div className="mt-1.5 flex justify-between text-[12px] text-ink-muted">
        <span>
          {progress.status === 'queued'
            ? 'Queued…'
            : progress.status === 'verifying'
              ? 'Verifying checksum…'
              : `${formatBytes(progress.receivedBytes)} of ${formatBytes(total)}`}
        </span>
        {progress.message && progress.status === 'downloading' ? (
          <span className="tabular-nums">{progress.message}</span>
        ) : null}
      </div>
    </div>
  )
}

function ImportedRow({
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
    <Card className={selected ? 'border-accent/50' : ''}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-[13px] font-semibold text-ink">{entry.displayName}</h3>
            <Badge tone="warning" title="Imported models bypass the catalog's origin policy">
              Origin unverified
            </Badge>
            {selected ? <Badge tone="positive">In use</Badge> : null}
          </div>
          <p className="mt-1 truncate text-[12px] text-ink-faint" title={entry.path}>
            {entry.path}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
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
      </div>
    </Card>
  )
}

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
    setBusy(true)
    setNote(null)
    try {
      const ok = window.confirm(
        which === 'llama-server'
          ? 'Install llama-server so polishing models (Gemma, etc.) can run locally?\n\nMurmur will download an official Windows build from ggml-org/llama.cpp (a few hundred MB). Nothing leaves your machine except this download.'
          : 'Install whisper-server so speech-to-text models can run locally?\n\nMurmur will download an official Windows build from ggml-org/whisper.cpp.',
      )
      if (!ok) {
        setBusy(false)
        return
      }
      const result = await window.murmur.engines.installSidecar({ which })
      if (result.ok) {
        setNote(result.detail)
        onInstalled()
      } else {
        setNote(result.detail || result.error || 'Install failed')
      }
    } catch (cause) {
      setNote(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="mb-3 border-warning/40">
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

function refreshModels(refresh: () => Promise<void>): Promise<void> {
  return refresh()
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
