import { BrowserWindow, screen, type Rectangle } from 'electron'

import { barWindowBounds, DEFAULT_BAR_LAYOUT, type BarLayout } from './bar-layout'
import { loadRenderer, PRELOAD_PATH } from './renderer'

/**
 * The floating dictation indicator (PLAN §2.1).
 *
 * One frameless transparent window, sized to the *largest* state the indicator
 * can reach; the renderer draws the capsule (or the corner orb) inside it and
 * animates between states, so the window itself never resizes and never
 * reflows. Switching styles is the one exception — that moves and resizes it,
 * because the two shapes live in different corners of the screen.
 *
 * Every macOS-specific call below is guarded, because Linux is a supported
 * *development* platform even though the product is macOS-only. The guards keep
 * `npm run dev` bootable there; they are not a portability claim.
 */

export {
  BAR_HEIGHT,
  BAR_MARGIN_BOTTOM,
  BAR_WIDTH,
  NUB_HEIGHT,
  NUB_WIDTH,
  type BarLayout,
} from './bar-layout'

const isMac = process.platform === 'darwin'

/**
 * Where the window goes on the display under the cursor.
 *
 * Cursor rather than primary because an indicator on the primary display is
 * simply not visible to someone working on their second monitor. On a
 * single-display machine the two are the same display, so this is a no-op there
 * — the change is only observable with more than one monitor attached.
 *
 * The cursor is a proxy for "where the user is", and an imperfect one: a cursor
 * parked on another screen puts the indicator there. Following the focused
 * *window* would be exact, but the focused window belongs to another
 * application and Electron cannot see its bounds — that needs a native call
 * this build does not have yet.
 */
export function barBounds(layout: BarLayout = DEFAULT_BAR_LAYOUT): Rectangle {
  const point = screen.getCursorScreenPoint()
  const { bounds, workArea } = screen.getDisplayNearestPoint(point)
  return barWindowBounds({ bounds, workArea }, layout)
}

export function createBarWindow(layout: BarLayout = DEFAULT_BAR_LAYOUT): BrowserWindow {
  const window = new BrowserWindow({
    ...barBounds(layout),
    show: false, // visibility follows the settings' barVisibility mode
    frame: false,
    transparent: true,
    hasShadow: false,
    // NOTE: `roundedCorners: false` looks like the answer to macOS clipping the
    // orb's point, and it is not. It swaps the window's style mask for
    // NSWindowStyleMaskBorderless — Electron's own docs note the window stops
    // being fullscreenable — and this window's entire job is to float across
    // every Space and over full-screen apps. Turning it off cost exactly that:
    // the orb vanished when switching desktops. The rounding is dodged by
    // geometry instead, in bar-layout.ts — the window hangs past the screen
    // edge so its rounded corners are off-panel.
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    // Never steal focus from the app being dictated into (PLAN §2.1).
    focusable: false,
    /**
     * macOS: an `NSPanel`, not an `NSWindow`.
     *
     * This is the piece that actually lets the indicator appear over another
     * app's full-screen Space. The `FullScreenAuxiliary` collection bit and a
     * floating window level are both necessary and neither is sufficient — an
     * ordinary NSWindow is simply never composited into a full-screen Space,
     * however its behaviour is set, which is why every combination of those two
     * looked correct from inside the process (`isVisibleOnAllWorkspaces()`
     * cheerfully reports true) while the pill was nowhere on screen.
     *
     * A panel also suits what this window already is: non-activating chrome
     * that must never become key. Guarded because `panel` is macOS-only.
     */
    ...(isMac ? { type: 'panel' } : {}),
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

  if (isMac) {
    keepBarEverywhere(window)
    // A non-activating panel: clicking the pill must not raise Murmur.
    window.setWindowButtonVisibility(false)
  } else {
    // Windows: `screen-saver` level is unreliable for frameless transparent
    // windows; `pop-up-menu` keeps the pill above ordinary apps.
    window.setAlwaysOnTop(true, 'pop-up-menu')
  }

  void loadRenderer(window, 'bar')
  return window
}

/**
 * What makes this window follow the user everywhere: it floats above the app
 * being dictated into, and it appears on every Space — including the Space a
 * full-screen app owns.
 *
 * Three details, and every one of them was learned the hard way:
 *
 *  1. **`floating`, not `screen-saver`.** The stronger level looks like the
 *     safer choice and is the wrong one: `NSFloatingWindowLevel` is what macOS
 *     expects of an auxiliary window over a full-screen Space, and at
 *     `screen-saver` the pill simply is not composited there. The cost is that
 *     another app's always-on-top window can now cover it, which is a fair
 *     trade for existing at all.
 *  2. **`skipTransformProcessType`.** Without it, Electron buys the
 *     full-screen float by transforming the whole process into a UIElement
 *     app — which fights `app.dock.show()` when the Hub opens, and lost. It is
 *     also unnecessary: what actually earns the behaviour is the
 *     `FullScreenAuxiliary` collection bit, which a regular application gets
 *     just as well. (OpenWhispr ships `LSUIElement: false` — a Dock icon,
 *     always — and its overlay floats over full-screen apps regardless.)
 *  3. **`setFullScreenable(false)` last.** `setAlwaysOnTop` re-runs Electron's
 *     own fullscreenable handling, which rewrites the `FullScreenPrimary` /
 *     `FullScreenAuxiliary` bits underneath. Setting it afterwards is what
 *     leaves `FullScreenAuxiliary` actually on.
 *
 * Safe to re-run now that the process transform is skipped, and it needs to
 * be: `app.dock.show()` / `hide()` transform the process, and a transform
 * resets the window levels of every window the process owns.
 */
export function keepBarEverywhere(window: BrowserWindow): void {
  if (!isMac || window.isDestroyed()) return
  window.setAlwaysOnTop(true, 'floating', 1)
  window.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    skipTransformProcessType: true,
  })
  window.setFullScreenable(false)
}

/**
 * Let the indicator receive clicks, or go back to being transparent to the
 * mouse.
 *
 * Driven entirely by the renderer's hit-testing, because only the renderer
 * knows where the capsule currently is — it moves as the pill morphs between
 * states and as the hover controls appear.
 */
export function setBarInteractive(window: BrowserWindow, interactive: boolean): void {
  if (window.isDestroyed()) return
  window.setIgnoreMouseEvents(!interactive, { forward: true })
}

/**
 * Re-anchor after a display change (resolution, arrangement, hot-plug) or a
 * change of style/corner. Returns the rectangle it asked for, which is not
 * always the one it gets — see {@link anchorBar}.
 */
export function repositionBar(
  window: BrowserWindow,
  layout: BarLayout = DEFAULT_BAR_LAYOUT,
): Rectangle | null {
  if (window.isDestroyed()) return null
  const bounds = barBounds(layout)
  window.setBounds(bounds)
  return bounds
}

/**
 * Put the window back where it was asked to be, if the OS moved it.
 *
 * macOS constrains a window's frame to the screen's *visible* area as it is
 * ordered in — the area above the Dock and below the menu bar — however the
 * bounds were set beforehand. For the pill that is invisible, because it
 * measures against `workArea` and already sits inside that box. For the corner
 * orb it is the whole feature: asked for the physical corner, it appeared a
 * Dock's height up the screen, floating instead of peeking. Setting the bounds
 * again *after* the window is on screen is not constrained, so this is where it
 * lands for good.
 *
 * Compared before writing so the ordinary case costs one `getBounds` and no
 * move at all.
 */
export function anchorBar(window: BrowserWindow, wanted: Rectangle | null): void {
  if (!wanted || window.isDestroyed()) return
  const actual = window.getBounds()
  if (actual.x === wanted.x && actual.y === wanted.y) return
  window.setBounds(wanted)
}
