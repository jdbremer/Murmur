import { useCallback, useMemo, useState } from 'react'

import type {
  EngineStatus,
  ImportedModel,
  ModelEngine,
  ModelEntry,
  ModelKind,
  ModelsList,
  Settings,
} from '@murmur/shared'

import {
  Badge,
  Banner,
  Button,
  Card,
  Field,
  InlineError,
  ProgressBar,
  Row,
  Section,
  Select,
  TextInput,
} from '../../components/Section'
import { useEngines } from '../../hooks/useEngines'
import { useModels, type ActiveDownload } from '../../hooks/useModels'
import { useSettings } from '../../hooks/useSettings'
import {
  downloadPercent,
  engineLabel,
  formatBytes,
  hardwareFitBadge,
  originFlag,
} from '../../lib/format'

/**
 * Models (PLAN §8).
 *
 * Two groups, speech-to-text and polishing, and one card per model carrying
 * everything a compliance-minded user needs at a glance: who published it,
 * where they are, the licence, the disk cost, and whether this machine can
 * actually run it.
 *
 * The catalog shown here has already passed the origin policy in the main
 * process — anything out of policy was *rejected at load*, not filtered here.
 * When that rejection happens the list is empty by design and the banner says
 * why, which is the whole point of enforcing a policy rather than printing one.
 */
export function ModelsSection(): React.JSX.Element {
  const { models, downloads, error, refresh, start, cancel } = useModels()
  const { settings, update } = useSettings()
  const engines = useEngines()
  const [actionError, setActionError] = useState<string | null>(null)

  const select = useCallback((kind: ModelKind, modelId: string | null) => {
    setActionError(null)
    void window.murmur.models
      .select({ kind, modelId })
      .catch((cause: unknown) => setActionError(messageOf(cause)))
  }, [])

  const remove = useCallback(
    (modelId: string) => {
      setActionError(null)
      void window.murmur.models
        .remove({ modelId })
        .then(refresh)
        .catch((cause: unknown) => setActionError(messageOf(cause)))
    },
    [refresh],
  )

  const groups = useMemo(() => groupModels(models), [models])

  return (
    <Section
      title="Models"
      description="The speech-to-text and polishing models Murmur runs on this machine. Downloads come from Hugging Face and are checksum-verified; nothing else leaves the device."
    >
      <InlineError>{error ?? actionError}</InlineError>

      {models?.catalogError ? (
        <div className="mb-5">
          <Banner tone="danger" title="The model catalog was rejected">
            <p>{models.catalogError}</p>
            <p className="mt-1.5">
              Murmur compiles its origin policy into the build and re-checks every entry when the
              catalog loads, so a mirrored or hand-edited catalog cannot add a model from outside
              the allowlist. Nothing is listed until the catalog validates again.
            </p>
          </Banner>
        </div>
      ) : null}

      <Card className="mb-6">
        <Row
          label="Origin policy"
          hint="Enforced when the catalog loads — not merely displayed here."
        >
          <Badge tone="accent">
            {(models?.catalog.originPolicy ?? []).map(originFlag).join(' ')}{' '}
            {(models?.catalog.originPolicy ?? ['—']).join(', ')} only
          </Badge>
        </Row>
        <Row label="Disk used by models">
          <span className="text-[13px] tabular-nums text-ink">
            {formatBytes(models?.diskUsageBytes)}
          </span>
        </Row>
        <Row label="This machine" hint="What the hardware badges below are measured against.">
          <span className="text-[13px] text-ink">
            {models
              ? `${models.hardware.machine.appleSilicon ? 'Apple Silicon' : models.hardware.machine.arch} · ${models.hardware.machine.totalRamGb} GB`
              : '—'}
          </span>
        </Row>
      </Card>

      <ModelGroup
        title="Speech to text"
        description="Turns your voice into a transcript."
        kind="stt"
        entries={groups.stt}
        models={models}
        settings={settings}
        engine={engines?.stt ?? null}
        downloads={downloads}
        onDownload={start}
        onCancel={cancel}
        onSelect={select}
        onDelete={remove}
      />

      <ModelGroup
        title="Polishing"
        description="Rewrites the transcript into finished text. Optional — set the level in Style."
        kind="polish"
        entries={groups.polish}
        models={models}
        settings={settings}
        engine={engines?.polish ?? null}
        downloads={downloads}
        onDownload={start}
        onCancel={cancel}
        onSelect={select}
        onDelete={remove}
      />

      <ImportedModels models={models} onSelect={select} onDelete={remove} settings={settings} />

      <CustomImport onImported={refresh} />

      <ExternalEndpoint
        settings={settings}
        onSave={(endpoint) => void update({ externalEndpoint: endpoint })}
        warnings={engines?.polish.warnings ?? []}
      />
    </Section>
  )
}

// ---------------------------------------------------------------------------
// Groups & cards
// ---------------------------------------------------------------------------

function ModelGroup({
  title,
  description,
  kind,
  entries,
  models,
  settings,
  engine,
  downloads,
  onDownload,
  onCancel,
  onSelect,
  onDelete,
}: {
  title: string
  description: string
  kind: ModelKind
  entries: ModelEntry[]
  models: ModelsList | null
  settings: Settings | null
  engine: EngineStatus | null
  downloads: Record<string, ActiveDownload>
  onDownload: (modelId: string) => void
  onCancel: (modelId: string) => void
  onSelect: (kind: ModelKind, modelId: string | null) => void
  onDelete: (modelId: string) => void
}): React.JSX.Element {
  const activeId =
    kind === 'stt' ? (settings?.sttModelId ?? null) : (settings?.polishModelId ?? null)

  return (
    <div className="mb-8">
      <header className="mb-3 flex items-baseline justify-between gap-4">
        <h2 className="text-[15px] font-semibold text-ink">{title}</h2>
        <p className="text-[12px] text-ink-muted">{description}</p>
      </header>

      {engine ? <EngineBadges engine={engine} /> : null}

      {entries.length === 0 ? (
        <Card className="border-dashed">
          <p className="text-[13px] text-ink-muted">
            No {kind === 'stt' ? 'speech-to-text' : 'polishing'} models are listed. If the banner
            above is showing, the catalog failed validation and nothing is offered until it passes.
          </p>
        </Card>
      ) : (
        <ul className="space-y-2">
          {entries.map((entry) => (
            <li key={entry.id}>
              <ModelCard
                entry={entry}
                installed={isInstalled(models, entry.id)}
                active={activeId === entry.id}
                fit={models?.hardware.fits[entry.id] ?? null}
                download={downloads[entry.id] ?? null}
                onDownload={() => onDownload(entry.id)}
                onCancel={() => onCancel(entry.id)}
                onActivate={() => onSelect(entry.kind, entry.id)}
                onDeactivate={() => onSelect(entry.kind, null)}
                onDelete={() => onDelete(entry.id)}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function ModelCard({
  entry,
  installed,
  active,
  fit,
  download,
  onDownload,
  onCancel,
  onActivate,
  onDeactivate,
  onDelete,
}: {
  entry: ModelEntry
  installed: boolean
  active: boolean
  fit: string | null
  download: ActiveDownload | null
  onDownload: () => void
  onCancel: () => void
  onActivate: () => void
  onDeactivate: () => void
  onDelete: () => void
}): React.JSX.Element {
  const downloading = download !== null && !download.finished
  const badge = fit ? hardwareFitBadge(fit as never) : null

  return (
    <Card className={active ? 'border-accent/50' : ''}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-[14px] font-medium text-ink">
            {entry.displayName}
            {active ? <Badge tone="accent">Active</Badge> : null}
            {entry.recommended && !active ? <Badge tone="neutral">Recommended</Badge> : null}
          </p>
          <p className="mt-0.5 text-[12px] text-ink-muted">
            {entry.org} · {engineLabel(entry.engine)} · {entry.quant} ·{' '}
            {entry.languages.includes('multi') ? 'multilingual' : entry.languages.join(', ')}
          </p>
          {entry.notes ? (
            <p className="mt-1 max-w-lg text-[12px] leading-relaxed text-ink-faint">
              {entry.notes}
            </p>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {installed && !active ? (
            <Button tone="primary" onClick={onActivate}>
              Use this model
            </Button>
          ) : null}
          {active ? (
            <Button onClick={onDeactivate} title="Stop using this model">
              Deactivate
            </Button>
          ) : null}
          {!installed && !downloading ? (
            <Button tone="primary" onClick={onDownload}>
              Download {formatBytes(entry.sizeBytes)}
            </Button>
          ) : null}
          {downloading ? (
            <Button onClick={onCancel} label={`Cancel downloading ${entry.displayName}`}>
              Cancel
            </Button>
          ) : null}
          {installed ? (
            <Button
              tone="danger"
              onClick={onDelete}
              title={`Deleting frees ${formatBytes(entry.sizeBytes)}`}
            >
              Delete
            </Button>
          ) : null}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <Badge tone="neutral" title={`Published by a ${entry.origin}-based organisation`}>
          {originFlag(entry.origin)} {entry.origin}
        </Badge>
        <Badge tone="neutral">{entry.license}</Badge>
        <Badge tone="neutral">{formatBytes(entry.sizeBytes)}</Badge>
        {badge ? (
          <Badge tone={badge.tone} title={badge.hint}>
            {badge.label}
          </Badge>
        ) : null}
        <Badge tone={installed ? 'positive' : 'neutral'}>
          {installed ? 'Downloaded' : 'Not downloaded'}
        </Badge>
      </div>

      {download ? <DownloadState download={download} entry={entry} /> : null}
    </Card>
  )
}

function DownloadState({
  download,
  entry,
}: {
  download: ActiveDownload
  entry: ModelEntry
}): React.JSX.Element | null {
  if (download.status === 'complete') return null
  if (download.status === 'cancelled') {
    return <p className="mt-3 text-[12px] text-ink-muted">Download cancelled.</p>
  }
  if (download.status === 'error') {
    return (
      <p role="alert" className="mt-3 text-[12px] text-danger">
        {download.message ?? 'The download failed.'} Try again — finished parts are resumed.
      </p>
    )
  }

  const total = download.totalBytes > 0 ? download.totalBytes : entry.sizeBytes
  const percent = downloadPercent(download.receivedBytes, total)

  return (
    <div className="mt-3">
      <ProgressBar percent={percent} label={`Downloading ${entry.displayName}`} />
      <p className="mt-1.5 text-[11px] tabular-nums text-ink-muted">
        {download.status === 'verifying'
          ? 'Verifying checksum…'
          : download.status === 'queued'
            ? 'Starting…'
            : `${percent}% · ${formatBytes(download.receivedBytes)} of ${formatBytes(total)}`}
      </p>
    </div>
  )
}

/** Engine lifecycle for one slot: state, plus any advisories as badges. */
function EngineBadges({ engine }: { engine: EngineStatus }): React.JSX.Element {
  const tone =
    engine.state === 'ready'
      ? 'positive'
      : engine.state === 'error'
        ? 'danger'
        : engine.state === 'unavailable'
          ? 'warning'
          : 'neutral'

  return (
    <div className="mb-3 flex flex-wrap items-center gap-1.5">
      <Badge tone={tone} title={engine.detail || undefined}>
        {engine.state}
        {engine.reason ? ` · ${engine.reason}` : ''}
      </Badge>
      {engine.warnings.map((warning) => (
        <Badge key={warning} tone="warning" title={warning}>
          {warning}
        </Badge>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Bring your own model
// ---------------------------------------------------------------------------

function ImportedModels({
  models,
  settings,
  onSelect,
  onDelete,
}: {
  models: ModelsList | null
  settings: Settings | null
  onSelect: (kind: ModelKind, modelId: string | null) => void
  onDelete: (modelId: string) => void
}): React.JSX.Element | null {
  const imported: ImportedModel[] = models?.imported ?? []
  if (imported.length === 0) return null

  return (
    <div className="mb-8">
      <h2 className="mb-3 text-[15px] font-semibold text-ink">Your own models</h2>
      <ul className="space-y-2">
        {imported.map((model) => {
          const active =
            (model.kind === 'stt' ? settings?.sttModelId : settings?.polishModelId) === model.id
          return (
            <li key={model.id}>
              <Card className={active ? 'border-accent/50' : ''}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 text-[14px] font-medium text-ink">
                      {model.displayName}
                      {active ? <Badge tone="accent">Active</Badge> : null}
                    </p>
                    <p className="mt-0.5 select-text truncate font-mono text-[11px] text-ink-faint">
                      {model.path}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    {active ? (
                      <Button onClick={() => onSelect(model.kind, null)}>Deactivate</Button>
                    ) : (
                      <Button tone="primary" onClick={() => onSelect(model.kind, model.id)}>
                        Use this model
                      </Button>
                    )}
                    <Button tone="danger" onClick={() => onDelete(model.id)}>
                      Remove
                    </Button>
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  <Badge tone="warning" title="Imported files bypass the catalog by definition.">
                    User-supplied — origin unverified
                  </Badge>
                  <Badge tone="neutral">{engineLabel(model.engine)}</Badge>
                  <Badge tone="neutral">
                    {model.kind === 'stt' ? 'Speech to text' : 'Polishing'}
                  </Badge>
                  {model.sizeBytes > 0 ? (
                    <Badge tone="neutral">{formatBytes(model.sizeBytes)}</Badge>
                  ) : null}
                </div>
              </Card>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

const KINDS: readonly { value: ModelKind; label: string }[] = [
  { value: 'stt', label: 'Speech to text' },
  { value: 'polish', label: 'Polishing' },
]

const ENGINES: readonly { value: ModelEngine; label: string }[] = [
  { value: 'whisper-cpp', label: 'whisper.cpp (GGUF)' },
  { value: 'onnx-runtime', label: 'ONNX Runtime (ONNX bundle)' },
  { value: 'llama-cpp', label: 'llama.cpp (GGUF)' },
]

function CustomImport({ onImported }: { onImported: () => void }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [path, setPath] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [kind, setKind] = useState<ModelKind>('polish')
  const [engine, setEngine] = useState<ModelEngine>('llama-cpp')
  const [error, setError] = useState<string | null>(null)

  const submit = useCallback(() => {
    setError(null)
    void window.murmur.models
      .import({
        kind,
        engine,
        displayName: displayName.trim() || path.split('/').pop() || 'Imported model',
        source: { type: 'file', path: path.trim() },
      })
      .then(() => {
        setOpen(false)
        setPath('')
        setDisplayName('')
        onImported()
      })
      .catch((cause: unknown) => setError(messageOf(cause)))
  }, [displayName, engine, kind, onImported, path])

  return (
    <div className="mb-8">
      <Card>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-[15px] font-semibold text-ink">Import your own model</h2>
            <p className="mt-1 max-w-lg text-[12px] leading-relaxed text-ink-muted">
              Point Murmur at a GGUF file (whisper.cpp or llama.cpp) or an ONNX bundle directory you
              already have. Imports bypass the catalog by definition, so they carry no origin or
              checksum guarantee and are labelled as such everywhere they appear.
            </p>
          </div>
          <Button onClick={() => setOpen((value) => !value)}>{open ? 'Close' : 'Import'}</Button>
        </div>

        {open ? (
          <div className="mt-4 space-y-3 border-t border-line pt-4">
            <Field
              label="File or directory path"
              htmlFor="import-path"
              hint="An absolute path on this machine. The file is referenced where it is, never copied."
            >
              <TextInput
                id="import-path"
                label="Model file path"
                value={path}
                onChange={setPath}
                placeholder="/Users/you/models/my-model.gguf"
              />
            </Field>
            <Field label="Name" htmlFor="import-name">
              <TextInput
                id="import-name"
                label="Display name"
                value={displayName}
                onChange={setDisplayName}
                placeholder="Defaults to the file name"
              />
            </Field>
            <div className="flex flex-wrap gap-4">
              <Field label="Used for" htmlFor="import-kind">
                <Select
                  id="import-kind"
                  label="Model kind"
                  value={kind}
                  options={KINDS}
                  onChange={setKind}
                />
              </Field>
              <Field label="Runtime" htmlFor="import-engine">
                <Select
                  id="import-engine"
                  label="Runtime"
                  value={engine}
                  options={ENGINES}
                  onChange={setEngine}
                />
              </Field>
            </div>
            <InlineError>{error}</InlineError>
            <Button tone="primary" onClick={submit} disabled={path.trim().length === 0}>
              Import model
            </Button>
          </div>
        ) : null}
      </Card>
    </div>
  )
}

// ---------------------------------------------------------------------------
// External endpoint
// ---------------------------------------------------------------------------

function ExternalEndpoint({
  settings,
  warnings,
  onSave,
}: {
  settings: Settings | null
  warnings: readonly string[]
  onSave: (endpoint: Settings['externalEndpoint']) => void
}): React.JSX.Element {
  const current = settings?.externalEndpoint ?? null
  const [open, setOpen] = useState(current !== null)
  const [baseUrl, setBaseUrl] = useState(current?.baseUrl ?? '')
  const [apiKey, setApiKey] = useState(current?.apiKey ?? '')
  const [model, setModel] = useState(current?.model ?? '')
  const [error, setError] = useState<string | null>(null)

  const save = useCallback(() => {
    setError(null)
    if (!/^https?:\/\//i.test(baseUrl.trim())) {
      setError('Enter a full URL, for example http://127.0.0.1:1234/v1')
      return
    }
    if (model.trim().length === 0) {
      setError('Name the model the endpoint should be asked for.')
      return
    }
    onSave({
      baseUrl: baseUrl.trim(),
      apiKey: apiKey.trim().length > 0 ? apiKey.trim() : null,
      model: model.trim(),
    })
  }, [apiKey, baseUrl, model, onSave])

  return (
    <Card>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-[15px] font-semibold text-ink">
            Use a local OpenAI-compatible endpoint
          </h2>
          <p className="mt-1 max-w-lg text-[12px] leading-relaxed text-ink-muted">
            Polish with Ollama, LM Studio or a company-hosted server instead of the bundled
            llama-server. Murmur checks the address and warns when it is not on this machine or your
            own network — “local only” has to stay true to mean anything.
          </p>
        </div>
        <Button onClick={() => setOpen((value) => !value)}>{open ? 'Close' : 'Configure'}</Button>
      </div>

      {warnings.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {warnings.map((warning) => (
            <Badge key={warning} tone="warning" title={warning}>
              {warning}
            </Badge>
          ))}
        </div>
      ) : null}

      {open ? (
        <div className="mt-4 space-y-3 border-t border-line pt-4">
          <Field
            label="Base URL"
            htmlFor="endpoint-url"
            hint="Include the /v1 path if the server uses one."
          >
            <TextInput
              id="endpoint-url"
              label="Endpoint base URL"
              value={baseUrl}
              onChange={setBaseUrl}
              placeholder="http://127.0.0.1:11434/v1"
            />
          </Field>
          <Field label="Model name" htmlFor="endpoint-model">
            <TextInput
              id="endpoint-model"
              label="Endpoint model name"
              value={model}
              onChange={setModel}
              placeholder="gemma3:4b"
            />
          </Field>
          <Field
            label="API key (optional)"
            htmlFor="endpoint-key"
            hint="Stored in settings.json on this machine. Local servers usually need none."
          >
            <TextInput
              id="endpoint-key"
              label="Endpoint API key"
              value={apiKey}
              onChange={setApiKey}
              placeholder="—"
            />
          </Field>
          <InlineError>{error}</InlineError>
          <div className="flex gap-2">
            <Button tone="primary" onClick={save}>
              Use this endpoint
            </Button>
            {current ? (
              <Button
                onClick={() => {
                  onSave(null)
                  setBaseUrl('')
                  setApiKey('')
                  setModel('')
                }}
              >
                Stop using it
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
    </Card>
  )
}

// ---------------------------------------------------------------------------

function groupModels(models: ModelsList | null): { stt: ModelEntry[]; polish: ModelEntry[] } {
  const entries = models?.catalog.models ?? []
  return {
    stt: entries.filter((entry) => entry.kind === 'stt'),
    polish: entries.filter((entry) => entry.kind === 'polish'),
  }
}

function isInstalled(models: ModelsList | null, modelId: string): boolean {
  return (models?.installed ?? []).some((installed) => installed.modelId === modelId)
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
