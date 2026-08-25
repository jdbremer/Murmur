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
    info(): Promise<Res<'app.info'>>
    /** User-pressed only; there is no background check (PLAN §10.2). */
    checkForUpdate(): Promise<Res<'app.checkForUpdate'>>
    updateState(): Promise<Res<'app.updateState'>>
    /** A second, separate consent: checking does not pull ~190 MB. */
    downloadUpdate(): Promise<Res<'app.downloadUpdate'>>
    /** Quits and relaunches into the new version. */
    installUpdate(): Promise<void>
    onUpdateChanged(listener: (state: Evt<'app.updateChanged'>) => void): Unsubscribe
    openReleasePage(request: Req<'app.openReleasePage'>): Promise<void>
    /** Quit and reopen — how a permission grant becomes visible to the app. */
    relaunch(): Promise<void>
    /** True in unpackaged builds; gates the Simulate widgets. */
    devMode(): Promise<Res<'app.devMode'>>
    quit(): Promise<void>
    openHub(): Promise<void>
    /** Copy text to the system clipboard (see the contract for why not the DOM API). */
    copyText(payload: Req<'app.copyText'>): Promise<void>
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

  /** Long-form meeting capture (PLAN §18.2). Inert unless enabled in settings. */
  readonly meetings: {
    start(request: Req<'meeting.start'>): Promise<Res<'meeting.start'>>
    stop(): Promise<Res<'meeting.stop'>>
    /** Current state, for a window that opened mid-meeting. */
    getState(): Promise<Res<'meeting.state'>>
    subscribe(listener: (event: Evt<'meeting.changed'>) => void): Unsubscribe
    /** Answer a detection prompt. */
    respondToOffer(response: Req<'meeting.respondToOffer'>): Promise<Res<'meeting.respondToOffer'>>
    list(): Promise<Res<'meeting.list'>>
    /** Removes the row *and* the transcript file. */
    delete(request: Req<'meeting.delete'>): Promise<Res<'meeting.delete'>>
    reveal(request: Req<'meeting.reveal'>): Promise<void>
    openFolder(): Promise<void>
    /** Whether the far side can be captured, and whether we are allowed to. */
    systemAudioAccess(): Promise<Res<'meeting.systemAudioAccess'>>
    /** Attempting a tap *is* the request — macOS has no way to merely ask. */
    requestSystemAudio(): Promise<Res<'meeting.requestSystemAudio'>>
  }

  /** File transcription (PLAN §18.4). The Hub decodes; main transcribes. */
  readonly transcribe: {
    begin(request: Req<'transcribe.begin'>): Promise<Res<'transcribe.begin'>>
    /** Resolves when main has room for more — await it before the next slice. */
    push(request: Req<'transcribe.push'>): Promise<Res<'transcribe.push'>>
    cancel(request: Req<'transcribe.cancel'>): Promise<Res<'transcribe.cancel'>>
    /** Jobs main still remembers, for a section that mounts mid-transcription. */
    list(): Promise<Res<'transcribe.list'>>
    /** The full transcript — heavy, so pulled rather than pushed. */
    result(request: Req<'transcribe.result'>): Promise<Res<'transcribe.result'>>
    /** Native save dialog; `path: null` means the user cancelled. */
    export(request: Req<'transcribe.export'>): Promise<Res<'transcribe.export'>>
    clear(request: Req<'transcribe.clear'>): Promise<void>
    subscribe(listener: (event: Evt<'transcribe.changed'>) => void): Unsubscribe
  }

  /** Only the hidden capture renderer uses this half of the bridge. */
  readonly audio: {
    /** Capture renderer only: one ~100 ms chunk of 16 kHz mono Float32 PCM. */
    sendFrame(frame: Msg<'audio.frame'>): void
    /** Capture renderer only: the Windows loopback stream, when running. */
    sendSystemFrame(frame: Msg<'audio.systemFrame'>): void
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
    /** The capture renderer's last lifecycle report — errors included. */
    captureStatus(): Promise<Res<'audio.captureStatus'>>
    onCaptureChanged(listener: (status: Evt<'audio.captureChanged'>) => void): Unsubscribe
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
    /** User-consented download of whisper-server / llama-server (Windows). */
    installSidecar(request: Req<'engines.installSidecar'>): Promise<Res<'engines.installSidecar'>>
  }

  readonly history: {
    query(request: Req<'history.query'>): Promise<Res<'history.query'>>
    remove(request: Req<'history.delete'>): Promise<void>
    /** Undo a `remove`. Re-inserts the row; leaves every counter alone. */
    restore(request: Req<'history.restore'>): Promise<void>
    /** Run the polishing model over a transcript that was inserted raw. */
    repolish(request: Req<'history.repolish'>): Promise<Res<'history.repolish'>>
    clear(): Promise<void>
    stats(): Promise<Res<'history.stats'>>
    /** Fires after every dictation, carrying the new lifetime totals. */
    subscribe(listener: (stats: Evt<'history.changed'>) => void): Unsubscribe
  }

  /**
   * Getting your data out, and back in (PLAN §10.5).
   *
   * A `path` of `null` in any result means the user cancelled the file dialog,
   * which is the ordinary outcome and never an error.
   */
  readonly data: {
    exportHistory(request: Req<'data.exportHistory'>): Promise<Res<'data.exportHistory'>>
    exportNotes(): Promise<Res<'data.exportNotes'>>
    backup(request: Req<'data.backup'>): Promise<Res<'data.backup'>>
    /** Read a backup without applying it, so the user can be shown what it holds. */
    restorePreview(): Promise<Res<'data.restorePreview'>>
    restore(request: Req<'data.restore'>): Promise<Res<'data.restore'>>
  }

  readonly insights: {
    /**
     * One read for the whole section. Re-fetch on `history.changed` rather than
     * on a channel of its own — that event already fires after every dictation
     * and is the only thing that can move these numbers.
     */
    get(): Promise<Res<'insights.get'>>
    /** Zero every counter; returns the (now empty) insights. */
    reset(): Promise<Res<'insights.reset'>>
  }

  readonly notes: {
    list(request: Req<'notes.list'>): Promise<Res<'notes.list'>>
    get(request: Req<'notes.get'>): Promise<Res<'notes.get'>>
    create(draft: Req<'notes.create'>): Promise<Res<'notes.create'>>
    update(request: Req<'notes.update'>): Promise<Res<'notes.update'>>
    remove(request: Req<'notes.delete'>): Promise<void>
    /** Open or focus the floating Scratchpad; `noteId: null` starts a new note. */
    openWindow(request: Req<'notes.openWindow'>): Promise<Res<'notes.openWindow'>>
    subscribe(listener: (event: Evt<'notes.changed'>) => void): Unsubscribe
    /** Scratchpad window only: main asking it to show a particular note. */
    onSelect(listener: (event: Evt<'notes.select'>) => void): Unsubscribe
  }

  /** Grounded chat over the user's own dictations, notes and meetings. */
  readonly ask: {
    /** Resolves when the answer is finished; the text arrives on `subscribe`. */
    send(request: Req<'ask.send'>): Promise<void>
    cancel(): Promise<void>
    state(): Promise<Res<'ask.state'>>
    /** Switch conversations; `conversationId: null` opens a blank one. */
    open(request: Req<'ask.open'>): Promise<Res<'ask.open'>>
    search(request: Req<'ask.search'>): Promise<Res<'ask.search'>>
    rename(request: Req<'ask.rename'>): Promise<Res<'ask.rename'>>
    remove(request: Req<'ask.deleteConversation'>): Promise<Res<'ask.deleteConversation'>>
    clear(): Promise<Res<'ask.clear'>>
    subscribe(listener: (event: Evt<'ask.event'>) => void): Unsubscribe
  }

  readonly dictionary: {
    list(): Promise<Res<'dictionary.list'>>
    create(entry: Req<'dictionary.create'>): Promise<Res<'dictionary.create'>>
    update(request: Req<'dictionary.update'>): Promise<Res<'dictionary.update'>>
    remove(request: Req<'dictionary.delete'>): Promise<void>
  }

  readonly snippets: {
    list(): Promise<Res<'snippets.list'>>
    create(snippet: Req<'snippets.create'>): Promise<Res<'snippets.create'>>
    update(request: Req<'snippets.update'>): Promise<Res<'snippets.update'>>
    remove(request: Req<'snippets.delete'>): Promise<void>
  }

  readonly style: {
    get(): Promise<Res<'style.get'>>
    set(patch: Req<'style.set'>): Promise<Res<'style.set'>>
  }

  readonly vibeCoding: {
    /** Whether the frontmost IDE's editor can be read. Never returns the text. */
    probe(): Promise<Res<'coding.probe'>>
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
    /** Re-open the capture stream (warm) for Dev tools. */
    warmMic(): Promise<void>
    /** Push synthetic PCM frames into the dictation loop (agent mic sim). */
    injectPcm(request?: Req<'debug.injectPcm'>): Promise<Res<'debug.injectPcm'>>
    /** Push synthetic PCM into a meeting's system-audio track. */
    injectSystemPcm(request?: Req<'debug.injectSystemPcm'>): Promise<Res<'debug.injectSystemPcm'>>
    /** Drive the Hub's update notice without a published release. */
    pushUpdateState(state: Req<'debug.pushUpdateState'>): Promise<void>
    /** Drive the Bar's meter and halo without speaking into a microphone. */
    pushLevel(request: Req<'debug.pushLevel'>): Promise<void>
    /** Machine-readable status for the agent loop. */
    snapshot(): Promise<Res<'debug.snapshot'>>
    /** What macOS actually did with the Bar's window (level, Spaces, bounds). */
    barWindow(): Promise<Res<'debug.barWindow'>>
    /** Paste a fixed phrase via the real injector (Notepad G5). */
    insertText(request?: Req<'debug.insertText'>): Promise<Res<'debug.insertText'>>
  }
}
