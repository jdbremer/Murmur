import type { z } from 'zod'
import {
  eventContract,
  invokeContract,
  messageContract,
  type EventChannel,
  type EventInput,
  type EventOutput,
  type InvokeChannel,
  type InvokeRequestInput,
  type InvokeRequestOutput,
  type InvokeResponseInput,
  type InvokeResponseOutput,
  type IpcMessageChannel,
  type MessageInput,
  type MessageOutput,
} from './contract'

/**
 * Typed, zod-validated wrappers around Electron's raw `ipcMain` / `ipcRenderer`.
 *
 * Validation rule, applied consistently on both sides:
 *
 *  - **Inbound payloads are always parsed.** That is what applies schema
 *    defaults, so a channel behaves identically in dev and in production and a
 *    malformed message from a compromised renderer never reaches a handler.
 *  - **Outbound payloads are validated when {@link IpcOptions.validate} is on**
 *    (default: any build that is not `NODE_ENV=production`). This catches
 *    "handler returned the wrong shape" while developing, at no shipping cost.
 */

// ---------------------------------------------------------------------------
// Structural stand-ins for the Electron types (this package must not depend on
// electron — it is imported by renderers too).
// ---------------------------------------------------------------------------

export interface IpcMainLike {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void
  removeHandler(channel: string): void
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown
  removeAllListeners(channel: string): unknown
}

export interface IpcRendererLike {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
  send(channel: string, ...args: unknown[]): void
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown
  removeListener(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown
}

/** The slice of Electron's `WebContents` main needs to push events. */
export interface WebContentsLike {
  send(channel: string, ...args: unknown[]): void
  isDestroyed(): boolean
}

export type Unsubscribe = () => void

export interface IpcOptions {
  /**
   * Validate *outbound* payloads too. Defaults to `true` unless
   * `NODE_ENV === 'production'`.
   */
  validate?: boolean
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type IpcDirection = 'request' | 'response' | 'event' | 'message'

export class IpcValidationError extends Error {
  override readonly name = 'IpcValidationError'
  readonly channel: string
  readonly direction: IpcDirection
  readonly issues: readonly string[]

  constructor(channel: string, direction: IpcDirection, issues: readonly string[]) {
    super(
      `IPC ${direction} payload for "${channel}" failed validation:\n  - ${issues.join('\n  - ')}`,
    )
    this.channel = channel
    this.direction = direction
    this.issues = issues
  }
}

/**
 * Read `NODE_ENV` without depending on `@types/node` — this package is compiled
 * into renderers too, where `process` does not exist at all (context isolation)
 * and node globals are deliberately not in scope.
 */
function isProduction(): boolean {
  const host = globalThis as { process?: { env?: Record<string, string | undefined> } }
  return host.process?.env?.['NODE_ENV'] === 'production'
}

function parseOrThrow<T extends z.ZodType>(
  schema: T,
  value: unknown,
  channel: string,
  direction: IpcDirection,
): z.output<T> {
  const result = schema.safeParse(value)
  if (result.success) return result.data
  const issues = result.error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '<root>'
    return `${path}: ${issue.message}`
  })
  throw new IpcValidationError(channel, direction, issues)
}

function requireDefinition<T>(map: Record<string, T>, channel: string, kind: string): T {
  const definition = map[channel]
  if (!definition) {
    throw new Error(`Unknown ${kind} IPC channel "${channel}". Declare it in @murmur/shared/ipc.`)
  }
  return definition
}

// ---------------------------------------------------------------------------
// Main process
// ---------------------------------------------------------------------------

export type InvokeHandler<K extends InvokeChannel> = (
  payload: InvokeRequestOutput<K>,
  event: unknown,
) => InvokeResponseInput<K> | Promise<InvokeResponseInput<K>>

export type MessageHandler<K extends IpcMessageChannel> = (
  payload: MessageOutput<K>,
  event: unknown,
) => void

export interface MainIpc {
  /** Register the single handler for a request/response channel. */
  handle<K extends InvokeChannel>(channel: K, handler: InvokeHandler<K>): void
  removeHandler(channel: InvokeChannel): void
  /** Listen for fire-and-forget messages from a renderer. */
  receive<K extends IpcMessageChannel>(channel: K, handler: MessageHandler<K>): void
  removeReceiver(channel: IpcMessageChannel): void
  /** Push an event to one window. No-op if its web contents are gone. */
  emit<K extends EventChannel>(
    target: WebContentsLike | null | undefined,
    channel: K,
    payload: EventInput<K>,
  ): void
  /** Push an event to every live window in `targets`. */
  broadcast<K extends EventChannel>(
    targets: Iterable<WebContentsLike | null | undefined>,
    channel: K,
    payload: EventInput<K>,
  ): void
}

export function createMainIpc(ipcMain: IpcMainLike, options: IpcOptions = {}): MainIpc {
  const validateOutbound = options.validate ?? !isProduction()

  return {
    handle(channel, handler) {
      const definition = requireDefinition(invokeContract, channel, 'invoke')
      ipcMain.handle(channel, async (event, ...args) => {
        const payload = parseOrThrow(definition.request, args[0], channel, 'request')
        const result = await handler(payload as never, event)
        return validateOutbound
          ? parseOrThrow(definition.response, result, channel, 'response')
          : result
      })
    },

    removeHandler(channel) {
      ipcMain.removeHandler(channel)
    },

    receive(channel, handler) {
      const schema = requireDefinition(messageContract, channel, 'message')
      ipcMain.on(channel, (event, ...args) => {
        const payload = parseOrThrow(schema, args[0], channel, 'message')
        handler(payload as never, event)
      })
    },

    removeReceiver(channel) {
      ipcMain.removeAllListeners(channel)
    },

    emit(target, channel, payload) {
      if (!target || target.isDestroyed()) return
      const schema = requireDefinition(eventContract, channel, 'event')
      const body = validateOutbound ? parseOrThrow(schema, payload, channel, 'event') : payload
      target.send(channel, body)
    },

    broadcast(targets, channel, payload) {
      const schema = requireDefinition(eventContract, channel, 'event')
      // Validate once, then fan out — cheaper than per-target parsing.
      const body = validateOutbound ? parseOrThrow(schema, payload, channel, 'event') : payload
      for (const target of targets) {
        if (!target || target.isDestroyed()) continue
        target.send(channel, body)
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Renderer / preload
// ---------------------------------------------------------------------------

/**
 * Channels whose request schema is `z.void()` take no argument; every other
 * channel requires exactly one.
 */
export type InvokeArgs<K extends InvokeChannel> = [void] extends [InvokeRequestInput<K>]
  ? [payload?: undefined]
  : [payload: InvokeRequestInput<K>]

export interface RendererIpc {
  invoke<K extends InvokeChannel>(
    channel: K,
    ...args: InvokeArgs<K>
  ): Promise<InvokeResponseOutput<K>>
  send<K extends IpcMessageChannel>(channel: K, payload: MessageInput<K>): void
  /** Subscribe to a main→renderer event. Returns an unsubscribe function. */
  on<K extends EventChannel>(channel: K, listener: (payload: EventOutput<K>) => void): Unsubscribe
}

export function createRendererIpc(
  ipcRenderer: IpcRendererLike,
  options: IpcOptions = {},
): RendererIpc {
  const validateOutbound = options.validate ?? !isProduction()

  async function invoke<K extends InvokeChannel>(
    channel: K,
    ...args: InvokeArgs<K>
  ): Promise<InvokeResponseOutput<K>> {
    const definition = requireDefinition(invokeContract, channel, 'invoke')
    const payload = validateOutbound
      ? parseOrThrow(definition.request, args[0], channel, 'request')
      : args[0]
    const raw = await ipcRenderer.invoke(channel, payload)
    return parseOrThrow(definition.response, raw, channel, 'response') as InvokeResponseOutput<K>
  }

  function send<K extends IpcMessageChannel>(channel: K, payload: MessageInput<K>): void {
    const schema = requireDefinition(messageContract, channel, 'message')
    const body = validateOutbound ? parseOrThrow(schema, payload, channel, 'message') : payload
    ipcRenderer.send(channel, body)
  }

  function on<K extends EventChannel>(
    channel: K,
    listener: (payload: EventOutput<K>) => void,
  ): Unsubscribe {
    const schema = requireDefinition(eventContract, channel, 'event')
    const wrapped = (_event: unknown, ...args: unknown[]): void => {
      listener(parseOrThrow(schema, args[0], channel, 'event') as EventOutput<K>)
    }
    ipcRenderer.on(channel, wrapped)
    return () => {
      ipcRenderer.removeListener(channel, wrapped)
    }
  }

  return { invoke, send, on }
}
