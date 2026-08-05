import { BrowserWindow, screen, type Rectangle } from 'electron'

import { loadRenderer, PRELOAD_PATH } from './renderer'

/**
 * The floating dictation pill (PLAN §2.1).
 *
 * One frameless transparent window, sized to the *largest* state the pill can
 * reach; the renderer draws the capsule inside it and animates between states,
 * so the window itself never resizes and never reflows.
 *
 * Every macOS-specific call below is guarded, because Linux is a supported
 * *development* platform even though the product is macOS-only. The guards keep
 * `npm run dev` bootable there; they are not a portability claim.
 */

export const BAR_WIDTH = 360
export const BAR_HEIGHT = 64
/** Gap between the pill and the bottom edge of the display (PLAN §2.1). */
export const BAR_MARGIN_BOTTOM = 10

const isMac = process.platform === 'darwin'

/**
 * Bottom-centre of the primary display, measured against `bounds` rather than
 * `workArea`: the pill floats *above* the Dock, it does not dodge it.
 *
 * Stage 2 follows the display containing the focused window, and honours the
 * optional pin-to-one-display setting.
 */
export function barBounds(): Rectangle {
  const { bounds } = screen.getPrimaryDisplay()
  return {
    x: Math.round(bounds.x + (bounds.width - BAR_WIDTH) / 2),
    y: Math.round(bounds.y + bounds.height - BAR_HEIGHT - BAR_MARGIN_BOTTOM),
    width: BAR_WIDTH,
    height: BAR_HEIGHT,
  }
}

export function createBarWindow(): BrowserWindow {
  const window = new BrowserWindow({
    ...barBounds(),
    show: false, // visibility follows the settings' barVisibility mode
    frame: false,
    transparent: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    // Never steal focus from the app being dictated into (PLAN §2.1).
    focusable: false,
    acceptFirstMouse: true,
    alwaysOnTop: true,
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // The waveform runs at 60 fps; do not let it be throttled when the Bar is
      // occluded by the app the user is dictating into.
      backgroundThrottling: false,
    },
  })

  // Above the Dock and above full-screen apps.
  window.setAlwaysOnTop(true, 'screen-saver')

  if (isMac) {
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    // A non-activating panel: clicking the pill must not raise Murmur.
    window.setWindowButtonVisibility(false)
  }

  void loadRenderer(window, 'bar')
  return window
}

/** Re-centre after a display change (resolution, arrangement, hot-plug). */
export function repositionBar(window: BrowserWindow): void {
  if (window.isDestroyed()) return
  window.setBounds(barBounds())
}
