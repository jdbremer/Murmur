import { type BrowserWindow, screen, type WebContents } from 'electron'

import { createAudioWindow } from './audio'
import { createBarWindow, repositionBar } from './bar'
import { createHubWindow } from './hub'

/**
 * Owns the three windows and hands out their web contents.
 *
 * Windows are created lazily except the Bar and the capture renderer, which the
 * dictation loop needs to already exist by the time a hotkey arrives.
 */
export class WindowManager {
  #hub: BrowserWindow | null = null
  #bar: BrowserWindow | null = null
  #audio: BrowserWindow | null = null

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
      this.#hub.on('closed', () => {
        this.#hub = null
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
   * Repositions every show so multi-monitor cursor moves stay correct.
   */
  showBar(): void {
    const window = this.bar()
    repositionBar(window)
    // Windows sometimes no-ops showInactive on a never-shown transparent window.
    if (!window.isVisible()) {
      window.showInactive()
      if (!window.isVisible() && process.platform === 'win32') {
        window.show()
        // Immediately yield focus back if anything grabbed it.
        window.blur()
      }
    } else {
      window.moveTop()
    }
  }

  hideBar(): void {
    if (this.#bar && !this.#bar.isDestroyed() && this.#bar.isVisible()) this.#bar.hide()
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
    return [this.#hub, this.#bar, this.#audio]
      .filter((window): window is BrowserWindow => window !== null && !window.isDestroyed())
      .map((window) => window.webContents)
      .filter((contents) => !contents.isDestroyed())
  }

  /** Windows that render dictation UI (i.e. everything except the mic page). */
  uiWebContents(): WebContents[] {
    return [this.#hub, this.#bar]
      .filter((window): window is BrowserWindow => window !== null && !window.isDestroyed())
      .map((window) => window.webContents)
      .filter((contents) => !contents.isDestroyed())
  }

  destroy(): void {
    for (const window of [this.#hub, this.#bar, this.#audio]) {
      if (window && !window.isDestroyed()) window.destroy()
    }
    this.#hub = null
    this.#bar = null
    this.#audio = null
  }

  #repositionBar(): void {
    if (this.#bar && !this.#bar.isDestroyed()) repositionBar(this.#bar)
  }
}
