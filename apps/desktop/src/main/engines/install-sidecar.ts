import {
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Readable } from 'node:stream'
import { type ReadableStream as WebReadableStream } from 'node:stream/web'

import { createLogger } from '../logging'
import { sidecarReleaseFetch } from '../net/fetch'
import { resolveSidecarBinary } from './sidecar'

const execFileAsync = promisify(execFile)
const log = createLogger('sidecar-install')

export type SidecarKind = 'llama-server' | 'whisper-server'

export interface SidecarPresence {
  installed: boolean
  path: string | null
  searched: string[]
}

/**
 * A release tag goes straight into the download URL, so anything that could
 * escape the pinned repo path (`../../other-org/other-repo/...`) must not
 * survive. Env overrides exist for pin experiments, not for redirection.
 */
function safeTag(value: string | undefined, fallback: string): string {
  if (value === undefined) return fallback
  if (/^[A-Za-z0-9._-]+$/.test(value) && !value.includes('..')) return value
  log.warn(`ignoring malformed release tag "${value}" — using ${fallback}`)
  return fallback
}

/**
 * Official release pins (PLAN §16). Overridable via env for experiments.
 * llama tag is a build number; whisper is a semver tag.
 */
const PINS = {
  'whisper-server': {
    tag: safeTag(process.env['WHISPER_TAG'], 'v1.9.2'),
    // ggml-org/whisper.cpp releases
    url: (tag: string) =>
      `https://github.com/ggml-org/whisper.cpp/releases/download/${tag}/whisper-bin-x64.zip`,
    exeNames: ['whisper-server.exe', 'whisper-server'],
  },
  'llama-server': {
    tag: process.env['LLAMA_TAG'] ?? 'b10276',
    url: (tag: string) =>
      `https://github.com/ggml-org/llama.cpp/releases/download/${tag}/llama-${tag}-bin-win-cpu-x64.zip`,
    exeNames: ['llama-server.exe', 'server.exe', 'llama-server'],
  },
} as const

export function sidecarPresence(
  which: SidecarKind,
  resourcesPath: string,
  appPath: string,
  userDataPath?: string,
): SidecarPresence {
  const { path, searched } = resolveSidecarBinary(which, resourcesPath, appPath, userDataPath)
  return { installed: path !== null, path, searched }
}

export function allSidecarPresence(
  resourcesPath: string,
  appPath: string,
  userDataPath?: string,
): { whisper: SidecarPresence; llama: SidecarPresence } {
  return {
    whisper: sidecarPresence('whisper-server', resourcesPath, appPath, userDataPath),
    llama: sidecarPresence('llama-server', resourcesPath, appPath, userDataPath),
  }
}

/**
 * Where an install may write.
 *
 * Unpackaged: the repo's `.sidecars/bin`, so a dev build shares one copy with
 * the build scripts. Packaged: under userData — the app's own install
 * directory is `C:\Program Files\...` or `/Applications/...`, which a standard
 * user cannot write, and an EPERM there surfaces as a raw errno in the UI.
 */
export function defaultSidecarInstallDir(appPath: string, userDataPath?: string): string {
  if (userDataPath) return join(userDataPath, 'sidecars', 'bin')
  // electron-vite: appPath is apps/desktop → repo is ../..
  return join(appPath, '..', '..', '.sidecars', 'bin')
}

export interface InstallSidecarResult {
  ok: boolean
  which: SidecarKind
  path: string | null
  error: string | null
  detail: string
}

/**
 * One install per sidecar at a time. Two overlapping downloads write the same
 * zip path with interleaved bytes, and the corrupt archive then poisons the
 * cache for every later attempt.
 */
const inFlight = new Map<SidecarKind, Promise<InstallSidecarResult>>()

/**
 * Download an official Windows prebuild and unpack into the install dir.
 * Only runs on win32; other platforms return a clear error (use build-*.sh).
 */
export function installSidecarBinary(
  which: SidecarKind,
  appPath: string,
  userDataPath?: string,
): Promise<InstallSidecarResult> {
  const existing = inFlight.get(which)
  if (existing) return existing

  const run = installSidecarBinaryUncoordinated(which, appPath, userDataPath).finally(() => {
    inFlight.delete(which)
  })
  inFlight.set(which, run)
  return run
}

async function installSidecarBinaryUncoordinated(
  which: SidecarKind,
  appPath: string,
  userDataPath?: string,
): Promise<InstallSidecarResult> {
  if (process.platform !== 'win32') {
    return {
      ok: false,
      which,
      path: null,
      error: 'unsupported-platform',
      detail:
        'In-app sidecar install is Windows-only for now. Use scripts/sidecars/build-*.sh on macOS or Linux.',
    }
  }

  const pin = PINS[which]
  const url = pin.url(pin.tag)
  const outDir = defaultSidecarInstallDir(appPath, userDataPath)
  const cacheDir = userDataPath
    ? join(userDataPath, 'sidecars', 'cache')
    : join(appPath, '..', '..', '.sidecars', 'cache')
  mkdirSync(outDir, { recursive: true })
  mkdirSync(cacheDir, { recursive: true })

  const zipPath = join(cacheDir, `${which}-${pin.tag}.zip`)
  const extractDir = join(cacheDir, `${which}-${pin.tag}-extract`)

  try {
    if (!existsSync(zipPath) || statSync(zipPath).size < 1000) {
      log.info(`downloading ${url}`)
      await downloadFile(url, zipPath)
    } else {
      log.info(`using cached ${zipPath}`)
    }

    if (existsSync(extractDir)) rmSync(extractDir, { recursive: true, force: true })
    mkdirSync(extractDir, { recursive: true })

    // PowerShell Expand-Archive is reliable on Windows for zip payloads.
    await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${extractDir.replace(/'/g, "''")}' -Force`,
      ],
      { windowsHide: true },
    )

    const exe = findFile(extractDir, pin.exeNames)
    if (!exe) {
      return {
        ok: false,
        which,
        path: null,
        error: 'extract-missing',
        detail: `Could not find ${pin.exeNames.join(' / ')} inside the release zip.`,
      }
    }

    const destExe = join(
      outDir,
      which === 'llama-server' ? 'llama-server.exe' : 'whisper-server.exe',
    )
    copyFileSync(exe.path, destExe)

    // Copy sibling DLLs from the same directory as the exe.
    for (const file of readdirSync(exe.dir)) {
      if (file.toLowerCase().endsWith('.dll')) {
        copyFileSync(join(exe.dir, file), join(outDir, file))
      }
    }

    // The extracted tree is a full second copy of the release; the binaries
    // are installed now, so there is no reason to leave it on disk.
    rmSync(extractDir, { recursive: true, force: true })

    log.info(`installed ${destExe}`)
    return {
      ok: true,
      which,
      path: destExe,
      error: null,
      detail: `Installed ${which} to ${destExe}`,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.warn(`install failed: ${message}`)
    return {
      ok: false,
      which,
      path: null,
      error: 'install-failed',
      detail: message,
    }
  }
}

/**
 * Download to a `.part` file and rename only on success.
 *
 * A truncated zip left at the final path would be indistinguishable from a
 * good one on the next run — the cache check would hand Expand-Archive a
 * broken archive forever, and the only cure would be finding the cache dir by
 * hand.
 */
async function downloadFile(url: string, dest: string): Promise<void> {
  const partial = `${dest}.part`
  const response = await sidecarReleaseFetch(url)
  if (!response.ok || !response.body) {
    throw new Error(`Download failed (${response.status}) for ${url}`)
  }
  try {
    // Node 18+ fetch body is a web stream; convert for pipeline.
    const nodeStream = Readable.fromWeb(response.body as WebReadableStream)
    await pipeline(nodeStream, createWriteStream(partial))

    // Trust the server's own length over a half-written file.
    const expected = Number(response.headers.get('content-length') ?? 0)
    if (expected > 0 && statSync(partial).size !== expected) {
      throw new Error(`Download truncated: got ${statSync(partial).size} of ${expected} bytes`)
    }
    renameSync(partial, dest)
  } catch (error) {
    rmSync(partial, { force: true })
    throw error
  }
}

function findFile(root: string, names: readonly string[]): { path: string; dir: string } | null {
  const wanted = new Set(names.map((n) => n.toLowerCase()))
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()!
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }
    for (const name of entries) {
      const full = join(dir, name)
      let isDir: boolean
      try {
        isDir = statSync(full).isDirectory()
      } catch {
        continue
      }
      if (isDir) {
        stack.push(full)
        continue
      }
      if (wanted.has(name.toLowerCase())) return { path: full, dir }
    }
  }
  return null
}
