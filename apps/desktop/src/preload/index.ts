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

  audio: {
    sendFrame: (frame) => ipc.send('audio.frame', frame),
    reportStatus: (status) => ipc.send('audio.status', status),
    reportLevel: (level) => ipc.send('audio.meter', level),
    reportDevices: (devices) => ipc.send('audio.devices', devices),
    onCommand: (listener) => ipc.on('audio.command', listener),
    onCaptureStatus: (listener) => ipc.on('audio.captureStatus', listener),
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
  },

  dictionary: {
    list: () => ipc.invoke('dictionary.list'),
    create: (entry) => ipc.invoke('dictionary.create', entry),
    update: (request) => ipc.invoke('dictionary.update', request),
    remove: (request) => ipc.invoke('dictionary.delete', request),
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
    snapshot: () => ipc.invoke('debug.snapshot'),
    insertText: (request) => ipc.invoke('debug.insertText', request ?? {}),
  },
}

contextBridge.exposeInMainWorld('murmur', api)
