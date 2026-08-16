import type { TranscriptionJob, TranscriptionSegment } from '@murmur/shared'

import { decodeFileToPcm } from './decoder'

/**
 * The Hub's half of file transcription (PLAN §18.4).
 *
 * A module singleton, not React state, for one load-bearing reason: switching
 * sections unmounts the section component, and a half-pushed audiobook must
 * not die because the user glanced at History. The decode/push loop lives
 * here, outlives any component, and the section subscribes to snapshots via
 * `useSyncExternalStore`.
 *
 * Files are processed strictly one at a time. Decoding is the memory-heavy
 * step (see decoder.ts) and main enforces one live job anyway — a visible
 * queue that drains in order is both the honest UI and the cheap one.
 */

export type TranscribeItemStatus =
  'waiting' | 'reading' | 'transcribing' | 'done' | 'failed' | 'cancelled'

export interface TranscribeItem {
  /** Local identity — exists before main has assigned a job id. */
  key: string
  fileName: string
  /** Null for jobs adopted from main after a Hub reload. */
  fileBytes: number | null
  status: TranscribeItemStatus
  /** Main's snapshot, once a job exists. */
  job: TranscriptionJob | null
  error: string | null
  /** Segments as they arrive, in file order. */
  segments: TranscriptionSegment[]
  /** Where the last export landed, for the row's confirmation line. */
  exportedTo: string | null
}

type Listener = () => void

/** Slices pushed per IPC round trip: 15 s ≙ 960 KB, well under the 60 s cap. */
const SLICE_SAMPLES = 16_000 * 15

class TranscribeClient {
  #items: TranscribeItem[] = []
  #snapshot: readonly TranscribeItem[] = []
  readonly #listeners = new Set<Listener>()
  readonly #files = new Map<string, File>()
  readonly #cancelRequested = new Set<string>()
  #busy = false
  #initialised = false
  #nextKey = 1

  /**
   * Adopt whatever main still remembers, then follow its events.
   *
   * Idempotent, and called from the hook's first subscribe — by then
   * `window.murmur` is guaranteed to exist, which an eager module-load
   * subscription could not say.
   */
  init(): void {
    if (this.#initialised) return
    this.#initialised = true

    window.murmur.transcribe.subscribe(({ job, segment }) => {
      this.#onJobEvent(job, segment)
    })

    void window.murmur.transcribe
      .list()
      .then((jobs) => {
        for (const job of jobs) {
          if (this.#items.some((item) => item.job?.id === job.id)) continue
          this.#items.push({
            key: this.#key(),
            fileName: job.fileName,
            fileBytes: null,
            status: statusOf(job),
            job,
            error: job.error,
            segments: [],
            exportedTo: null,
          })
        }
        if (jobs.length > 0) this.#publish()
      })
      .catch(() => undefined)
  }

  subscribe = (listener: Listener): (() => void) => {
    this.init()
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  snapshot = (): readonly TranscribeItem[] => this.#snapshot

  addFiles(files: readonly File[]): void {
    for (const file of files) {
      const item: TranscribeItem = {
        key: this.#key(),
        fileName: file.name,
        fileBytes: file.size,
        status: 'waiting',
        job: null,
        error: null,
        segments: [],
        exportedTo: null,
      }
      this.#files.set(item.key, file)
      this.#items.push(item)
    }
    this.#publish()
    void this.#advance()
  }

  cancel(key: string): void {
    const item = this.#item(key)
    if (!item) return

    this.#cancelRequested.add(key)
    if (item.status === 'waiting' || item.status === 'reading') {
      // Nothing is in main yet; the decode (if any) checks the flag when done.
      this.#update(key, { status: 'cancelled' })
      this.#files.delete(key)
    } else if (item.status === 'transcribing' && item.job) {
      // Main owns the job now; its `cancelled` event finishes the story.
      void window.murmur.transcribe.cancel({ jobId: item.job.id }).catch(() => undefined)
    }
  }

  remove(key: string): void {
    const item = this.#item(key)
    if (!item || item.status === 'waiting' || item.status === 'reading') return
    if (item.status === 'transcribing') return // cancel first, explicitly
    if (item.job) {
      void window.murmur.transcribe.clear({ jobId: item.job.id }).catch(() => undefined)
    }
    this.#files.delete(key)
    this.#cancelRequested.delete(key)
    this.#items = this.#items.filter((candidate) => candidate.key !== key)
    this.#publish()
  }

  /** Fetch segments for a job adopted after a reload; a no-op otherwise. */
  async ensureSegments(key: string): Promise<void> {
    const item = this.#item(key)
    if (!item?.job || item.segments.length > 0 || item.job.segmentCount === 0) return
    const result = await window.murmur.transcribe.result({ jobId: item.job.id })
    if (result) this.#update(key, { segments: result.segments })
  }

  noteExport(key: string, path: string | null): void {
    if (path) this.#update(key, { exportedTo: path })
  }

  // -- the pipeline ----------------------------------------------------------

  async #advance(): Promise<void> {
    if (this.#busy) return
    const item = this.#items.find((candidate) => candidate.status === 'waiting')
    if (!item) return
    this.#busy = true
    try {
      await this.#process(item.key)
    } finally {
      this.#busy = false
      void this.#advance()
    }
  }

  async #process(key: string): Promise<void> {
    const file = this.#files.get(key)
    if (!file || this.#cancelRequested.has(key)) {
      // Whatever the story, the item must leave `waiting` — an item that stays
      // there is re-found by #advance forever.
      if (this.#item(key)?.status === 'waiting') this.#update(key, { status: 'cancelled' })
      return
    }

    this.#update(key, { status: 'reading' })

    let pcm: Float32Array
    let durationMs: number
    try {
      ;({ pcm, durationMs } = await decodeFileToPcm(file))
    } catch (error) {
      if (!this.#cancelRequested.has(key)) {
        this.#update(key, { status: 'failed', error: describe(error) })
      }
      this.#files.delete(key)
      return
    }
    // The File served its purpose; drop it so the GC can have the container.
    this.#files.delete(key)

    if (this.#cancelRequested.has(key)) return

    let job: TranscriptionJob
    try {
      job = await window.murmur.transcribe.begin({ fileName: file.name, totalMs: durationMs })
    } catch (error) {
      this.#update(key, { status: 'failed', error: describe(error) })
      return
    }
    this.#update(key, { status: 'transcribing', job })

    try {
      for (let at = 0; at < pcm.length; at += SLICE_SAMPLES) {
        if (this.#cancelRequested.has(key)) return
        const slice = pcm.subarray(at, Math.min(at + SLICE_SAMPLES, pcm.length))
        // A copy, deliberately: sending a view would serialise the entire
        // underlying buffer — the whole decoded file — with every slice.
        const copy = slice.slice()
        await window.murmur.transcribe.push({
          jobId: job.id,
          pcm: copy.buffer,
          sampleCount: copy.length,
          last: at + SLICE_SAMPLES >= pcm.length,
        })
      }
    } catch (error) {
      // Main may have already told the truer story (failed/cancelled event);
      // only speak up when the row would otherwise still claim progress.
      const current = this.#item(key)
      if (current?.status === 'transcribing' && !this.#cancelRequested.has(key)) {
        this.#update(key, { status: 'failed', error: describe(error) })
      }
    }
    // From here the job is main's: `finishing` → `done` arrives as events.
  }

  // -- events ------------------------------------------------------------------

  #onJobEvent(job: TranscriptionJob, segment: TranscriptionSegment | null): void {
    const item = this.#items.find((candidate) => candidate.job?.id === job.id)
    if (!item) return
    const patch: Partial<TranscribeItem> = { job, status: statusOf(job), error: job.error }
    if (segment) patch.segments = [...item.segments, segment]
    this.#update(item.key, patch)
  }

  // -- bookkeeping ---------------------------------------------------------------

  #item(key: string): TranscribeItem | undefined {
    return this.#items.find((candidate) => candidate.key === key)
  }

  #update(key: string, patch: Partial<TranscribeItem>): void {
    this.#items = this.#items.map((item) => (item.key === key ? { ...item, ...patch } : item))
    this.#publish()
  }

  #publish(): void {
    this.#snapshot = [...this.#items]
    for (const listener of this.#listeners) listener()
  }

  #key(): string {
    this.#nextKey += 1
    return `t${this.#nextKey}`
  }
}

function statusOf(job: TranscriptionJob): TranscribeItemStatus {
  switch (job.state) {
    case 'receiving':
    case 'finishing':
      return 'transcribing'
    case 'done':
      return 'done'
    case 'failed':
      return 'failed'
    case 'cancelled':
      return 'cancelled'
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export const transcribeClient = new TranscribeClient()
