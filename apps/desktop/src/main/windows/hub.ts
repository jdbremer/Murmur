import { BrowserWindow, shell } from 'electron'

import { loadRenderer, PRELOAD_PATH } from './renderer'

/** PLAN §2.2 — sidebar + content pane, sized for the reference layout. */
const HUB_WIDTH = 1040
const HUB_HEIGHT = 700
const HUB_MIN_WIDTH = 860
const HUB_MIN_HEIGHT = 560

const isMac = process.platform === 'darwin'

export function createHubWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: HUB_WIDTH,
    height: HUB_HEIGHT,
    minWidth: HUB_MIN_WIDTH,
    minHeight: HUB_MIN_HEIGHT,
    show: false,
    title: 'Murmur',
    backgroundColor: '#111114',
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
  window.once('ready-to-show', () => window.show())

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
