import type {
  EventChannel,
  EventOutput,
  InvokeChannel,
  InvokeRequestInput,
  InvokeResponseOutput,
  IpcMessageChannel,
  MessageInput,
} from './contract'
import type { Unsubscribe } from './typed'

/**
 * The object the preload script exposes as `window.murmur`.
 *
 * Every member is derived from {@link invokeContract} / {@link eventContract} /
 * {@link messageContract}, so a change to the contract shows up here as a type
 * error rather than as a silent mismatch at runtime.
 */

type Req<K extends InvokeChannel> = InvokeRequestInput<K>
type Res<K extends InvokeChannel> = InvokeResponseOutput<K>
type Evt<K extends EventChannel> = EventOutput<K>
type Msg<K extends IpcMessageChannel> = MessageInput<K>

export interface MurmurApi {
  readonly app: {
    version(): Promise<Res<'app.version'>>
    quit(): Promise<void>
    openHub(): Promise<void>
  }

  readonly settings: {
    get(): Promise<Res<'settings.get'>>
    set(patch: Req<'settings.set'>): Promise<Res<'settings.set'>>
    subscribe(listener: (settings: Evt<'settings.changed'>) => void): Unsubscribe
  }

  readonly dictation: {
    /** Current state, for a window that subscribes mid-utterance. */
    getState(): Promise<Res<'dictation.getState'>>
    subscribe(listener: (event: Evt<'dictation.state'>) => void): Unsubscribe
    /** High-rate mic amplitude, separate from state transitions. */
    onLevel(listener: (event: Evt<'audio.level'>) => void): Unsubscribe
    cancel(): Promise<void>
    startHandsFree(): Promise<void>
    stopHandsFree(): Promise<void>
  }

  /** Only the hidden capture renderer uses this half of the bridge. */
  readonly audio: {
    /** Capture renderer only: one ~100 ms chunk of 16 kHz mono Float32 PCM. */
    sendFrame(frame: Msg<'audio.frame'>): void
    /** Capture renderer only. */
    reportStatus(status: Msg<'audio.status'>): void
    /** Capture renderer only: the ~30 Hz meter main relays as `audio.level`. */
    reportLevel(level: Msg<'audio.meter'>): void
    /** Capture renderer only: the result of `enumerateDevices`. */
    reportDevices(devices: Msg<'audio.devices'>): void
    /** Capture commands from the orchestrator: warm / start / stop / release. */
    onCommand(listener: (command: Evt<'audio.command'>) => void): Unsubscribe
    /** Mic pickers: the last known device list. */
    listDevices(): Promise<Res<'audio.listDevices'>>
    onDevicesChanged(listener: (devices: Evt<'audio.devicesChanged'>) => void): Unsubscribe
  }

  /** Bar renderer only. */
  readonly bar: {
    /** Take the window out of click-through while the pointer is on the pill. */
    setPointerRegion(region: Msg<'bar.pointerRegion'>): void
  }

  readonly models: {
    list(): Promise<Res<'models.list'>>
    downloadStart(request: Req<'models.downloadStart'>): Promise<Res<'models.downloadStart'>>
    downloadCancel(request: Req<'models.downloadCancel'>): Promise<void>
    onDownloadProgress(listener: (progress: Evt<'models.downloadProgress'>) => void): Unsubscribe
    select(request: Req<'models.select'>): Promise<Res<'models.select'>>
    remove(request: Req<'models.delete'>): Promise<void>
    import(request: Req<'models.import'>): Promise<Res<'models.import'>>
    /** Native open-dialog; resolves to the chosen path or `null` if cancelled. */
    chooseFile(): Promise<Res<'models.chooseFile'>>
  }

  readonly engines: {
    status(): Promise<Res<'engines.status'>>
    subscribe(listener: (status: Evt<'engines.changed'>) => void): Unsubscribe
  }

  readonly history: {
    query(request: Req<'history.query'>): Promise<Res<'history.query'>>
    remove(request: Req<'history.delete'>): Promise<void>
    clear(): Promise<void>
    stats(): Promise<Res<'history.stats'>>
  }

  readonly dictionary: {
    list(): Promise<Res<'dictionary.list'>>
    create(entry: Req<'dictionary.create'>): Promise<Res<'dictionary.create'>>
    update(request: Req<'dictionary.update'>): Promise<Res<'dictionary.update'>>
    remove(request: Req<'dictionary.delete'>): Promise<void>
  }

  readonly style: {
    get(): Promise<Res<'style.get'>>
    set(patch: Req<'style.set'>): Promise<Res<'style.set'>>
  }

  readonly permissions: {
    status(): Promise<Res<'permissions.status'>>
    request(request: Req<'permissions.request'>): Promise<Res<'permissions.request'>>
    openSystemSettings(request: Req<'permissions.openSystemSettings'>): Promise<void>
  }

  /** Present in unpackaged builds only; the handler is not registered otherwise. */
  readonly debug: {
    /** Canned state cycle — no mic, no models, no native tap. */
    simulateDictation(): Promise<void>
    /** Drives the real pipeline with a synthetic hotkey edge. */
    simulateHotkey(request: Req<'debug.simulateHotkey'>): Promise<void>
  }
}
