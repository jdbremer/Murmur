import { BrowserWindow, nativeTheme, screen } from 'electron'

import { loadRenderer, PRELOAD_PATH } from './renderer'

/**
 * The Scratchpad (PLAN §2.2.7) — a small floating note window.
 *
 * Opened from the Bar's hover cluster, which is the whole point: a thought
 * needs somewhere to go *before* you have decided which app it belongs in, and
 * the Hub is too heavy a thing to bring forward for one line.
 *
 * Deliberately an ordinary, focusable window — unlike the Bar. That is what
 * makes dictating into it work with no new pipeline code at all: it becomes the
 * frontmost app, and the existing clipboard-paste injector fills its textarea
 * exactly as it would any other editor.
 *
 * It is not always-on-top either. A note window that floats over everything is
 * a note window you close, and then the feature is gone.
 */

const NOTES_WIDTH = 440
const NOTES_HEIGHT = 560
const NOTES_MIN_WIDTH = 320
const NOTES_MIN_HEIGHT = 280

/** `--color-canvas` from theme.css — see the same constant in `hub.ts`. */
const CANVAS = { light: '#f7f4ef', dark: '#0d0d10' } as const

const isMac = process.platform === 'darwin'

function canvasColour(): string {
  return nativeTheme.shouldUseDarkColors ? CANVAS.dark : CANVAS.light
}

/**
 * Upper-right of the display under the cursor, inset from the corner.
 *
 * Not centred: the middle of the screen is where the user is working, and this
 * window is a companion to that work rather than a replacement for it. The
 * cursor's display for the same reason the Bar uses it — a note window on the
 * primary monitor is no use to someone on their second one.
 */
function notesBounds(): Electron.Rectangle {
  const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const margin = 24
  return {
    x: Math.round(workArea.x + workArea.width - NOTES_WIDTH - margin),
    y: Math.round(workArea.y + margin),
    width: NOTES_WIDTH,
    height: Math.min(NOTES_HEIGHT, workArea.height - margin * 2),
  }
}

export function createNotesWindow(): BrowserWindow {
  const window = new BrowserWindow({
    ...notesBounds(),
    minWidth: NOTES_MIN_WIDTH,
    minHeight: NOTES_MIN_HEIGHT,
    show: false,
    title: 'Scratchpad',
    backgroundColor: canvasColour(),
    ...(isMac
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 12, y: 14 } }
      : {}),
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  window.once('ready-to-show', () => window.show())

  const onThemeChange = (): void => {
    if (!window.isDestroyed()) window.setBackgroundColor(canvasColour())
  }
  nativeTheme.on('updated', onThemeChange)
  window.on('closed', () => nativeTheme.off('updated', onThemeChange))

  // Nothing in the Scratchpad navigates, and nothing in it should be able to.
  // A note's body is arbitrary user text that may well contain a URL, and a
  // stray middle-click must not turn this window into a browser.
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  void loadRenderer(window, 'notes')
  return window
}
