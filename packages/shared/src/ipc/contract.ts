import { z } from 'zod'
import {
  AudioCaptureStatusSchema,
  AudioCommandSchema,
  AudioDeviceListSchema,
  AudioFrameSchema,
  AudioLevelEventSchema,
  DictationEventSchema,
  DictationRecordSchema,
  HistoryStatsSchema,
} from '../domain/dictation'
import {
  DictionaryEntryDraftSchema,
  DictionaryEntryPatchSchema,
  DictionaryEntrySchema,
} from '../domain/dictionary'
import { EnginesStatusSchema } from '../domain/engine'
import { HardwareReportSchema } from '../domain/hardware'
import { PermissionKindSchema, PermissionsStatusSchema } from '../domain/permissions'
import { SettingsPatchSchema, SettingsSchema } from '../domain/settings'
import { UpdateStateSchema } from '../domain/updates'
import { StyleProfilePatchSchema, StyleProfileSetSchema } from '../domain/style'
import {
  ImportedModelSchema,
  InstalledModelSchema,
  ModelCatalogSchema,
  ModelDownloadProgressSchema,
  ModelEngineSchema,
  ModelKindSchema,
} from '../catalog/schema'

/**
 * The single source of truth for every message that crosses a process boundary.
 *
 * Three kinds of traffic, deliberately separated so the direction of each
 * channel is obvious from where it is declared:
 *
 *  - {@link invokeContract} — renderer → main, request/response.
 *  - {@link eventContract}  — main → renderer, broadcast.
 *  - {@link messageContract} — renderer → main, fire-and-forget.
 *
 * Adding a channel means adding one entry here. `createMainIpc` /
 * `createRendererIpc` pick it up with no further wiring, and both sides get the
 * payload types for free.
 */

export interface IpcInvokeDefinition<
  Req extends z.ZodType = z.ZodType,
  Res extends z.ZodType = z.ZodType,
> {
  readonly request: Req
  readonly response: Res
}

// ---------------------------------------------------------------------------
// Composite payloads
// ---------------------------------------------------------------------------

/** Everything the Models section needs for one render (PLAN §8). */
export const ModelsListSchema = z.object({
  catalog: ModelCatalogSchema,
  installed: z.array(InstalledModelSchema),
  imported: z.array(ImportedModelSchema),
  diskUsageBytes: z.number().int().nonnegative(),
  /** Per-entry Runs well / Tight / Not recommended badges (PLAN §8). */
  hardware: HardwareReportSchema,
  /**
   * Set when the shipped catalog failed validation — the list is then empty by
   * design and the Models section must say why (PLAN §8 origin policy).
   */
  catalogError: z.string().nullable().default(null),
})
export type ModelsList = z.infer<typeof ModelsListSchema>

/** "Bring your own model" — bypasses the catalog, labelled origin-unverified. */
export const ModelImportRequestSchema = z.object({
  kind: ModelKindSchema,
  engine: ModelEngineSchema,
  displayName: z.string().min(1),
  source: z.discriminatedUnion('type', [
    z.object({ type: z.literal('file'), path: z.string().min(1) }),
    z.object({ type: z.literal('huggingface'), repoId: z.string().min(1) }),
  ]),
})
export type ModelImportRequest = z.infer<typeof ModelImportRequestSchema>

export const HistoryQuerySchema = z.object({
  /** Full-text query against raw and polished text; empty = everything. */
  search: z.string().default(''),
  limit: z.number().int().positive().max(500).default(50),
  offset: z.number().int().nonnegative().default(0),
})
export type HistoryQuery = z.infer<typeof HistoryQuerySchema>

export const HistoryPageSchema = z.object({
  records: z.array(DictationRecordSchema),
  /** Total matches, ignoring limit/offset — drives paging. */
  total: z.number().int().nonnegative(),
})
export type HistoryPage = z.infer<typeof HistoryPageSchema>

const IdRequestSchema = z.object({ id: z.string().min(1) })
const ModelIdRequestSchema = z.object({ modelId: z.string().min(1) })
const PermissionKindRequestSchema = z.object({ kind: PermissionKindSchema })

/** Dev-only: the hotkey edges the native tap would otherwise produce. */
export const DebugHotkeyRequestSchema = z.object({
  action: z.enum(['down', 'up', 'doubleTap']),
})
export type DebugHotkeyRequest = z.infer<typeof DebugHotkeyRequestSchema>

/**
 * Compact runtime snapshot for Help / Dev tools (platform, native module,
 * last mic status). Safe to expose in unpackaged builds; contains no audio.
 */
export const AppInfoSchema = z.object({
  version: z.string().min(1),
  /** Node-style platform string, e.g. `darwin`, `win32`, `linux`. */
  platform: z.string().min(1),
  arch: z.string().min(1),
  /** True when running unpackaged (`electron-vite dev` / local out/). */
  isDev: z.boolean(),
  /**
   * True only when `MURMUR_DEV_TOOLS=1`. The Help Developer panel is **not**
   * shown in normal dev or production — agent IPC still works in unpackaged builds.
   */
  showDevTools: z.boolean().default(false),
  /** One-line `@murmur/native` description (active vs stub). */
  native: z.string().min(1),
})
export type AppInfo = z.infer<typeof AppInfoSchema>

// ---------------------------------------------------------------------------
// renderer → main, request/response
// ---------------------------------------------------------------------------

export const invokeContract = {
  // --- app ---------------------------------------------------------------
  'app.version': { request: z.void(), response: z.string().min(1) },
  /** Platform + native status for Help / Windows-mode UI branching. */
  'app.info': { request: z.void(), response: AppInfoSchema },
  /**
   * User-pressed update check. Never fires on a timer — see `updates.ts` and
   * the "Network activity" row in Help, which both promise as much.
   */
  'app.checkForUpdate': { request: z.void(), response: UpdateStateSchema },
  /** Current update state, for a Hub that opened mid-flow. */
  'app.updateState': { request: z.void(), response: UpdateStateSchema },
  /**
   * Fetch the update. Separate from checking on purpose: finding out a release
   * exists and pulling ~190 MB are two different consents.
   */
  'app.downloadUpdate': { request: z.void(), response: UpdateStateSchema },
  /** Quit, swap the app, relaunch. Does not return. */
  'app.installUpdate': { request: z.void(), response: z.void() },
  /** Open the release page — the fallback when self-update is unsupported. */
  'app.openReleasePage': { request: z.object({ url: z.string() }), response: z.void() },
  /**
   * Quit and start again. Accessibility and Input Monitoring are decided for
   * the life of a process, so a grant made while Murmur is running is not
   * visible to it until it restarts — no amount of re-checking helps.
   */
  'app.relaunch': { request: z.void(), response: z.void() },
  /**
   * True in unpackaged builds. UI that fronts a dev-only channel (the three
   * Simulate widgets) renders only when this is true — a button whose backing
   * handler does not exist in a packaged build must not exist either.
   */
  'app.devMode': { request: z.void(), response: z.boolean() },
  'app.quit': { request: z.void(), response: z.void() },
  'app.openHub': { request: z.void(), response: z.void() },

  // --- settings ----------------------------------------------------------
  'settings.get': { request: z.void(), response: SettingsSchema },
  'settings.set': { request: SettingsPatchSchema, response: SettingsSchema },

  // --- dictation control (PLAN §2.1 interaction, §3.2 cancel paths) -------
  'dictation.getState': { request: z.void(), response: DictationEventSchema },
  'dictation.cancel': { request: z.void(), response: z.void() },
  'dictation.startHandsFree': { request: z.void(), response: z.void() },
  'dictation.stopHandsFree': { request: z.void(), response: z.void() },

  // --- audio devices (PLAN §2.2.5 mic picker) ----------------------------
  /**
   * The microphones main last heard about from the capture renderer. An invoke
   * rather than a bare event so a picker that opens between `devicechange`
   * notifications still has a list to render.
   */
  'audio.listDevices': { request: z.void(), response: AudioDeviceListSchema },
  /**
   * The capture renderer's last lifecycle report. This is how a mic failure
   * that happened while nothing was listening — permission denied at the
   * startup warm, a device already in use — stays visible: the orchestrator
   * rightly ignores errors while idle (there is no dictation to fail), so the
   * Hub reads the state from here instead (HANDOFF item #4).
   */
  'audio.captureStatus': { request: z.void(), response: AudioCaptureStatusSchema },

  // --- models (PLAN §8) --------------------------------------------------
  'models.list': { request: z.void(), response: ModelsListSchema },
  'models.downloadStart': {
    request: ModelIdRequestSchema,
    response: z.object({ downloadId: z.string().min(1) }),
  },
  'models.downloadCancel': {
    request: z.object({ downloadId: z.string().min(1) }),
    response: z.void(),
  },
  /** `modelId: null` clears the selection for that kind (e.g. polishing off). */
  'models.select': {
    request: z.object({ kind: ModelKindSchema, modelId: z.string().min(1).nullable() }),
    response: SettingsSchema,
  },
  'models.delete': { request: ModelIdRequestSchema, response: z.void() },
  'models.import': { request: ModelImportRequestSchema, response: ImportedModelSchema },
  /**
   * Native open-dialog for "bring your own model". Returns the chosen path, or
   * `null` if the user cancelled.
   *
   * A dialog rather than an `<input type="file">` because a sandboxed renderer
   * cannot turn a `File` into the absolute path `models.import` needs, and
   * because this way the file filters live next to the engines that define them.
   */
  'models.chooseFile': { request: z.void(), response: z.string().min(1).nullable() },

  // --- engines (PLAN §6.1, §7.1) -----------------------------------------
  /** Current STT + polish engine lifecycle, for the Hub's Models/Help panels. */
  'engines.status': { request: z.void(), response: EnginesStatusSchema },
  /**
   * Download and install a sidecar binary (Windows prebuild) after user consent.
   * Used when polish/STT needs whisper-server / llama-server and it is missing.
   */
  'engines.installSidecar': {
    request: z.object({
      which: z.enum(['llama-server', 'whisper-server']),
    }),
    response: z.object({
      ok: z.boolean(),
      which: z.enum(['llama-server', 'whisper-server']),
      path: z.string().nullable(),
      error: z.string().nullable(),
      detail: z.string(),
    }),
  },

  // --- history (PLAN §2.2.1) ---------------------------------------------
  'history.query': { request: HistoryQuerySchema, response: HistoryPageSchema },
  'history.delete': { request: IdRequestSchema, response: z.void() },
  'history.clear': { request: z.void(), response: z.void() },
  'history.stats': { request: z.void(), response: HistoryStatsSchema },

  // --- dictionary (PLAN §2.2.2) ------------------------------------------
  'dictionary.list': { request: z.void(), response: z.array(DictionaryEntrySchema) },
  'dictionary.create': { request: DictionaryEntryDraftSchema, response: DictionaryEntrySchema },
  'dictionary.update': {
    request: z.object({ id: z.string().min(1), patch: DictionaryEntryPatchSchema }),
    response: DictionaryEntrySchema,
  },
  'dictionary.delete': { request: IdRequestSchema, response: z.void() },

  // --- style (PLAN §2.2.3) -----------------------------------------------
  'style.get': { request: z.void(), response: StyleProfileSetSchema },
  'style.set': { request: StyleProfilePatchSchema, response: StyleProfileSetSchema },

  // --- permissions (PLAN §4) ---------------------------------------------
  'permissions.status': { request: z.void(), response: PermissionsStatusSchema },
  'permissions.request': {
    request: PermissionKindRequestSchema,
    response: PermissionsStatusSchema,
  },
  'permissions.openSystemSettings': { request: PermissionKindRequestSchema, response: z.void() },

  // --- debug (registered only in unpackaged builds) -----------------------
  /** Cycles the dictation state machine so the Bar can be built without a mic. */
  'debug.simulateDictation': { request: z.void(), response: z.void() },
  /**
   * Feeds the *real* orchestrator a synthetic hotkey edge, so the whole
   * pipeline (capture → VAD → STT → polish → insert) can be exercised on a dev
   * machine that has no event tap. Unlike `debug.simulateDictation` this runs
   * the production code path; it just replaces the trigger.
   */
  'debug.simulateHotkey': { request: DebugHotkeyRequestSchema, response: z.void() },
  /**
   * Re-issue `audio.command` warm so Dev tools can re-open the mic after a
   * permission denial or device change without restarting the app.
   */
  'debug.warmMic': { request: z.void(), response: z.void() },
  /**
   * Agent / Dev: push synthetic 16 kHz mono PCM into the orchestrator as if the
   * capture worklet had produced it. Used for unattended mic simulation without
   * a real microphone (WINDOWS-HANDOFF agent loop).
   */
  'debug.injectPcm': {
    request: z.object({
      /** How long the synthetic utterance should last (ignored when `samples` is set). */
      durationMs: z.number().positive().max(30_000).default(800),
      /** Peak amplitude 0..1 (energy for VAD / levels). Sine path only. */
      amplitude: z.number().min(0).max(1).default(0.35),
      /** Sine frequency in Hz — audible-ish energy, not speech content. */
      frequencyHz: z.number().positive().max(4000).default(220),
      /**
       * Optional raw 16 kHz mono Float32 samples (−1..1). When provided, these
       * are pushed instead of a generated sine — for agent G7 speech-file proof.
       * Cap keeps IPC bounded (~30 s at 16 kHz).
       */
      samples: z
        .array(z.number())
        .max(16_000 * 30)
        .optional(),
    }),
    response: z.object({
      frames: z.number().int().nonnegative(),
      sampleCount: z.number().int().nonnegative(),
    }),
  },
  /**
   * Agent: one JSON snapshot of platform, native, engines, dictation, last
   * capture status — machine-readable without a screenshot.
   */
  'debug.snapshot': {
    request: z.void(),
    response: z.object({
      app: AppInfoSchema,
      dictation: DictationEventSchema,
      engines: EnginesStatusSchema,
      capture: AudioCaptureStatusSchema.nullable(),
    }),
  },
  /**
   * Agent / Dev: run the real TextInjector path with a fixed phrase (G5 paste
   * proof). Focus the target app first; does not run STT.
   */
  'debug.insertText': {
    request: z.object({
      text: z.string().min(1).max(10_000).default('hello'),
    }),
    response: z.object({
      ok: z.boolean(),
      method: z.enum(['paste', 'accessibility', 'none']),
      error: z.string().optional(),
    }),
  },
} as const satisfies Record<string, IpcInvokeDefinition>

export type InvokeContract = typeof invokeContract
export type InvokeChannel = keyof InvokeContract

// ---------------------------------------------------------------------------
// main → renderer, broadcast
// ---------------------------------------------------------------------------

export const eventContract = {
  /** Every dictation state transition (PLAN §2.1 state table). */
  'dictation.state': DictationEventSchema,
  /** High-rate mic amplitude for the Bar's waveform. */
  'audio.level': AudioLevelEventSchema,
  /** Broadcast after any successful `settings.set`, to all windows. */
  'settings.changed': SettingsSchema,
  /**
   * Update flow progress. Pushed rather than polled because a download reports
   * continuously, and the Hub should not have to ask repeatedly to draw a bar.
   */
  'app.updateChanged': UpdateStateSchema,
  'models.downloadProgress': ModelDownloadProgressSchema,
  /**
   * Engine lifecycle changed — model swapped, sidecar died, runtime missing.
   * Named `changed` rather than `status` because channel names are unique
   * across all three maps (see the contract-hygiene test), and the
   * request/response half already owns `engines.status`.
   */
  'engines.changed': EnginesStatusSchema,
  /**
   * Main → hidden capture renderer. The orchestrator owns when the mic opens;
   * the renderer only obeys (PLAN §5: warm the stream, capture on hotkey-down).
   */
  'audio.command': AudioCommandSchema,
  /** The microphone list changed (device plugged in, AirPods connected). */
  'audio.devicesChanged': AudioDeviceListSchema,
  /** The capture renderer's lifecycle changed — including errors while idle. */
  'audio.captureChanged': AudioCaptureStatusSchema,
} as const satisfies Record<string, z.ZodType>

export type EventContract = typeof eventContract
export type EventChannel = keyof EventContract

// ---------------------------------------------------------------------------
// renderer → main, fire-and-forget
// ---------------------------------------------------------------------------

export const messageContract = {
  /** 16 kHz mono Float32 PCM chunks from the hidden capture renderer (PLAN §5). */
  'audio.frame': AudioFrameSchema,
  'audio.status': AudioCaptureStatusSchema,
  /**
   * Mic amplitude from the capture renderer at ~30 Hz, which main relays to the
   * Bar as `audio.level`. It rides its own channel rather than being derived
   * from `audio.frame` because frames are ~100 ms apart: a 10 Hz envelope makes
   * the waveform look like it is stepping, and PLAN §2.1 wants it dancing.
   */
  'audio.meter': AudioLevelEventSchema,
  /**
   * The Bar renderer telling main whether the pointer is over the pill.
   *
   * The Bar window is click-through (`setIgnoreMouseEvents(true, forward)`) so
   * it never blocks the app underneath; mouse *moves* still arrive, and the
   * renderer flips the window back to interactive for as long as the pointer is
   * inside the capsule (PLAN §2.1 "click-through everywhere except the pill").
   */
  'bar.pointerRegion': z.object({ interactive: z.boolean() }),
  /** The capture renderer's view of the available microphones. */
  'audio.devices': AudioDeviceListSchema,
} as const satisfies Record<string, z.ZodType>

export type MessageContract = typeof messageContract
/** Named to avoid colliding with the DOM's `MessageChannel`. */
export type IpcMessageChannel = keyof MessageContract

// ---------------------------------------------------------------------------
// Payload type helpers
// ---------------------------------------------------------------------------

/** What a caller passes (defaults may be omitted). */
export type InvokeRequestInput<K extends InvokeChannel> = z.input<InvokeContract[K]['request']>
/** What a handler receives (defaults applied). */
export type InvokeRequestOutput<K extends InvokeChannel> = z.output<InvokeContract[K]['request']>
/** What a handler returns (defaults may be omitted). */
export type InvokeResponseInput<K extends InvokeChannel> = z.input<InvokeContract[K]['response']>
/** What a caller receives (defaults applied). */
export type InvokeResponseOutput<K extends InvokeChannel> = z.output<InvokeContract[K]['response']>

export type EventInput<K extends EventChannel> = z.input<EventContract[K]>
export type EventOutput<K extends EventChannel> = z.output<EventContract[K]>

export type MessageInput<K extends IpcMessageChannel> = z.input<MessageContract[K]>
export type MessageOutput<K extends IpcMessageChannel> = z.output<MessageContract[K]>

// ---------------------------------------------------------------------------
// Channel name constants (for call sites that want a symbol, not a string)
// ---------------------------------------------------------------------------

export const INVOKE_CHANNELS = Object.keys(invokeContract) as InvokeChannel[]
export const EVENT_CHANNELS = Object.keys(eventContract) as EventChannel[]
export const MESSAGE_CHANNELS = Object.keys(messageContract) as IpcMessageChannel[]

/** Every channel name in one frozen list — handy for preload allowlisting. */
export const ALL_IPC_CHANNELS: readonly string[] = Object.freeze([
  ...INVOKE_CHANNELS,
  ...EVENT_CHANNELS,
  ...MESSAGE_CHANNELS,
])

export function isInvokeChannel(value: string): value is InvokeChannel {
  return Object.prototype.hasOwnProperty.call(invokeContract, value)
}
export function isEventChannel(value: string): value is EventChannel {
  return Object.prototype.hasOwnProperty.call(eventContract, value)
}
export function isMessageChannel(value: string): value is IpcMessageChannel {
  return Object.prototype.hasOwnProperty.call(messageContract, value)
}
