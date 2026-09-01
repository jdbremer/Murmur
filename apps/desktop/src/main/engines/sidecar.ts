import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:net'
import { accessSync, constants } from 'node:fs'
import { dirname, join } from 'node:path'

import { SIDECAR, TIMEOUTS } from '../config'
import { createLogger, type Logger } from '../logging'
import { loopbackFetch } from '../net/fetch'

/**
 * Lifecycle for the loopback inference servers (`whisper-server`,
 * `llama-server`) — PLAN §3.1, §10.3, §15.1.
 *
 * The security posture in four lines, all enforced here rather than at call
 * sites:
 *
 *  - bind `127.0.0.1` on an **ephemeral port** the OS picks for us, so no other
 *    machine can reach the server and a fixed port cannot be squatted;
 *  - a **per-launch bearer token** from `crypto.randomBytes`, so no other local
 *    process can drive our inference server or read prompts back out of it;
 *  - the token is passed via **argv-free means where possible** and never
 *    logged — `describe()` and every log line here redact it;
 *  - the child is killed on quit with a **SIGTERM → SIGKILL escalation**, and
 *    the process group is signalled so a server that forked workers leaves no
 *    orphans.
 *
 * On top of that sits the watchdog PLAN §15.1 asks for: an unexpected exit
 * triggers an exponential-backoff restart, and after
 * {@link SIDECAR.maxRestarts} consecutive failures the manager gives up and
 * reports it so the engine can surface `crash-loop` instead of retrying
 * forever.
 */

export interface SidecarSpec {
  /** Short name for logs, e.g. `whisper-server`. */
  name: string
  /** Absolute path to the executable. */
  binaryPath: string
  /**
   * Build the argument list. Receives the port and token the manager chose, so
   * a server that wants `--api-key <token>` and one that wants an env var are
   * both expressible.
   */
  buildArgs(context: { port: number; token: string }): string[]
  /** Extra environment for the child, merged over a minimal base. */
  buildEnv?(context: { port: number; token: string }): NodeJS.ProcessEnv
  /** Path (no leading slash needed) probed until the server answers. */
  healthPath: string
  /** Working directory for the child. Defaults to the binary's directory. */
  cwd?: string
}

export type SidecarState = 'stopped' | 'starting' | 'running' | 'failed'

export interface SidecarInfo {
  state: SidecarState
  /** `http://127.0.0.1:<port>` once running. */
  baseUrl: string | null
  /** How many consecutive unexpected exits have happened. */
  restarts: number
  /** Populated when `state` is `failed`. */
  error: string | null
}

export interface SidecarEvents {
  onStateChange?(info: SidecarInfo): void
}

export class SidecarMissingError extends Error {
  override readonly name = 'SidecarMissingError'
  readonly binaryPath: string
  constructor(binaryPath: string) {
    super(
      `Sidecar binary not found at "${binaryPath}". Build it with ` +
        `scripts/sidecars/build-*.sh, or point MURMUR_SIDECAR_DIR at a directory that has it.`,
    )
    this.binaryPath = binaryPath
  }
}

/**
 * Ask the OS for a free TCP port by binding one and immediately releasing it.
 *
 * There is an unavoidable race between release and the sidecar's own bind; it
 * is small, and losing it produces a clean "failed to start" that the watchdog
 * retries. The alternative — a fixed port — is worse: it is squattable and it
 * collides with a second Murmur instance.
 */
export async function reserveLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, SIDECAR.host, () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close(() => reject(new Error('Could not determine an ephemeral port')))
        return
      }
      const { port } = address
      server.close((error) => (error ? reject(error) : resolve(port)))
    })
  })
}

/** 256 bits of entropy, hex-encoded. Regenerated for every spawn. */
export function generateSidecarToken(): string {
  return randomBytes(32).toString('hex')
}

/** True when `path` exists and is executable by this process. */
export function isExecutable(path: string): boolean {
  try {
    // Windows has no Unix execute bit that Node can check; existence is enough.
    // (`.exe` resolution is handled by {@link resolveSidecarBinary}.)
    if (process.platform === 'win32') {
      accessSync(path, constants.F_OK)
      return true
    }
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Where sidecar binaries live.
 *
 *  - packaged: `Contents/Resources/bin/` (PLAN §4, electron-builder
 *    `extraResources`);
 *  - dev: `MURMUR_SIDECAR_DIR` if set, else `<repo>/.sidecars/bin`.
 *
 * Exported so the engines can report the exact path they looked at when a
 * binary is missing — a message that names a path is actionable, one that says
 * "not found" is not.
 */
export function sidecarSearchPaths(
  resourcesPath: string,
  appPath: string,
  userDataPath?: string,
): string[] {
  const paths: string[] = []
  const override = process.env['MURMUR_SIDECAR_DIR']
  if (override) paths.push(override)
  paths.push(join(resourcesPath, 'bin'))
  // Where the in-app installer can actually write once the app is packaged:
  // the install directory itself is read-only for a standard user.
  if (userDataPath) paths.push(join(userDataPath, 'sidecars', 'bin'))
  paths.push(join(appPath, '..', '..', '.sidecars', 'bin'))
  return paths
}

/**
 * Candidate file names for a logical sidecar (`whisper-server`, `llama-server`).
 * Windows ships `*.exe`; macOS / Linux ship extensionless binaries.
 */
export function sidecarBinaryNames(name: string): string[] {
  if (process.platform === 'win32') {
    if (name.toLowerCase().endsWith('.exe')) return [name]
    return [`${name}.exe`, name]
  }
  return [name]
}

export function resolveSidecarBinary(
  name: string,
  resourcesPath: string,
  appPath: string,
  userDataPath?: string,
): { path: string | null; searched: string[] } {
  const searched = sidecarSearchPaths(resourcesPath, appPath, userDataPath)
  const names = sidecarBinaryNames(name)
  for (const directory of searched) {
    for (const fileName of names) {
      const candidate = join(directory, fileName)
      if (isExecutable(candidate)) return { path: candidate, searched }
    }
  }
  return { path: null, searched }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

/**
 * Sidecars from a previous run that outlived the app.
 *
 * A sidecar is spawned `detached` on POSIX so that SIGKILL can be aimed at the
 * whole process group and reach the workers llama-server forks — see
 * {@link SidecarProcess.signal}. The cost of that is a process which no longer
 * dies with its parent, and `before-quit` is not reached on a crash, a Force
 * Quit, or a logout that SIGKILLs the app. Those runs leave a whisper-server
 * or llama-server holding a port, a model file, and its memory, reparented to
 * init and answering to nobody. They never exit on their own: one real machine
 * had orphans nine days old, from an app bundle that had been replaced twice
 * since.
 *
 * Two conditions, and both are needed. The command must be this exact binary,
 * so a different Murmur install — a dev build beside the shipped one — is not
 * touched. And the parent must be init, which is what distinguishes an orphan
 * from the healthy sidecar of a second running instance: that one's parent is
 * its own app, so it is never a candidate.
 */
export function findOrphanedSidecars(binaryPath: string, psOutput: string): number[] {
  const orphans: number[] = []
  for (const line of psOutput.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    if (!match) continue
    const [, pid, parent, command] = match
    if (parent !== '1' || pid === undefined || command === undefined) continue
    // Prefix, not equality: the command line carries the sidecar's arguments.
    if (command !== binaryPath && !command.startsWith(`${binaryPath} `)) continue
    orphans.push(Number(pid))
  }
  return orphans
}

/** Binaries already swept this run — one `ps` per binary, not per spawn. */
const reaped = new Set<string>()

function reapOrphans(binaryPath: string, log: Logger): void {
  // Windows keeps sidecars attached and kills the tree with `taskkill /T`, so
  // it has no equivalent of this orphan; `ps` is not there to ask, either.
  if (process.platform === 'win32') return
  if (reaped.has(binaryPath)) return
  reaped.add(binaryPath)

  let listing: string
  try {
    listing = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    })
  } catch (error) {
    log.debug(`could not list processes to look for orphans: ${String(error)}`)
    return
  }

  for (const pid of findOrphanedSidecars(binaryPath, listing)) {
    log.warn(`killing an orphaned sidecar left by an earlier run (pid ${pid})`)
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        /* already gone */
      }
    }
  }
}

export class SidecarProcess {
  readonly spec: SidecarSpec
  readonly #log: Logger
  readonly #events: SidecarEvents
  #child: ChildProcess | null = null
  #port: number | null = null
  #token: string | null = null
  #state: SidecarState = 'stopped'
  #restarts = 0
  #error: string | null = null
  /** Set while `stop()` is running, so the exit handler does not restart. */
  #stopping = false
  #startPromise: Promise<void> | null = null

  constructor(spec: SidecarSpec, events: SidecarEvents = {}, log?: Logger) {
    this.spec = spec
    this.#events = events
    this.#log = log ?? createLogger(`sidecar:${spec.name}`)
  }

  info(): SidecarInfo {
    return {
      state: this.#state,
      baseUrl: this.#port === null ? null : `http://${SIDECAR.host}:${this.#port}`,
      restarts: this.#restarts,
      error: this.#error,
    }
  }

  /** The per-launch bearer token, or `null` when not running. Never logged. */
  get token(): string | null {
    return this.#token
  }

  get baseUrl(): string | null {
    return this.#port === null ? null : `http://${SIDECAR.host}:${this.#port}`
  }

  /**
   * Start the server and wait until its health endpoint answers.
   *
   * Concurrent calls share one attempt — the engine's `load()` and the
   * watchdog can both ask without racing two children into existence.
   */
  async start(): Promise<void> {
    if (this.#state === 'running') return
    this.#startPromise ??= this.#startOnce().finally(() => {
      this.#startPromise = null
    })
    return this.#startPromise
  }

  async #startOnce(): Promise<void> {
    if (!isExecutable(this.spec.binaryPath)) {
      this.#fail(new SidecarMissingError(this.spec.binaryPath).message)
      throw new SidecarMissingError(this.spec.binaryPath)
    }

    this.#stopping = false
    this.#setState('starting')

    const port = await reserveLoopbackPort()
    const token = generateSidecarToken()
    this.#port = port
    this.#token = token

    const args = this.spec.buildArgs({ port, token })
    // A deliberately minimal environment: no inherited API keys, no proxy
    // variables that could make a "local" server talk to the internet.
    // Windows needs SystemRoot/TEMP for the CRT and a PATH that can resolve
    // sibling DLLs shipped next to the .exe.
    const env: NodeJS.ProcessEnv = {
      ...(process.platform === 'win32'
        ? {
            PATH: process.env['PATH'] ?? '',
            SystemRoot: process.env['SystemRoot'] ?? 'C:\\Windows',
            TEMP: process.env['TEMP'] ?? process.env['TMP'] ?? '',
            TMP: process.env['TMP'] ?? process.env['TEMP'] ?? '',
            USERPROFILE: process.env['USERPROFILE'] ?? '',
          }
        : {
            PATH: process.env['PATH'] ?? '/usr/bin:/bin',
            HOME: process.env['HOME'] ?? '',
            TMPDIR: process.env['TMPDIR'] ?? '/tmp',
          }),
      ...(this.spec.buildEnv?.({ port, token }) ?? {}),
    }

    this.#log.info(`starting on ${SIDECAR.host}:${port}`)

    // Run from the binary's directory so Windows loads co-located DLLs
    // (whisper.dll / ggml*.dll) without requiring PATH surgery.
    const cwd = this.spec.cwd ?? dirname(this.spec.binaryPath)

    reapOrphans(this.spec.binaryPath, this.#log)

    const child = spawn(this.spec.binaryPath, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Own process group on POSIX so SIGKILL reaches any workers it forked.
      // Windows has no real process groups for this pattern; keep attached.
      detached: process.platform !== 'win32',
      // whisper-server.exe / llama-server.exe are console-subsystem binaries:
      // spawned from a GUI process with no console, Windows would allocate and
      // *show* one, which sits on the desktop for the sidecar's whole life and
      // steals focus the moment it appears — mid-dictation.
      windowsHide: true,
    })
    this.#child = child

    child.stdout?.on('data', (chunk: Buffer) => {
      this.#log.debug(chunk.toString('utf8').trimEnd())
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      this.#log.debug(chunk.toString('utf8').trimEnd())
    })
    child.on('error', (error) => {
      this.#log.error('spawn failed:', error)
      this.#fail(error.message)
    })
    child.on('exit', (code, signal) => {
      this.#onExit(code, signal)
    })

    try {
      await this.#waitForHealth(port, token)
    } catch (error) {
      // A server that never became healthy is not going to; kill it now rather
      // than leave a zombie holding the port.
      await this.#kill()
      const message = error instanceof Error ? error.message : String(error)
      this.#fail(message)
      throw error
    }

    this.#restarts = 0
    this.#error = null
    this.#setState('running')
    this.#log.info('healthy')
  }

  async #waitForHealth(port: number, token: string): Promise<void> {
    const deadline = Date.now() + TIMEOUTS.sidecarHealthMs
    const url = `http://${SIDECAR.host}:${port}/${this.spec.healthPath.replace(/^\//, '')}`

    let lastError = 'no response'
    while (Date.now() < deadline) {
      if (this.#child === null || this.#child.exitCode !== null) {
        throw new Error(`${this.spec.name} exited before becoming healthy`)
      }
      try {
        const response = await loopbackFetch(url, {
          token,
          signal: AbortSignal.timeout(2_000),
        })
        // Any answer at all means the HTTP server is up. 401 would mean our own
        // token was rejected, which is a bug worth surfacing rather than looping on.
        if (response.ok) return
        lastError = `health check returned ${response.status}`
        if (response.status === 401 || response.status === 403) {
          throw new Error(`${this.spec.name} rejected its own bearer token`)
        }
      } catch (error) {
        if (error instanceof Error && error.message.includes('rejected its own')) throw error
        lastError = error instanceof Error ? error.message : String(error)
      }
      await sleep(SIDECAR.healthPollMs)
    }
    throw new Error(
      `${this.spec.name} did not become healthy within ${TIMEOUTS.sidecarHealthMs} ms (${lastError})`,
    )
  }

  #onExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.#child = null
    if (this.#stopping) {
      this.#log.info('stopped')
      this.#setState('stopped')
      return
    }

    this.#restarts += 1
    const how = signal ? `signal ${signal}` : `code ${code}`
    this.#log.warn(`exited unexpectedly (${how}); restart ${this.#restarts}/${SIDECAR.maxRestarts}`)

    if (this.#restarts > SIDECAR.maxRestarts) {
      this.#fail(
        `${this.spec.name} exited ${this.#restarts} times in a row (${how}); giving up. ` +
          `Check the model file and available memory, then re-select the model.`,
      )
      return
    }

    const backoff = Math.min(
      SIDECAR.restartBackoffMaxMs,
      SIDECAR.restartBackoffMs * 2 ** (this.#restarts - 1),
    )
    this.#setState('starting')
    setTimeout(() => {
      if (this.#stopping) return
      void this.start().catch((error: unknown) => {
        this.#log.error('restart failed:', error)
      })
    }, backoff).unref?.()
  }

  /** Stop the child: SIGTERM, then SIGKILL if it is still there. */
  async stop(): Promise<void> {
    this.#stopping = true
    const child = this.#child
    if (!child || child.exitCode !== null) {
      this.#child = null
      this.#port = null
      this.#token = null
      this.#setState('stopped')
      return
    }

    await this.#kill()
    this.#port = null
    this.#token = null
    this.#setState('stopped')
  }

  async #kill(): Promise<void> {
    const child = this.#child
    if (!child) return

    const exited = new Promise<void>((resolve) => {
      child.once('exit', () => resolve())
    })

    this.#signal(child, 'SIGTERM')
    const escalated = await Promise.race([
      exited.then(() => true),
      sleep(TIMEOUTS.sidecarShutdownMs).then(() => false),
    ])

    if (!escalated) {
      this.#log.warn('did not exit on SIGTERM; escalating to SIGKILL')
      this.#signal(child, 'SIGKILL')
      await Promise.race([exited, sleep(1_000)])
    }
    this.#child = null
  }

  /**
   * Signal the whole process group (negative pid) so forked workers die too;
   * fall back to the pid alone if the group is already gone.
   *
   * Windows has no process groups for this pattern and maps every signal to
   * `TerminateProcess`, so the SIGTERM→SIGKILL escalation carries no meaning
   * there. What does matter is reaching the *tree*: llama-server spawns
   * workers, and `child.kill()` alone leaves them holding several GB of model
   * memory and the port. `taskkill /T` is the portable way to get all of them.
   */
  #signal(child: ChildProcess, signal: NodeJS.Signals): void {
    const { pid } = child
    if (pid === undefined) return
    if (process.platform === 'win32') {
      try {
        // /T = tree, /F = force. Escalation is meaningless on Windows, so the
        // first ask is already the last one.
        execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        })
      } catch {
        // taskkill missing, access denied, or the process is already gone.
        try {
          child.kill(signal)
        } catch {
          /* already gone */
        }
      }
      return
    }
    try {
      process.kill(-pid, signal)
    } catch {
      try {
        child.kill(signal)
      } catch {
        /* already gone */
      }
    }
  }

  #fail(message: string): void {
    this.#error = message
    this.#port = null
    this.#token = null
    this.#setState('failed')
  }

  #setState(state: SidecarState): void {
    if (this.#state === state && state !== 'failed') return
    this.#state = state
    this.#events.onStateChange?.(this.info())
  }
}
