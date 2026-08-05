import { describe, expect, it, vi } from 'vitest'

import {
  createMainIpc,
  createRendererIpc,
  IpcValidationError,
  type IpcMainLike,
  type IpcRendererLike,
  type WebContentsLike,
} from '../src/ipc/typed'
import {
  ALL_IPC_CHANNELS,
  EVENT_CHANNELS,
  INVOKE_CHANNELS,
  MESSAGE_CHANNELS,
  isEventChannel,
  isInvokeChannel,
} from '../src/ipc/contract'
import { applySettingsPatch, createDefaultSettings } from '../src/domain/settings'

type RawListener = (event: unknown, ...args: unknown[]) => void

/**
 * An in-memory stand-in for Electron's IPC so the contract can be exercised
 * end-to-end: renderer → main → renderer, through the real zod boundaries.
 */
function createFakeBus() {
  const invokeHandlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  const mainListeners = new Map<string, Set<RawListener>>()
  const rendererListeners = new Map<string, Set<RawListener>>()
  let destroyed = false

  const ipcMain: IpcMainLike = {
    handle(channel, listener) {
      invokeHandlers.set(channel, listener)
    },
    removeHandler(channel) {
      invokeHandlers.delete(channel)
    },
    on(channel, listener) {
      const set = mainListeners.get(channel) ?? new Set()
      set.add(listener)
      mainListeners.set(channel, set)
      return undefined
    },
    removeAllListeners(channel) {
      mainListeners.delete(channel)
      return undefined
    },
  }

  const ipcRenderer: IpcRendererLike = {
    async invoke(channel, ...args) {
      const handler = invokeHandlers.get(channel)
      if (!handler) throw new Error(`No handler registered for "${channel}"`)
      // Structured clone, like the real bridge, so tests cannot pass by reference.
      return await handler({ senderId: 1 }, ...structuredClone(args))
    },
    send(channel, ...args) {
      const listeners = mainListeners.get(channel)
      if (!listeners) return
      for (const listener of listeners) listener({ senderId: 1 }, ...structuredClone(args))
    },
    on(channel, listener) {
      const set = rendererListeners.get(channel) ?? new Set()
      set.add(listener)
      rendererListeners.set(channel, set)
      return undefined
    },
    removeListener(channel, listener) {
      rendererListeners.get(channel)?.delete(listener)
      return undefined
    },
  }

  const webContents: WebContentsLike = {
    send(channel, ...args) {
      const listeners = rendererListeners.get(channel)
      if (!listeners) return
      for (const listener of [...listeners]) listener({}, ...args)
    },
    isDestroyed() {
      return destroyed
    },
  }

  return { ipcMain, ipcRenderer, webContents, destroy: () => (destroyed = true) }
}

describe('typed IPC — request/response', () => {
  it('round-trips a request through the contract, applying request defaults', async () => {
    const bus = createFakeBus()
    const main = createMainIpc(bus.ipcMain)
    const renderer = createRendererIpc(bus.ipcRenderer)

    const received = vi.fn()
    main.handle('history.query', (query) => {
      received(query)
      return { records: [], total: 0 }
    })

    await expect(renderer.invoke('history.query', {})).resolves.toEqual({ records: [], total: 0 })
    // `search`/`limit`/`offset` defaults must be materialised exactly once.
    expect(received).toHaveBeenCalledWith({ search: '', limit: 50, offset: 0 })
  })

  it('carries a real payload both ways', async () => {
    const bus = createFakeBus()
    const main = createMainIpc(bus.ipcMain)
    const renderer = createRendererIpc(bus.ipcRenderer)

    let stored = createDefaultSettings()
    main.handle('settings.set', (patch) => {
      stored = applySettingsPatch(stored, patch)
      return stored
    })

    const result = await renderer.invoke('settings.set', { polishingLevel: 'rewrite' })
    expect(result.polishingLevel).toBe('rewrite')
    expect(result.language).toBe('en')
  })

  it('supports channels whose request is void', async () => {
    const bus = createFakeBus()
    createMainIpc(bus.ipcMain).handle('app.version', () => '0.1.0')
    await expect(createRendererIpc(bus.ipcRenderer).invoke('app.version')).resolves.toBe('0.1.0')
  })

  it('rejects a bad request on the caller side before it leaves the renderer', async () => {
    const bus = createFakeBus()
    const handler = vi.fn(() => createDefaultSettings())
    createMainIpc(bus.ipcMain).handle('settings.set', handler)
    const renderer = createRendererIpc(bus.ipcRenderer)

    await expect(
      renderer.invoke('settings.set', { polishingLevel: 'sparkle' } as never),
    ).rejects.toBeInstanceOf(IpcValidationError)
    expect(handler).not.toHaveBeenCalled()
  })

  it('rejects a bad request on the main side even when the caller skipped validation', async () => {
    const bus = createFakeBus()
    const handler = vi.fn(() => createDefaultSettings())
    createMainIpc(bus.ipcMain).handle('settings.set', handler)

    // A compromised or hand-rolled renderer talking to the raw channel.
    await expect(
      bus.ipcRenderer.invoke('settings.set', { barVisibility: 'everywhere' }),
    ).rejects.toBeInstanceOf(IpcValidationError)
    expect(handler).not.toHaveBeenCalled()
  })

  it('reports which field failed', async () => {
    const bus = createFakeBus()
    createMainIpc(bus.ipcMain).handle('settings.set', () => createDefaultSettings())

    const error = await bus.ipcRenderer
      .invoke('settings.set', { historyRetention: { mode: 'days', days: -1 } })
      .catch((e: unknown) => e as IpcValidationError)

    expect(error).toBeInstanceOf(IpcValidationError)
    expect((error as IpcValidationError).channel).toBe('settings.set')
    expect((error as IpcValidationError).direction).toBe('request')
    expect((error as IpcValidationError).issues.join(' ')).toContain('historyRetention')
  })

  it('catches a handler that returns the wrong shape (dev validation)', async () => {
    const bus = createFakeBus()
    // @ts-expect-error — deliberately wrong return type; the runtime must catch it too.
    createMainIpc(bus.ipcMain, { validate: true }).handle('history.stats', () => ({ words: 10 }))

    await expect(createRendererIpc(bus.ipcRenderer).invoke('history.stats')).rejects.toBeInstanceOf(
      IpcValidationError,
    )
  })

  it('throws on an undeclared channel instead of silently registering it', () => {
    const bus = createFakeBus()
    const main = createMainIpc(bus.ipcMain)
    expect(() => main.handle('settings.explode' as never, () => undefined as never)).toThrow(
      /Unknown invoke IPC channel/,
    )
  })
})

describe('typed IPC — events (main → renderer)', () => {
  it('delivers parsed payloads and applies event defaults', () => {
    const bus = createFakeBus()
    const main = createMainIpc(bus.ipcMain)
    const renderer = createRendererIpc(bus.ipcRenderer)

    const seen: unknown[] = []
    const off = renderer.on('dictation.state', (event) => seen.push(event))

    main.emit(bus.webContents, 'dictation.state', { state: 'listening' })
    main.emit(bus.webContents, 'dictation.state', {
      state: 'inserted',
      charCount: 12,
      method: 'paste',
    })

    expect(seen).toEqual([
      { state: 'listening', handsFree: false, level: 0, command: false },
      { state: 'inserted', charCount: 12, method: 'paste' },
    ])

    off()
    main.emit(bus.webContents, 'dictation.state', { state: 'idle' })
    expect(seen).toHaveLength(2)
  })

  it('refuses to emit an invalid event', () => {
    const bus = createFakeBus()
    const main = createMainIpc(bus.ipcMain, { validate: true })
    expect(() => main.emit(bus.webContents, 'audio.level', { level: 42 } as never)).toThrow(
      IpcValidationError,
    )
    expect(() =>
      main.emit(bus.webContents, 'dictation.state', { state: 'daydreaming' } as never),
    ).toThrow(IpcValidationError)
  })

  it('skips destroyed web contents instead of throwing', () => {
    const bus = createFakeBus()
    const main = createMainIpc(bus.ipcMain)
    const renderer = createRendererIpc(bus.ipcRenderer)
    const listener = vi.fn()
    renderer.on('dictation.state', listener)

    bus.destroy()
    expect(() => main.emit(bus.webContents, 'dictation.state', { state: 'idle' })).not.toThrow()
    expect(() =>
      main.broadcast([bus.webContents, null, undefined], 'dictation.state', { state: 'idle' }),
    ).not.toThrow()
    expect(listener).not.toHaveBeenCalled()
  })

  it('broadcast fans out to every live target', () => {
    const bus = createFakeBus()
    const main = createMainIpc(bus.ipcMain)
    const renderer = createRendererIpc(bus.ipcRenderer)
    const listener = vi.fn()
    renderer.on('audio.level', listener)

    main.broadcast([bus.webContents, bus.webContents], 'audio.level', { level: 0.5 })
    expect(listener).toHaveBeenCalledTimes(2)
    expect(listener).toHaveBeenLastCalledWith({ level: 0.5, peak: null })
  })
})

describe('typed IPC — messages (renderer → main)', () => {
  it('carries PCM frames and applies the sample-rate default', () => {
    const bus = createFakeBus()
    const main = createMainIpc(bus.ipcMain)
    const renderer = createRendererIpc(bus.ipcRenderer)

    const frames: { sampleCount: number; sampleRate: number; byteLength: number }[] = []
    main.receive('audio.frame', (frame) => {
      frames.push({
        sampleCount: frame.sampleCount,
        sampleRate: frame.sampleRate,
        byteLength: frame.pcm.byteLength,
      })
    })

    const pcm = new Float32Array([0.1, -0.2, 0.3, -0.4])
    renderer.send('audio.frame', { pcm: pcm.buffer, sampleCount: 4, ts: 1_700_000_000_000 })

    expect(frames).toEqual([{ sampleCount: 4, sampleRate: 16_000, byteLength: 16 }])
  })

  it('rejects a malformed frame at the sender', () => {
    const bus = createFakeBus()
    const main = createMainIpc(bus.ipcMain)
    const renderer = createRendererIpc(bus.ipcRenderer)
    const handler = vi.fn()
    main.receive('audio.frame', handler)

    expect(() =>
      renderer.send('audio.frame', { pcm: 'definitely not audio', sampleCount: 4, ts: 0 } as never),
    ).toThrow(IpcValidationError)
    expect(handler).not.toHaveBeenCalled()
  })

  it('rejects a malformed frame at the receiver too', () => {
    const bus = createFakeBus()
    const main = createMainIpc(bus.ipcMain)
    const handler = vi.fn()
    main.receive('audio.frame', handler)

    expect(() =>
      bus.ipcRenderer.send('audio.frame', { pcm: new ArrayBuffer(8), sampleCount: 0, ts: 0 }),
    ).toThrow(IpcValidationError)
    expect(handler).not.toHaveBeenCalled()
  })

  it('accepts status reports from the capture renderer', () => {
    const bus = createFakeBus()
    const main = createMainIpc(bus.ipcMain)
    const renderer = createRendererIpc(bus.ipcRenderer)
    const handler = vi.fn()
    main.receive('audio.status', handler)

    renderer.send('audio.status', { status: 'ready', deviceId: null, sampleRate: 48_000 })
    expect(handler).toHaveBeenCalledWith(
      { status: 'ready', deviceId: null, sampleRate: 48_000 },
      expect.anything(),
    )
  })
})

describe('contract hygiene', () => {
  it('declares the channels the app depends on', () => {
    for (const channel of [
      'app.version',
      'settings.get',
      'settings.set',
      'dictation.cancel',
      'dictation.startHandsFree',
      'dictation.stopHandsFree',
      'models.list',
      'history.query',
      'history.stats',
      'dictionary.list',
      'style.get',
      'permissions.status',
    ]) {
      expect(isInvokeChannel(channel)).toBe(true)
    }
    expect(isEventChannel('dictation.state')).toBe(true)
    expect(isEventChannel('audio.level')).toBe(true)
  })

  it('uses each channel name exactly once across the three maps', () => {
    const all = [...INVOKE_CHANNELS, ...EVENT_CHANNELS, ...MESSAGE_CHANNELS]
    expect(new Set(all).size).toBe(all.length)
    expect(ALL_IPC_CHANNELS).toHaveLength(all.length)
  })

  it('namespaces every channel as "group.action"', () => {
    for (const channel of ALL_IPC_CHANNELS) {
      expect(channel).toMatch(/^[a-z]+\.[a-zA-Z]+$/)
    }
  })
})
