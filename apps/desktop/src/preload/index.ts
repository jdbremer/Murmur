import { contextBridge, ipcRenderer } from 'electron'

import { createRendererIpc, type MurmurApi } from '@murmur/shared'

/**
 * The only bridge between renderers and the main process.
 *
 * `contextIsolation` is on and `nodeIntegration` is off in every window, so a
 * renderer can reach exactly what is listed here and nothing else — no
 * `ipcRenderer`, no arbitrary channel names, no Node. Payloads are zod-checked
 * on the way through in both directions (see `@murmur/shared/ipc/typed.ts`).
 *
 * `window.murmur` is typed by `MurmurApi`, which is derived from the IPC
 * contract, so adding a channel and forgetting to expose it here is a type
 * error rather than a runtime surprise.
 */

const ipc = createRendererIpc(ipcRenderer)

const api: MurmurApi = {
  app: {
    version: () => ipc.invoke('app.version'),
    info: () => ipc.invoke('app.info'),
    checkForUpdate: () => ipc.invoke('app.checkForUpdate'),
    updateState: () => ipc.invoke('app.updateState'),
    downloadUpdate: () => ipc.invoke('app.downloadUpdate'),
    installUpdate: () => ipc.invoke('app.installUpdate'),
    onUpdateChanged: (listener) => ipc.on('app.updateChanged', listener),
    openReleasePage: (request) => ipc.invoke('app.openReleasePage', request),
    relaunch: () => ipc.invoke('app.relaunch'),
    devMode: () => ipc.invoke('app.devMode'),
    quit: () => ipc.invoke('app.quit'),
    openHub: () => ipc.invoke('app.openHub'),
  },

  settings: {
    get: () => ipc.invoke('settings.get'),
    set: (patch) => ipc.invoke('settings.set', patch),
    subscribe: (listener) => ipc.on('settings.changed', listener),
  },

  dictation: {
    getState: () => ipc.invoke('dictation.getState'),
    subscribe: (listener) => ipc.on('dictation.state', listener),
    onLevel: (listener) => ipc.on('audio.level', listener),
    cancel: () => ipc.invoke('dictation.cancel'),
    startHandsFree: () => ipc.invoke('dictation.startHandsFree'),
    stopHandsFree: () => ipc.invoke('dictation.stopHandsFree'),
  },

  meetings: {
    start: (request) => ipc.invoke('meeting.start', request),
    stop: () => ipc.invoke('meeting.stop'),
    getState: () => ipc.invoke('meeting.state'),
    subscribe: (listener) => ipc.on('meeting.changed', listener),
    respondToOffer: (response) => ipc.invoke('meeting.respondToOffer', response),
    list: () => ipc.invoke('meeting.list'),
    delete: (request) => ipc.invoke('meeting.delete', request),
    reveal: (request) => ipc.invoke('meeting.reveal', request),
    openFolder: () => ipc.invoke('meeting.openFolder'),
    systemAudioAccess: () => ipc.invoke('meeting.systemAudioAccess'),
    requestSystemAudio: () => ipc.invoke('meeting.requestSystemAudio'),
  },

  audio: {
    sendFrame: (frame) => ipc.send('audio.frame', frame),
    sendSystemFrame: (frame) => ipc.send('audio.systemFrame', frame),
    reportStatus: (status) => ipc.send('audio.status', status),
    reportLevel: (level) => ipc.send('audio.meter', level),
    reportDevices: (devices) => ipc.send('audio.devices', devices),
    onCommand: (listener) => ipc.on('audio.command', listener),
    listDevices: () => ipc.invoke('audio.listDevices'),
    onDevicesChanged: (listener) => ipc.on('audio.devicesChanged', listener),
    captureStatus: () => ipc.invoke('audio.captureStatus'),
    onCaptureChanged: (listener) => ipc.on('audio.captureChanged', listener),
  },

  bar: {
    setPointerRegion: (region) => ipc.send('bar.pointerRegion', region),
  },

  models: {
    list: () => ipc.invoke('models.list'),
    downloadStart: (request) => ipc.invoke('models.downloadStart', request),
    downloadCancel: (request) => ipc.invoke('models.downloadCancel', request),
    onDownloadProgress: (listener) => ipc.on('models.downloadProgress', listener),
    select: (request) => ipc.invoke('models.select', request),
    remove: (request) => ipc.invoke('models.delete', request),
    import: (request) => ipc.invoke('models.import', request),
    chooseFile: () => ipc.invoke('models.chooseFile'),
  },

  history: {
    query: (request) => ipc.invoke('history.query', request),
    remove: (request) => ipc.invoke('history.delete', request),
    clear: () => ipc.invoke('history.clear'),
    stats: () => ipc.invoke('history.stats'),
    subscribe: (listener) => ipc.on('history.changed', listener),
  },

  dictionary: {
    list: () => ipc.invoke('dictionary.list'),
    create: (entry) => ipc.invoke('dictionary.create', entry),
    update: (request) => ipc.invoke('dictionary.update', request),
    remove: (request) => ipc.invoke('dictionary.delete', request),
  },

  snippets: {
    list: () => ipc.invoke('snippets.list'),
    create: (snippet) => ipc.invoke('snippets.create', snippet),
    update: (request) => ipc.invoke('snippets.update', request),
    remove: (request) => ipc.invoke('snippets.delete', request),
  },

  style: {
    get: () => ipc.invoke('style.get'),
    set: (patch) => ipc.invoke('style.set', patch),
  },

  permissions: {
    status: () => ipc.invoke('permissions.status'),
    request: (request) => ipc.invoke('permissions.request', request),
    openSystemSettings: (request) => ipc.invoke('permissions.openSystemSettings', request),
  },

  engines: {
    status: () => ipc.invoke('engines.status'),
    subscribe: (listener) => ipc.on('engines.changed', listener),
    installSidecar: (request) => ipc.invoke('engines.installSidecar', request),
  },

  debug: {
    simulateDictation: () => ipc.invoke('debug.simulateDictation'),
    simulateHotkey: (request) => ipc.invoke('debug.simulateHotkey', request),
    warmMic: () => ipc.invoke('debug.warmMic'),
    injectPcm: (request) => ipc.invoke('debug.injectPcm', request ?? {}),
    injectSystemPcm: (request) => ipc.invoke('debug.injectSystemPcm', request ?? {}),
    snapshot: () => ipc.invoke('debug.snapshot'),
    insertText: (request) => ipc.invoke('debug.insertText', request ?? {}),
  },
}

contextBridge.exposeInMainWorld('murmur', api)
