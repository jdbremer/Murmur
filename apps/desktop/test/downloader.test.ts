import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ModelEntry, ModelFile } from '@murmur/shared'

import { DOWNLOAD } from '../src/main/config'
import {
  ChecksumMismatchError,
  DownloadCancelledError,
  downloadFile,
  downloadModel,
} from '../src/main/models/downloader'
import { BlockedHostError } from '../src/main/net/fetch'
import { createNullLogger } from '../src/main/logging'

/**
 * Downloader tests (PLAN §8, §15.2).
 *
 * The properties that matter are all about *failure*: a resumed transfer, a
 * server that ignores the Range header, a checksum that does not match, and a
 * cancel. Each of those, done wrong, either corrupts a model file or silently
 * installs the wrong bytes — so each gets a test.
 */

const log = createNullLogger()
let directory: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'murmur-download-'))
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

function fileFor(body: string, filename = 'model.bin'): ModelFile {
  const buffer = Buffer.from(body)
  return {
    url: `https://huggingface.co/org/repo/resolve/main/${filename}`,
    sha256: sha256(buffer),
    bytes: buffer.byteLength,
    filename,
  }
}

/** A fetch double that serves `body`, honouring Range when asked to. */
function serve(body: string, options: { honourRange?: boolean } = {}) {
  const honourRange = options.honourRange ?? true
  const calls: { url: string; range: string | null }[] = []

  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers)
    const range = headers.get('range')
    calls.push({ url, range })

    if (range && honourRange) {
      const start = Number.parseInt(range.replace('bytes=', '').replace('-', ''), 10)
      return new Response(Buffer.from(body).subarray(start), { status: 206 })
    }
    return new Response(Buffer.from(body), { status: 200 })
  }

  return { fetchImpl, calls }
}

describe('downloadFile', () => {
  const body = 'the quick brown fox jumps over the lazy dog'.repeat(20)

  it('downloads, verifies and installs', async () => {
    const file = fileFor(body)
    const { fetchImpl } = serve(body)

    const path = await downloadFile({ directory, file, fetchImpl, log })

    expect(path).toBe(join(directory, 'model.bin'))
    expect(readFileSync(path, 'utf8')).toBe(body)
    // The partial is gone: the rename only happens after verification.
    expect(existsSync(`${path}${DOWNLOAD.partialSuffix}`)).toBe(false)
  })

  it('reports progress with a byte count and a rate', async () => {
    const file = fileFor(body)
    const { fetchImpl } = serve(body)
    const progress = vi.fn()

    await downloadFile({ directory, file, fetchImpl, log, onProgress: progress })

    expect(progress).toHaveBeenCalled()
    const last = progress.mock.calls.at(-1)?.[0] as { receivedBytes: number; totalBytes: number }
    expect(last.receivedBytes).toBe(file.bytes)
    expect(last.totalBytes).toBe(file.bytes)
  })

  it('quarantines a checksum mismatch instead of installing it', async () => {
    const file = { ...fileFor(body), sha256: 'a'.repeat(64) }
    const { fetchImpl } = serve(body)

    await expect(downloadFile({ directory, file, fetchImpl, log })).rejects.toThrow(
      ChecksumMismatchError,
    )

    // Nothing was installed…
    expect(existsSync(join(directory, 'model.bin'))).toBe(false)
    // …and the bad bytes were kept for inspection, not deleted.
    const quarantined = readdirSync(join(directory, DOWNLOAD.quarantineDirName))
    expect(quarantined).toHaveLength(1)
    expect(quarantined[0]).toContain('model.bin')
  })

  it('names both hashes and the quarantine path in the error', async () => {
    const file = { ...fileFor(body), sha256: 'b'.repeat(64) }
    const { fetchImpl } = serve(body)

    try {
      await downloadFile({ directory, file, fetchImpl, log })
      expect.unreachable('should have thrown')
    } catch (error) {
      const mismatch = error as ChecksumMismatchError
      expect(mismatch.expected).toBe('b'.repeat(64))
      expect(mismatch.actual).toBe(sha256(body))
      expect(mismatch.quarantinePath).toContain(DOWNLOAD.quarantineDirName)
      expect(mismatch.message).toContain('not installed')
    }
  })

  it('resumes from a partial with a Range request', async () => {
    const file = fileFor(body)
    const partial = join(directory, `model.bin${DOWNLOAD.partialSuffix}`)
    writeFileSync(partial, Buffer.from(body).subarray(0, 100))

    const { fetchImpl, calls } = serve(body)
    const path = await downloadFile({ directory, file, fetchImpl, log })

    expect(calls[0]?.range).toBe('bytes=100-')
    // The resumed hash covers the prefix too, so the file verifies.
    expect(readFileSync(path, 'utf8')).toBe(body)
  })

  it('restarts cleanly when the server ignores the Range header', async () => {
    const file = fileFor(body)
    const partial = join(directory, `model.bin${DOWNLOAD.partialSuffix}`)
    writeFileSync(partial, Buffer.from(body).subarray(0, 100))

    // A 200 instead of a 206: appending would corrupt the file.
    const { fetchImpl, calls } = serve(body, { honourRange: false })
    const path = await downloadFile({ directory, file, fetchImpl, log })

    expect(readFileSync(path, 'utf8')).toBe(body)
    // Two attempts: the ranged one, then the restarted one.
    expect(calls).toHaveLength(2)
    expect(calls[1]?.range).toBeNull()
  })

  it('discards a partial that is already at or past the expected size', async () => {
    const file = fileFor(body)
    const partial = join(directory, `model.bin${DOWNLOAD.partialSuffix}`)
    writeFileSync(partial, Buffer.from('x'.repeat(body.length + 50)))

    const { fetchImpl, calls } = serve(body)
    const path = await downloadFile({ directory, file, fetchImpl, log })

    expect(calls[0]?.range).toBeNull()
    expect(readFileSync(path, 'utf8')).toBe(body)
  })

  it('skips a file that is already installed at the right size', async () => {
    const file = fileFor(body)
    writeFileSync(join(directory, 'model.bin'), body)
    const { fetchImpl, calls } = serve(body)

    await downloadFile({ directory, file, fetchImpl, log })
    expect(calls).toHaveLength(0)
  })

  it('rejects with a typed error on cancel and installs nothing', async () => {
    const file = fileFor(body)
    const controller = new AbortController()

    const fetchImpl = async (): Promise<Response> => {
      const stream = new ReadableStream<Uint8Array>({
        start(streamController) {
          streamController.enqueue(Buffer.from(body).subarray(0, 40))
        },
        // Called once the first chunk has been taken; nothing more arrives, so
        // the abort is what ends the transfer. Driving it from `pull` rather
        // than from `start` keeps the ordering deterministic.
        pull() {
          controller.abort()
        },
      })
      return new Response(stream, { status: 200 })
    }

    await expect(
      downloadFile({ directory, file, fetchImpl, log, signal: controller.signal }),
    ).rejects.toThrow(DownloadCancelledError)

    // The partial may or may not have reached disk depending on when the abort
    // landed — what must never happen is a *finished* file appearing. That a
    // partial which does exist gets resumed is covered by the Range test above.
    expect(existsSync(join(directory, 'model.bin'))).toBe(false)
  })

  it('fails on a non-2xx response', async () => {
    const file = fileFor(body)
    const fetchImpl = async (): Promise<Response> => new Response(null, { status: 404 })

    await expect(downloadFile({ directory, file, fetchImpl, log })).rejects.toThrow(/HTTP 404/)
  })

  it('refuses a URL outside the Hugging Face allowlist', async () => {
    const file = { ...fileFor(body), url: 'https://evil.example/model.bin' }
    const { fetchImpl } = serve(body)

    await expect(downloadFile({ directory, file, fetchImpl, log })).rejects.toThrow(
      BlockedHostError,
    )
  })

  it('refuses a filename that tries to escape the model directory', async () => {
    const file = { ...fileFor(body), filename: '../escape.bin' }
    const { fetchImpl } = serve(body)

    await expect(downloadFile({ directory, file, fetchImpl, log })).rejects.toThrow(
      /escapes the models directory/,
    )
  })
})

describe('downloadModel', () => {
  it('downloads every file and reports aggregate progress', async () => {
    const first = fileFor('first file contents', 'encoder.onnx')
    const second = fileFor('second file contents, longer', 'decoder.onnx')

    const entry: ModelEntry = {
      id: 'test-model',
      kind: 'stt',
      engine: 'onnx-runtime',
      displayName: 'Test',
      org: 'Test Org',
      origin: 'US',
      license: 'MIT',
      sizeBytes: first.bytes + second.bytes,
      ramTierGb: 4,
      languages: ['en'],
      quant: 'int8',
      files: [first, second],
    }

    const bodies: Record<string, string> = {
      [first.url]: 'first file contents',
      [second.url]: 'second file contents, longer',
    }
    const fetchImpl = async (url: string): Promise<Response> =>
      new Response(Buffer.from(bodies[url] ?? ''), { status: 200 })

    const progress = vi.fn()
    const paths = await downloadModel({ directory, entry, fetchImpl, log, onProgress: progress })

    expect(paths).toHaveLength(2)
    expect(readFileSync(paths[0]!, 'utf8')).toBe('first file contents')
    expect(readFileSync(paths[1]!, 'utf8')).toBe('second file contents, longer')

    const last = progress.mock.calls.at(-1)?.[0] as { receivedBytes: number; totalBytes: number }
    expect(last.totalBytes).toBe(entry.sizeBytes)
    expect(last.receivedBytes).toBe(entry.sizeBytes)
  })
})
