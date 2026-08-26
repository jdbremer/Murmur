import { app, type BrowserWindow, screen, type WebContents } from 'electron'

import { createAudioWindow } from './audio'
import { anchorBar, createBarWindow, keepBarEverywhere, repositionBar } from './bar'
import { DEFAULT_BAR_LAYOUT, type BarLayout } from './bar-layout'
import { createHubWindow } from './hub'
import { createNotesWindow } from './notes'

/**
 * Owns the four windows and hands out their web contents.
 *
 * Windows are created lazily except the Bar and the capture renderer, which the
 * dictation loop needs to already exist by the time a hotkey arrives.
 */
export class WindowManager {
  #hub: BrowserWindow | null = null
  #bar: BrowserWindow | null = null
  #audio: BrowserWindow | null = null
  #notes: BrowserWindow | null = null
  /**
   * Where the Bar window belongs, read fresh every time it is placed.
   *
   * A function rather than a value because the manager is constructed before
   * the settings store exists, and because the answer changes underneath it —
   * the user can switch style or corner at any moment.
   */
  #barLayout: () => BarLayout = () => DEFAULT_BAR_LAYOUT

  /** Create the always-on windows. Call once, after `app.whenReady()`. */
  start(barLayout?: () => BarLayout): void {
    if (barLayout) this.#barLayout = barLayout
    this.bar()
    this.audio()

    // Keep the indicator anchored when displays change (PLAN §2.1 "follows the
    // active display" — Stage 2 extends this to the focused display).
    screen.on('display-metrics-changed', () => this.refreshBarBounds())
    screen.on('display-added', () => this.refreshBarBounds())
    screen.on('display-removed', () => this.refreshBarBounds())
  }

  hub(): BrowserWindow {
    if (!this.#hub || this.#hub.isDestroyed()) {
      this.#hub = createHubWindow()
      // Packaged macOS builds are LSUIElement: no Dock icon by default. Give
      // the app one for as long as the Hub is open — with it come the app menu
      // (⌘Q, Edit shortcuts) and the Dock's own Quit, so even a user whose
      // menu-bar icon is hidden behind the notch can always leave. The Bar
      // stays Dock-less: it is chrome, not a window the user "has open".
      if (process.platform === 'darwin') {
        void app.dock?.show()
        // Showing the Dock icon transforms the process, and a transform resets
        // the window levels of everything the process owns. Put the Bar's back.
        // Safe to re-run: `keepBarEverywhere` no longer transforms anything
        // itself, so it cannot take the icon away again.
        if (this.#bar && !this.#bar.isDestroyed()) keepBarEverywhere(this.#bar)
      }
      this.#hub.on('closed', () => {
        this.#hub = null
        if (process.platform === 'darwin') {
          // Only when nothing else of ours is on screen: the Scratchpad needs
          // the app menu just as much, and hiding the Dock icon out from under
          // it takes ⌘W and the Edit shortcuts with it.
          if (this.#notes === null) app.dock?.hide()
          // Hiding it transforms the process back, resetting the levels again.
          if (this.#bar && !this.#bar.isDestroyed()) keepBarEverywhere(this.#bar)
        }
      })
    }
    return this.#hub
  }

  /**
   * Whether the Hub is already on screen and ready to be switched to.
   *
   * Exists so `app.on('activate')` can tell "the user wants their window back"
   * from "the app was activated for some other reason". Minimised counts as
   * *not* open: clicking the Dock icon should un-minimise it.
   */
  hubIsOpen(): boolean {
    const window = this.#hub
    return window !== null && !window.isDestroyed() && window.isVisible() && !window.isMinimized()
  }

  /**
   * Does a Hub window exist at all — even minimised, even hidden?
   *
   * Distinct from {@link hubIsOpen}, which asks whether one is *on screen*.
   * The difference decides whether an `activate` is worth acting on: a
   * packaged build is `LSUIElement`, so its Dock icon exists only while a Hub
   * or Scratchpad window does. No window, no icon; no icon, no Dock click.
   */
  hubExists(): boolean {
    return this.#hub !== null && !this.#hub.isDestroyed()
  }

  /** Focus the Hub, creating it if the user closed it earlier. */
  showHub(): void {
    const window = this.hub()
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  }

  bar(): BrowserWindow {
    if (!this.#bar || this.#bar.isDestroyed()) {
      this.#bar = createBarWindow(this.#barLayout())
      this.#bar.on('closed', () => {
        this.#bar = null
      })
    }
    return this.#bar
  }

  /**
   * Show the pill without stealing focus from the target app.
   *
   * Repositioned only while hidden: moving it mid-dictation would make it hop
   * displays under the user's cursor while they are speaking.
   */
  showBar(): void {
    const window = this.bar()
    if (!window.isVisible()) {
      const wanted = repositionBar(window, this.#barLayout())
      window.showInactive()
      // Ordering the window in is what lets macOS constrain it out of the Dock's
      // strip, so the anchor has to be re-asserted on the far side of the show,
      // not before it. The same rectangle, deliberately: recomputing would read
      // the cursor a second time and could answer with a different display.
      anchorBar(window, wanted)
      // Windows sometimes no-ops showInactive on a never-shown transparent
      // window. Retry on the next tick rather than falling back to
      // show()+blur(): show() activates the pill, and blur() only releases it
      // again — Windows then raises whatever is next in z-order, which is not
      // the app the user is dictating into. That both misdirects the paste and
      // corrupts the frontmost-app capture the orchestrator just took.
      if (!window.isVisible() && process.platform === 'win32') {
        setImmediate(() => {
          if (window.isDestroyed() || window.isVisible()) return
          window.showInactive()
          anchorBar(window, wanted)
        })
      }
    } else {
      window.moveTop()
    }
  }

  hideBar(): void {
    if (this.#bar && !this.#bar.isDestroyed() && this.#bar.isVisible()) this.#bar.hide()
  }

  /**
   * The Scratchpad (PLAN §2.2.7). Created on demand, like the Hub — most
   * sessions never open it, and an unopened window should cost nothing.
   */
  notes(): BrowserWindow {
    if (!this.#notes || this.#notes.isDestroyed()) {
      this.#notes = createNotesWindow()
      // Same Dock reasoning as the Hub: while a real window of ours is open the
      // app needs a Dock icon, and with it the app menu — ⌘W, ⌘Q, and the Edit
      // shortcuts a text editor is unusable without. And the same window-level
      // caveat: the dock.show() transform resets the Bar's panel levels, so
      // they are re-asserted on both edges of the Scratchpad's life too.
      if (process.platform === 'darwin') {
        void app.dock?.show()
        if (this.#bar && !this.#bar.isDestroyed()) keepBarEverywhere(this.#bar)
      }
      this.#notes.on('closed', () => {
        this.#notes = null
        if (process.platform === 'darwin') {
          if (this.#hub === null) app.dock?.hide()
          if (this.#bar && !this.#bar.isDestroyed()) keepBarEverywhere(this.#bar)
        }
      })
    }
    return this.#notes
  }

  /** Bring the Scratchpad forward, creating it if it is not open. */
  showNotes(): BrowserWindow {
    const window = this.notes()
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
    return window
  }

  audio(): BrowserWindow {
    if (!this.#audio || this.#audio.isDestroyed()) {
      this.#audio = createAudioWindow()
      this.#audio.on('closed', () => {
        this.#audio = null
      })
    }
    return this.#audio
  }

  /** Live web contents for every window — the target set for broadcasts. */
  allWebContents(): WebContents[] {
    return [this.#hub, this.#bar, this.#audio, this.#notes]
      .filter((window): window is BrowserWindow => window !== null && !window.isDestroyed())
      .map((window) => window.webContents)
      .filter((contents) => !contents.isDestroyed())
  }

  /** Windows that render dictation UI (i.e. everything except the mic page). */
  uiWebContents(): WebContents[] {
    return [this.#hub, this.#bar, this.#notes]
      .filter((window): window is BrowserWindow => window !== null && !window.isDestroyed())
      .map((window) => window.webContents)
      .filter((contents) => !contents.isDestroyed())
  }

  destroy(): void {
    for (const window of [this.#hub, this.#bar, this.#audio, this.#notes]) {
      if (window && !window.isDestroyed()) window.destroy()
    }
    this.#hub = null
    this.#bar = null
    this.#audio = null
    this.#notes = null
  }

  /**
   * Move the pill to the display the user is actually working on.
   *
   * `showBar()` re-anchors only while the window is *hidden*, which was fine
   * when the Bar appeared per dictation: every appearance re-read the cursor.
   * Once `barVisibility` began defaulting to `always` the window stopped ever
   * being hidden, so that branch stopped running and the pill sat on whichever
   * display it was first placed on for the life of the process — plug in a
   * second monitor, work there all afternoon, and the indicator stays behind.
   *
   * A no-op when the pill is already on the right display, which is every call
   * on a single-monitor machine: two cheap `screen` reads and an early return,
   * nothing touched.
   *
   * The *when* is the delicate half and lives with the caller — this may not
   * run mid-utterance. A pill that changed screens while someone was speaking
   * would take the waveform away from where they were looking, and the cursor
   * is a poor guide exactly then (it sits wherever it was left, not where the
   * voice is going). Main calls this as a dictation begins and while nothing
   * is happening; never in between.
   *
   * @returns whether the window actually moved.
   */
  followActiveDisplay(): boolean {
    const window = this.#bar
    if (!window || window.isDestroyed() || !window.isVisible()) return false

    const cursor = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    const showing = screen.getDisplayMatching(window.getBounds())
    if (cursor.id === showing.id) return false

    anchorBar(window, repositionBar(window, this.#barLayout()))
    return true
  }

  /**
   * Re-anchor the Bar window now.
   *
   * Called on display changes and whenever the style or corner setting moves —
   * the latter is the case that cannot wait for the next `showBar()`, since a
   * user with the Bar set to Always is watching the thing they just changed.
   */
  refreshBarBounds(): void {
    if (!this.#bar || this.#bar.isDestroyed()) return
    // Anchored as well as positioned: a visible window is not constrained the
    // way an appearing one is, but this runs while it may be either.
    anchorBar(this.#bar, repositionBar(this.#bar, this.#barLayout()))
  }
}
