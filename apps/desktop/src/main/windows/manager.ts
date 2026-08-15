import { app, type BrowserWindow, screen, type WebContents } from 'electron'

import { createAudioWindow } from './audio'
import { createBarWindow, repositionBar } from './bar'
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

  /** Create the always-on windows. Call once, after `app.whenReady()`. */
  start(): void {
    this.bar()
    this.audio()

    // Keep the pill anchored when displays change (PLAN §2.1 "follows the
    // active display" — Stage 2 extends this to the focused display).
    screen.on('display-metrics-changed', () => this.#repositionBar())
    screen.on('display-added', () => this.#repositionBar())
    screen.on('display-removed', () => this.#repositionBar())
  }

  hub(): BrowserWindow {
    if (!this.#hub || this.#hub.isDestroyed()) {
      this.#hub = createHubWindow()
      // Packaged macOS builds are LSUIElement: no Dock icon by default. Give
      // the app one for as long as the Hub is open — with it come the app menu
      // (⌘Q, Edit shortcuts) and the Dock's own Quit, so even a user whose
      // menu-bar icon is hidden behind the notch can always leave. The Bar
      // stays Dock-less: it is chrome, not a window the user "has open".
      if (process.platform === 'darwin') void app.dock?.show()
      this.#hub.on('closed', () => {
        this.#hub = null
        // Only when nothing else of ours is on screen: the Scratchpad needs the
        // app menu just as much, and hiding the Dock icon out from under it
        // takes ⌘W and the Edit shortcuts with it.
        if (process.platform === 'darwin' && this.#notes === null) app.dock?.hide()
      })
    }
    return this.#hub
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
      this.#bar = createBarWindow()
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
      repositionBar(window)
      window.showInactive()
      // Windows sometimes no-ops showInactive on a never-shown transparent
      // window. Retry on the next tick rather than falling back to
      // show()+blur(): show() activates the pill, and blur() only releases it
      // again — Windows then raises whatever is next in z-order, which is not
      // the app the user is dictating into. That both misdirects the paste and
      // corrupts the frontmost-app capture the orchestrator just took.
      if (!window.isVisible() && process.platform === 'win32') {
        setImmediate(() => {
          if (!window.isDestroyed() && !window.isVisible()) window.showInactive()
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
      // shortcuts a text editor is unusable without.
      if (process.platform === 'darwin') void app.dock?.show()
      this.#notes.on('closed', () => {
        this.#notes = null
        if (process.platform === 'darwin' && this.#hub === null) app.dock?.hide()
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

  #repositionBar(): void {
    if (this.#bar && !this.#bar.isDestroyed()) repositionBar(this.#bar)
  }
}
