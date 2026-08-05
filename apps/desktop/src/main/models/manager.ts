import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname } from 'node:path'

import {
  type ImportedModel,
  type ModelCatalog,
  type ModelDownloadProgress,
  type ModelEntry,
  type ModelImportRequest,
  type ModelsList,
} from '@murmur/shared'

import { createLogger, type Logger } from '../logging'
import type { ModelRef } from '../engines/types'
import { downloadModel, ChecksumMismatchError, DownloadCancelledError } from './downloader'
import { buildHardwareReport, detectMachine } from './hardware'
import {
  deleteModel,
  ensureModelDirectory,
  isModelInstalled,
  listInstalled,
  modelDirectory,
  modelsRoot,
  totalDiskUsage,
} from './storage'

/**
 * The model manager (PLAN §8).
 *
 * Owns the catalog (already origin-policy-validated at load), what is on disk,
 * in-flight downloads, and the mapping from "the settings say model X" to a
 * {@link ModelRef} an engine can load. Everything the Models section renders
 * comes from {@link list}.
 *
 * Downloads are tracked by an opaque `downloadId` rather than by model id, so
 * "cancel" cannot accidentally cancel a *different* download of the same model
 * started a moment later, and the renderer never has to reason about identity.
 */

export interface ModelManagerEvents {
  progress: [ModelDownloadProgress]
}

interface ActiveDownload {
  modelId: string
  controller: AbortController
}

export interface ModelManagerOptions {
  userDataPath: string
  catalog: ModelCatalog
  /** Set when the shipped catalog failed validation (PLAN §8). */
  catalogError?: string | null
  log?: Logger
}

export class ModelManager extends EventEmitter<ModelManagerEvents> {
  readonly root: string
  readonly #log: Logger
  readonly #downloads = new Map<string, ActiveDownload>()
  readonly #imported = new Map<string, ImportedModel>()
  #catalog: ModelCatalog
  #catalogError: string | null

  constructor(options: ModelManagerOptions) {
    super()
    this.root = modelsRoot(options.userDataPath)
    this.#catalog = options.catalog
    this.#catalogError = options.catalogError ?? null
    this.#log = options.log ?? createLogger('models')
  }

  get catalog(): ModelCatalog {
    return this.#catalog
  }

  entry(modelId: string): ModelEntry | null {
    return this.#catalog.models.find((model) => model.id === modelId) ?? null
  }

  /** Everything the Models section needs for one render. */
  list(): ModelsList {
    const installed = listInstalled(this.root, this.#catalog.models)
    const imported = [...this.#imported.values()]
    return {
      catalog: this.#catalog,
      installed: [
        ...installed,
        ...imported.map((model) => ({
          modelId: model.id,
          kind: model.kind,
          engine: model.engine,
          path: model.path,
          bytes: model.sizeBytes,
          installedAt: 0,
          source: 'import' as const,
        })),
      ],
      imported,
      diskUsageBytes: totalDiskUsage(this.root),
      hardware: buildHardwareReport(this.#catalog.models),
      catalogError: this.#catalogError,
    }
  }

  isInstalled(modelId: string): boolean {
    if (this.#imported.has(modelId)) return true
    const entry = this.entry(modelId)
    return entry ? isModelInstalled(this.root, entry) : false
  }

  /**
   * Turn a model id into something an engine can load, or `null` when the model
   * is not on disk. The engine turns `null` into `unavailable(model-missing)`.
   */
  resolve(modelId: string | null): ModelRef | null {
    if (!modelId) return null

    const imported = this.#imported.get(modelId)
    if (imported) {
      return {
        modelId,
        engine: imported.engine,
        directory: statSafeDirectory(imported.path),
        files: listFiles(statSafeDirectory(imported.path)),
      }
    }

    const entry = this.entry(modelId)
    if (!entry || !isModelInstalled(this.root, entry)) return null

    return {
      modelId,
      engine: entry.engine,
      directory: modelDirectory(this.root, modelId),
      files: entry.files.map((file) => file.filename),
    }
  }

  // -- downloads -----------------------------------------------------------

  /**
   * Start a download. Returns immediately with an id; progress arrives on the
   * `progress` event and is forwarded to the renderer over IPC.
   */
  startDownload(modelId: string): string {
    const entry = this.entry(modelId)
    if (!entry) throw new Error(`"${modelId}" is not in the catalog`)

    // One download per model: a second start while one is in flight would put
    // two writers on the same .partial file and corrupt it. Handing back the
    // existing id makes a double-click (or two windows racing) harmless.
    for (const [existingId, existing] of this.#downloads) {
      if (existing.modelId === modelId) return existingId
    }

    const downloadId = randomUUID()
    const controller = new AbortController()
    this.#downloads.set(downloadId, { modelId, controller })

    this.#emit({
      downloadId,
      modelId,
      receivedBytes: 0,
      totalBytes: entry.sizeBytes,
      status: 'queued',
      message: null,
    })

    void this.#run(downloadId, entry, controller)
    return downloadId
  }

  async #run(downloadId: string, entry: ModelEntry, controller: AbortController): Promise<void> {
    const directory = ensureModelDirectory(this.root, entry.id)

    try {
      await downloadModel({
        directory,
        entry,
        signal: controller.signal,
        log: this.#log,
        onProgress: ({ receivedBytes, totalBytes, bytesPerSecond }) => {
          this.#emit({
            downloadId,
            modelId: entry.id,
            receivedBytes,
            totalBytes,
            status: 'downloading',
            // Rate is the only thing the Bar/Hub can show that a byte count
            // cannot: "will this finish before my meeting".
            message: bytesPerSecond > 0 ? `${formatRate(bytesPerSecond)}` : null,
          })
        },
      })

      this.#emit({
        downloadId,
        modelId: entry.id,
        receivedBytes: entry.sizeBytes,
        totalBytes: entry.sizeBytes,
        status: 'complete',
        message: null,
      })
      this.#log.info(`downloaded ${entry.id}`)
    } catch (error) {
      if (error instanceof DownloadCancelledError || controller.signal.aborted) {
        this.#emit({
          downloadId,
          modelId: entry.id,
          receivedBytes: 0,
          totalBytes: entry.sizeBytes,
          status: 'cancelled',
          message: 'Cancelled. Partial data is kept so you can resume.',
        })
        return
      }

      const message =
        error instanceof ChecksumMismatchError
          ? error.message
          : error instanceof Error
            ? error.message
            : String(error)
      this.#log.error(`download of ${entry.id} failed:`, message)
      this.#emit({
        downloadId,
        modelId: entry.id,
        receivedBytes: 0,
        totalBytes: entry.sizeBytes,
        status: 'error',
        message,
      })
    } finally {
      this.#downloads.delete(downloadId)
    }
  }

  cancelDownload(downloadId: string): void {
    const active = this.#downloads.get(downloadId)
    if (!active) return
    active.controller.abort()
  }

  /** Abort everything in flight — called on quit. */
  cancelAll(): void {
    for (const [, active] of this.#downloads) active.controller.abort()
    this.#downloads.clear()
  }

  // -- delete / import -----------------------------------------------------

  delete(modelId: string): number {
    if (this.#imported.delete(modelId)) return 0
    const bytes = deleteModel(this.root, modelId)
    this.#log.info(`deleted ${modelId} (${bytes} bytes reclaimed)`)
    return bytes
  }

  /**
   * "Bring your own model" (PLAN §8).
   *
   * File imports are referenced in place rather than copied: a 4 GB GGUF the
   * user already has should not be duplicated into `userData`. The entry is
   * labelled `origin: 'unverified'` by the schema, which is what the UI badges.
   *
   * HF-repo imports are not implemented — they would need the download path to
   * accept a repo id with no checksum, which is exactly the property the
   * catalog exists to guarantee. It is refused explicitly rather than silently.
   */
  import(request: ModelImportRequest): ImportedModel {
    if (request.source.type !== 'file') {
      throw new Error(
        'Importing by Hugging Face repo id is not supported yet — download the file and import it ' +
          'from disk, so its checksum can be recorded.',
      )
    }

    const path = request.source.path
    if (!existsSync(path)) throw new Error(`No such file: ${path}`)

    const stats = statSync(path)
    const model: ImportedModel = {
      id: `imported:${basename(path)}:${randomUUID().slice(0, 8)}`,
      kind: request.kind,
      engine: request.engine,
      displayName: request.displayName,
      path,
      sizeBytes: stats.isDirectory() ? 0 : stats.size,
      origin: 'unverified',
    }
    this.#imported.set(model.id, model)
    this.#log.info(`imported ${model.displayName} (origin unverified)`)
    return model
  }

  /** Physical RAM + arch, for the Help panel. */
  machine(): ReturnType<typeof detectMachine> {
    return detectMachine()
  }

  #emit(progress: ModelDownloadProgress): void {
    this.emit('progress', progress)
  }
}

function formatRate(bytesPerSecond: number): string {
  const mb = bytesPerSecond / 1024 / 1024
  return mb >= 1 ? `${mb.toFixed(1)} MB/s` : `${Math.round(bytesPerSecond / 1024)} KB/s`
}

/** An imported model may point at a file or at a bundle directory. */
function statSafeDirectory(path: string): string {
  try {
    return statSync(path).isDirectory() ? path : dirname(path)
  } catch {
    return path
  }
}

function listFiles(directory: string): string[] {
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
  } catch {
    return []
  }
}
