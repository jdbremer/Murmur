import { createHash } from 'node:crypto'
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable, Writable } from 'node:stream'

import type { ModelEntry, ModelFile } from '@murmur/shared'

import { DOWNLOAD } from '../config'
import { createLogger, type Logger } from '../logging'
import { allowlistedFetch, type AllowlistedFetchOptions } from '../net/fetch'
import { resolveModelPath } from './storage'

/**
 * Model downloads (PLAN §8, §15.2).
 *
 * Five properties, each of which exists because its absence is a real bug we
 * have all shipped before:
 *
 *  1. **Resumable.** A 1.6 GB file over hotel wifi will be interrupted. The
 *     partial lands at `<file>.partial`, and a resume sends
 *     `Range: bytes=<size>-`. A server that ignores the range (200 instead of
 *     206) restarts cleanly rather than appending to the middle of a file.
 *  2. **Streamed hashing.** SHA-256 is computed as bytes arrive, so verifying a
 *     1.6 GB model does not mean reading it twice or holding it in memory. On a
 *     resume the existing prefix is hashed first — the only time the file is
 *     re-read.
 *  3. **Rename only on match.** The real filename never exists until the hash
 *     is verified, so a half-download can never be loaded as a model.
 *  4. **Quarantine on mismatch.** A wrong hash means a corrupted transfer or a
 *     tampered mirror; the file is moved to `.quarantine/` rather than deleted,
 *     and the error names it (PLAN §15.2).
 *  5. **Allow-listed transport.** Every byte comes through
 *     {@link allowlistedFetch} — Hugging Face hosts only, every redirect hop
 *     re-checked (PLAN §10.2).
 */

export interface DownloadProgress {
  receivedBytes: number
  totalBytes: number
  /** Bytes per second over the last window; 0 until the first window closes. */
  bytesPerSecond: number
}

export interface DownloadFileOptions {
  /** Directory the finished file is placed in. */
  directory: string
  file: ModelFile
  signal?: AbortSignal
  onProgress?(progress: DownloadProgress): void
  /** Injected for tests. */
  fetchImpl?: AllowlistedFetchOptions['fetchImpl']
  log?: Logger
}

export class ChecksumMismatchError extends Error {
  override readonly name = 'ChecksumMismatchError'
  readonly expected: string
  readonly actual: string
  readonly quarantinePath: string

  constructor(filename: string, expected: string, actual: string, quarantinePath: string) {
    super(
      `Checksum mismatch for "${filename}": expected ${expected}, got ${actual}. ` +
        `The file was quarantined at ${quarantinePath} and not installed.`,
    )
    this.expected = expected
    this.actual = actual
    this.quarantinePath = quarantinePath
  }
}

export class DownloadCancelledError extends Error {
  override readonly name = 'DownloadCancelledError'
  constructor() {
    super('Download cancelled')
  }
}

/**
 * Download one file, resuming if a partial exists, and install it only after
 * its SHA-256 matches.
 *
 * @returns the absolute path of the installed file.
 */
export async function downloadFile(options: DownloadFileOptions): Promise<string> {
  const log = options.log ?? createLogger('models:download')
  const { file, directory } = options

  const finalPath = resolveModelPath(directory, file.filename)
  const partialPath = `${finalPath}${DOWNLOAD.partialSuffix}`
  mkdirSync(dirname(finalPath), { recursive: true })

  // Already installed and the right size? Nothing to do — this is what makes
  // "retry a failed multi-file model" cheap.
  if (existsSync(finalPath) && statSync(finalPath).size === file.bytes) {
    options.onProgress?.({ receivedBytes: file.bytes, totalBytes: file.bytes, bytesPerSecond: 0 })
    return finalPath
  }

  const hash = createHash('sha256')
  let alreadyHave = 0

  if (existsSync(partialPath)) {
    const size = statSync(partialPath).size
    if (size > 0 && size < file.bytes) {
      // Hash what we already have so the running digest stays correct.
      await pipeline(
        createReadStream(partialPath),
        async function* (source) {
          for await (const chunk of source) {
            hash.update(chunk as Buffer)
            yield chunk
          }
        },
        devNull(),
      )
      alreadyHave = size
      log.info(`resuming ${file.filename} at ${alreadyHave}/${file.bytes} bytes`)
    } else {
      // A partial at or beyond the expected size is junk — start again.
      rmSync(partialPath, { force: true })
    }
  }

  let received = alreadyHave
  let windowStart = Date.now()
  let windowBytes = 0
  let bytesPerSecond = 0

  const headers: Record<string, string> = {}
  if (alreadyHave > 0) headers['range'] = `bytes=${alreadyHave}-`

  const response = await allowlistedFetch(file.url, {
    headers,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  })

  if (!response.ok) {
    throw new Error(`Download failed for ${file.filename}: HTTP ${response.status}`)
  }

  // The server ignored our Range header: throw away the prefix and start over
  // rather than concatenating a full body onto a partial one.
  const resumed = alreadyHave > 0 && response.status === 206
  if (alreadyHave > 0 && !resumed) {
    log.warn(`server ignored Range for ${file.filename}; restarting the download`)
    rmSync(partialPath, { force: true })
    hash.destroy?.()
    return downloadFile({ ...options, signal: options.signal ?? new AbortController().signal })
  }

  if (!response.body) throw new Error(`Download failed for ${file.filename}: empty response body`)

  const sink = createWriteStream(partialPath, resumed ? { flags: 'a' } : { flags: 'w' })

  try {
    await pipeline(
      Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
      async function* (source) {
        for await (const chunk of source) {
          const buffer = chunk as Buffer
          hash.update(buffer)
          received += buffer.byteLength
          windowBytes += buffer.byteLength

          const elapsed = Date.now() - windowStart
          if (elapsed >= DOWNLOAD.progressIntervalMs) {
            bytesPerSecond = Math.round((windowBytes * 1000) / elapsed)
            windowStart = Date.now()
            windowBytes = 0
            options.onProgress?.({
              receivedBytes: received,
              totalBytes: file.bytes,
              bytesPerSecond,
            })
          }
          yield buffer
        }
      },
      sink,
      options.signal ? { signal: options.signal } : {},
    )
  } catch (error) {
    // A cancelled download keeps its partial: the user may resume it later.
    if (options.signal?.aborted) throw new DownloadCancelledError()
    throw error
  }

  const actual = hash.digest('hex')
  if (actual !== file.sha256) {
    const quarantinePath = quarantine(directory, file.filename, partialPath)
    throw new ChecksumMismatchError(file.filename, file.sha256, actual, quarantinePath)
  }

  renameSync(partialPath, finalPath)
  options.onProgress?.({ receivedBytes: file.bytes, totalBytes: file.bytes, bytesPerSecond })
  log.info(`installed ${file.filename} (${file.bytes} bytes, sha256 verified)`)
  return finalPath
}

/**
 * Move a bad file into `.quarantine/` with a timestamp.
 *
 * Kept rather than deleted so a mismatch can be investigated — "your mirror is
 * serving a different file" is a very different problem from "your disk is
 * failing", and the file is the evidence.
 */
function quarantine(directory: string, filename: string, partialPath: string): string {
  const quarantineDir = join(directory, DOWNLOAD.quarantineDirName)
  mkdirSync(quarantineDir, { recursive: true })
  const target = join(quarantineDir, `${filename}.${Date.now()}`)
  try {
    renameSync(partialPath, target)
  } catch {
    rmSync(partialPath, { force: true })
  }
  return target
}

/** A writable that discards everything — used to re-hash an existing partial. */
function devNull(): Writable {
  return new Writable({
    write(_chunk, _encoding, callback) {
      callback()
    },
  })
}

// ---------------------------------------------------------------------------
// Whole-model downloads
// ---------------------------------------------------------------------------

export interface DownloadModelOptions {
  directory: string
  entry: ModelEntry
  signal?: AbortSignal
  onProgress?(progress: DownloadProgress): void
  fetchImpl?: AllowlistedFetchOptions['fetchImpl']
  log?: Logger
}

/**
 * Download every file in a catalog entry, reporting aggregate progress.
 *
 * Sequential rather than parallel: two 1.6 GB streams do not finish sooner on a
 * home connection, and one at a time keeps the resume story simple.
 */
export async function downloadModel(options: DownloadModelOptions): Promise<string[]> {
  const totalBytes = options.entry.files.reduce((sum, file) => sum + file.bytes, 0)
  let completedBytes = 0
  const paths: string[] = []

  for (const file of options.entry.files) {
    const path = await downloadFile({
      directory: options.directory,
      file,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.log ? { log: options.log } : {}),
      onProgress: (progress) => {
        options.onProgress?.({
          receivedBytes: completedBytes + progress.receivedBytes,
          totalBytes,
          bytesPerSecond: progress.bytesPerSecond,
        })
      },
    })
    completedBytes += file.bytes
    paths.push(path)
  }

  return paths
}
