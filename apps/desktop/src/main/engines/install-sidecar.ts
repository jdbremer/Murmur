import {
  closeSync,
  copyFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'
import { Readable } from 'node:stream'
import { type ReadableStream as WebReadableStream } from 'node:stream/web'

import { createLogger } from '../logging'
import { type AllowlistedFetchOptions, sidecarReleaseFetch } from '../net/fetch'
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
 *
 * `sha256` is the archive digest this build trusts. PLAN §290 requires every
 * download to be checksum-verified, and the model downloader already is — this
 * path is the exception because ggml-org publishes no digest alongside its
 * release assets, so there is nothing to pin *to* without a maintainer
 * recording one by hand. The mechanism is here and enforced when a digest is
 * present; when it is absent the computed digest is logged and returned, so
 * pinning a release is a one-line change rather than a rewrite.
 *
 * Until a digest is pinned, the trust chain is: TLS to a host on the sidecar
 * allowlist, a fixed repo path no env override can escape, and the structural
 * checks in `installSidecarBinary` (PE magic, DLL name allowlist).
 */
const PINS = {
  'whisper-server': {
    tag: safeTag(process.env['WHISPER_TAG'], 'v1.9.2'),
    // ggml-org/whisper.cpp releases
    url: (tag: string) =>
      `https://github.com/ggml-org/whisper.cpp/releases/download/${tag}/whisper-bin-x64.zip`,
    exeNames: ['whisper-server.exe', 'whisper-server'],
    sha256: null as string | null,
  },
  'llama-server': {
    tag: safeTag(process.env['LLAMA_TAG'], 'b10276'),
    url: (tag: string) =>
      `https://github.com/ggml-org/llama.cpp/releases/download/${tag}/llama-${tag}-bin-win-cpu-x64.zip`,
    exeNames: ['llama-server.exe', 'server.exe', 'llama-server'],
    sha256: null as string | null,
  },
} as const

/**
 * DLLs these releases legitimately ship beside the server binary.
 *
 * The sidecar runs with `cwd` set to its own directory, so that directory is
 * on the DLL search path: copying *every* `.dll` out of an archive would let a
 * tampered release drop anything it liked next to a binary we then execute.
 * Matching on the known families keeps the compute backends working while
 * refusing a `version.dll` or `dwrite.dll` hijack.
 */
const DLL_PREFIXES = ['ggml', 'whisper', 'llama', 'msvcp', 'vcruntime', 'concrt', 'sdl2', 'omp']

function isExpectedSidecarDll(name: string): boolean {
  const lower = name.toLowerCase()
  if (!lower.endsWith('.dll')) return false
  return DLL_PREFIXES.some((prefix) => lower.startsWith(prefix))
}

/** Windows executables and DLLs start with `MZ`. Cheap structural sanity check. */
function isPortableExecutable(path: string): boolean {
  let handle: number | null = null
  try {
    handle = openSync(path, 'r')
    const magic = Buffer.alloc(2)
    if (readSync(handle, magic, 0, 2, 0) !== 2) return false
    return magic[0] === 0x4d && magic[1] === 0x5a
  } catch {
    return false
  } finally {
    if (handle !== null) closeSync(handle)
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}

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

export interface InstallSidecarOptions {
  /** Overrides `globalThis.fetch`; tests pass a fake. */
  fetchImpl?: AllowlistedFetchOptions['fetchImpl']
}

/**
 * Download an official Windows prebuild and unpack into the install dir.
 * Only runs on win32; other platforms return a clear error (use build-*.sh).
 */
export function installSidecarBinary(
  which: SidecarKind,
  appPath: string,
  userDataPath?: string,
  options: InstallSidecarOptions = {},
): Promise<InstallSidecarResult> {
  const existing = inFlight.get(which)
  if (existing) return existing

  const run = installSidecarBinaryUncoordinated(which, appPath, userDataPath, options).finally(
    () => {
      inFlight.delete(which)
    },
  )
  inFlight.set(which, run)
  return run
}

async function installSidecarBinaryUncoordinated(
  which: SidecarKind,
  appPath: string,
  userDataPath: string | undefined,
  options: InstallSidecarOptions,
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
      await downloadFile(url, zipPath, options.fetchImpl)
    } else {
      log.info(`using cached ${zipPath}`)
    }

    // Verify before unpacking: an archive that fails its pin must never reach
    // Expand-Archive, let alone the directory a binary is executed from.
    const digest = await sha256File(zipPath)
    if (pin.sha256 !== null && digest !== pin.sha256) {
      rmSync(zipPath, { force: true })
      return {
        ok: false,
        which,
        path: null,
        error: 'checksum-mismatch',
        detail: `Refusing ${which}: expected sha256 ${pin.sha256}, got ${digest}.`,
      }
    }
    if (pin.sha256 === null) {
      // Recorded so a maintainer can pin this exact release in PINS above.
      log.warn(`${which} ${pin.tag} is not pinned — sha256 ${digest}`)
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

    // Everything we copy must have come from inside the extraction directory.
    // A zip entry with `..` in its path, or a symlink, would otherwise let the
    // archive nominate a file of its choosing to be installed and executed.
    const extractRoot = resolve(extractDir) + sep
    if (!resolve(exe.path).startsWith(extractRoot)) {
      return {
        ok: false,
        which,
        path: null,
        error: 'extract-escaped',
        detail: 'The release archive tried to place a file outside the extraction directory.',
      }
    }

    if (!isPortableExecutable(exe.path)) {
      return {
        ok: false,
        which,
        path: null,
        error: 'not-executable',
        detail: `${which}: the file found in the archive is not a Windows executable.`,
      }
    }

    const destExe = join(
      outDir,
      which === 'llama-server' ? 'llama-server.exe' : 'whisper-server.exe',
    )
    copyFileSync(exe.path, destExe)

    // Sibling DLLs, restricted to the families these releases actually ship.
    // The sidecar's own directory is on its DLL search path, so an unfiltered
    // copy is a planting primitive rather than a convenience.
    for (const file of readdirSync(exe.dir)) {
      if (!isExpectedSidecarDll(file)) continue
      const source = join(exe.dir, file)
      if (!resolve(source).startsWith(extractRoot)) continue
      if (!isPortableExecutable(source)) {
        log.warn(`skipping ${file}: not a PE image`)
        continue
      }
      copyFileSync(source, join(outDir, file))
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
async function downloadFile(
  url: string,
  dest: string,
  fetchImpl?: AllowlistedFetchOptions['fetchImpl'],
): Promise<void> {
  const partial = `${dest}.part`
  const response = await sidecarReleaseFetch(url, { ...(fetchImpl ? { fetchImpl } : {}) })
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
