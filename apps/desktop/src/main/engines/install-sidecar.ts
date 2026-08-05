import {
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
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
 * Official release pins (PLAN §16). Overridable via env for experiments.
 * llama tag is a build number; whisper is a semver tag.
 */
const PINS = {
  'whisper-server': {
    tag: process.env['WHISPER_TAG'] ?? 'v1.9.2',
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
): SidecarPresence {
  const { path, searched } = resolveSidecarBinary(which, resourcesPath, appPath)
  return { installed: path !== null, path, searched }
}

export function allSidecarPresence(
  resourcesPath: string,
  appPath: string,
): { whisper: SidecarPresence; llama: SidecarPresence } {
  return {
    whisper: sidecarPresence('whisper-server', resourcesPath, appPath),
    llama: sidecarPresence('llama-server', resourcesPath, appPath),
  }
}

/** Dev install dir: repo `.sidecars/bin`. Packaged apps use resources/bin via extraResources later. */
export function defaultSidecarInstallDir(appPath: string): string {
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
 * Download an official Windows prebuild and unpack into `.sidecars/bin`.
 * Only runs on win32; other platforms return a clear error (use build-*.sh).
 */
export async function installSidecarBinary(
  which: SidecarKind,
  appPath: string,
): Promise<InstallSidecarResult> {
  if (process.platform !== 'win32') {
    return {
      ok: false,
      which,
      path: null,
      error: 'unsupported-platform',
      detail:
        'In-app sidecar install is Windows-only for now. Use scripts/sidecars/build-*.sh on macOS.',
    }
  }

  const pin = PINS[which]
  const url = pin.url(pin.tag)
  const outDir = defaultSidecarInstallDir(appPath)
  const cacheDir = join(appPath, '..', '..', '.sidecars', 'cache')
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

async function downloadFile(url: string, dest: string): Promise<void> {
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok || !response.body) {
    throw new Error(`Download failed (${response.status}) for ${url}`)
  }
  // Node 18+ fetch body is a web stream; convert for pipeline.
  const nodeStream = Readable.fromWeb(response.body as WebReadableStream)
  await pipeline(nodeStream, createWriteStream(dest))
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
