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
/**
 * Taller than the capsule on purpose. The pill sits flush with the bottom of
 * the page; the empty space above it is where the hover controls' mic picker
 * opens, so the window never has to resize mid-interaction (which on macOS
 * would fight the ~150 ms morph the pill is already animating). Everything
 * above the pill is transparent *and* click-through, so it costs the user
 * nothing.
 */
export const BAR_HEIGHT = 200
/** Gap between the pill and the bottom edge of the display (PLAN §2.1). */
export const BAR_MARGIN_BOTTOM = 10

const isMac = process.platform === 'darwin'

/**
 * Bottom-centre of the display under the cursor, measured against `bounds`
 * rather than `workArea`: the pill floats *above* the Dock, it does not dodge
 * it.
 *
 * Cursor rather than primary because a pill on the primary display is simply
 * not visible to someone working on their second monitor. On a single-display
 * machine the two are the same display, so this is a no-op there — the change
 * is only observable with more than one monitor attached.
 *
 * The cursor is a proxy for "where the user is", and an imperfect one: a
 * cursor parked on another screen puts the pill there. Following the focused
 * *window* would be exact, but the focused window belongs to another
 * application and Electron cannot see its bounds — that needs a native call
 * this build does not have yet.
 */
export function barBounds(): Rectangle {
  const point = screen.getCursorScreenPoint()
  const { bounds } = screen.getDisplayNearestPoint(point)
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

  // Click-through by default: the window covers a strip of the screen the user
  // is dictating into, and none of it may swallow a click. `forward: true` keeps
  // mouse *moves* flowing to the renderer, which flips this back off while the
  // pointer is over the capsule (`bar.pointerRegion`, PLAN §2.1).
  window.setIgnoreMouseEvents(true, { forward: true })

  // Windows: `screen-saver` level is unreliable for frameless transparent
  // windows; `pop-up-menu` keeps the pill above ordinary apps. macOS keeps the
  // stronger full-screen level.
  if (isMac) {
    window.setAlwaysOnTop(true, 'screen-saver')
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    // A non-activating panel: clicking the pill must not raise Murmur.
    window.setWindowButtonVisibility(false)
  } else {
    window.setAlwaysOnTop(true, 'pop-up-menu')
  }

  void loadRenderer(window, 'bar')
  return window
}

/**
 * Let the pill receive clicks, or go back to being transparent to the mouse.
 *
 * Driven entirely by the renderer's hit-testing, because only the renderer
 * knows where the capsule currently is — it moves as the pill morphs between
 * states and as the hover controls appear.
 */
export function setBarInteractive(window: BrowserWindow, interactive: boolean): void {
  if (window.isDestroyed()) return
  window.setIgnoreMouseEvents(!interactive, { forward: true })
}

/** Re-centre after a display change (resolution, arrangement, hot-plug). */
export function repositionBar(window: BrowserWindow): void {
  if (window.isDestroyed()) return
  window.setBounds(barBounds())
}
