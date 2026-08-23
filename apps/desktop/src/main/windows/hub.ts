import { join } from 'node:path'

import { app, BrowserWindow, nativeTheme, screen, shell } from 'electron'

import { loadRenderer, PRELOAD_PATH } from './renderer'
import { readWindowState, restoreBounds, writeWindowState } from './window-state'

/** PLAN §2.2 — sidebar + content pane, sized for the reference layout. */
const HUB_WIDTH = 1040
const HUB_HEIGHT = 700
const HUB_MIN_WIDTH = 860
const HUB_MIN_HEIGHT = 560

/** Long enough that a drag is one write, short enough to survive a hard quit. */
const SAVE_DEBOUNCE_MS = 400

/**
 * `--color-canvas` from theme.css, in both themes.
 *
 * This is the colour Chromium paints for the window itself — before the
 * renderer's first paint, and in the gaps during a live resize, where the web
 * contents lag the frame. It used to be hard-coded near-black, which meant a
 * light-theme user got dark bands down the edges of every resize. Duplicated
 * from the stylesheet because the main process cannot read CSS variables; the
 * pair is small, and getting them out of step is a cosmetic bug at worst.
 */
const CANVAS = { light: '#f7f4ef', dark: '#0d0d10' } as const

const isMac = process.platform === 'darwin'

/**
 * Follows `nativeTheme`, which the composition root points at the user's
 * Appearance setting — so this honours an explicit light/dark choice, not just
 * the OS preference.
 */
function canvasColour(): string {
  return nativeTheme.shouldUseDarkColors ? CANVAS.dark : CANVAS.light
}

/** Beside the settings file, not inside it: geometry is not a preference. */
function statePath(): string {
  return join(app.getPath('userData'), 'window-state.json')
}

export function createHubWindow(): BrowserWindow {
  const path = statePath()
  const restored = restoreBounds(readWindowState(path), screen.getAllDisplays(), {
    minWidth: HUB_MIN_WIDTH,
    minHeight: HUB_MIN_HEIGHT,
    defaultWidth: HUB_WIDTH,
    defaultHeight: HUB_HEIGHT,
  })

  const window = new BrowserWindow({
    ...restored.bounds,
    minWidth: HUB_MIN_WIDTH,
    minHeight: HUB_MIN_HEIGHT,
    show: false,
    title: 'Murmur',
    backgroundColor: canvasColour(),
    // The inset traffic lights are the reference look; other platforms get a
    // normal title bar so the window is still usable in dev.
    ...(isMac
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 16, y: 18 } }
      : {}),
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  // Avoid the white flash before React paints.
  window.once('ready-to-show', () => {
    if (restored.maximized) window.maximize()
    window.show()
  })

  /**
   * Save on a debounce rather than on every resize event.
   *
   * A live drag fires `resize` continuously; writing the file each time would
   * be hundreds of disk writes for one gesture. Normal bounds only — a
   * maximized window reports the screen as its size, and saving that would
   * mean un-maximizing gave you a full-screen-sized window instead of the one
   * you had before.
   */
  let saveTimer: NodeJS.Timeout | undefined
  const save = (): void => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      if (window.isDestroyed()) return
      const bounds = window.getNormalBounds()
      writeWindowState(path, { ...bounds, maximized: window.isMaximized() })
    }, SAVE_DEBOUNCE_MS)
    saveTimer.unref?.()
  }

  window.on('resize', save)
  window.on('move', save)
  window.on('maximize', save)
  window.on('unmaximize', save)
  // The debounce would otherwise be cancelled by the process exiting first.
  window.on('close', () => {
    if (saveTimer) clearTimeout(saveTimer)
    if (window.isDestroyed()) return
    const bounds = window.getNormalBounds()
    writeWindowState(path, { ...bounds, maximized: window.isMaximized() })
  })

  // Keep it in step with a theme change (the OS preference flipping, or the
  // user picking a different Appearance), for as long as this window lives.
  const onThemeChange = (): void => {
    if (!window.isDestroyed()) window.setBackgroundColor(canvasColour())
  }
  nativeTheme.on('updated', onThemeChange)
  window.on('closed', () => nativeTheme.off('updated', onThemeChange))

  // Nothing in the Hub should ever navigate the window itself; external links
  // belong in the user's browser (and there are very few of them by design).
  //
  // The scheme check is not ceremony: `shell.openExternal` hands the string to
  // the OS, which will happily act on `file://`, `smb://` or a custom scheme
  // registered by some other app. Only http(s) is ever a legitimate Hub link,
  // so anything else is a bug or an injection and is refused loudly.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) {
      void shell.openExternal(url)
    } else {
      console.warn(`[security] refused to open external URL: ${url}`)
    }
    return { action: 'deny' }
  })

  void loadRenderer(window, 'hub')
  return window
}

/** `http(s)` only — see the call site. Exported for tests. */
export function isSafeExternalUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url)
    return protocol === 'https:' || protocol === 'http:'
  } catch {
    return false
  }
}
