import { app, Menu, Tray } from 'electron'

import { createTrayIcon, type TrayState } from './tray-icon'

/**
 * The menu-bar item (PLAN §2.3).
 *
 * Stage 1 wires the three entries that already do something. The mic picker,
 * language submenu and "start hands-free dictation" arrive with the features
 * they control.
 */

export interface TrayDeps {
  openHub: () => void
  /** Suspend the hotkey listener without quitting. */
  setPaused: (paused: boolean) => void
  isPaused: () => boolean
  quit: () => void
  /**
   * Meeting capture (PLAN §18.2). Optional so the tray keeps working for any
   * caller that predates it — and because the whole feature is off by default.
   */
  meetings?: {
    /** False when the user has not enabled the feature; the item is hidden. */
    enabled: () => boolean
    recording: () => boolean
    start: () => void
    stop: () => void
  }
  /** True while an utterance is being captured, for the icon's active state. */
  isListening?: () => boolean
}

export class TrayController {
  #tray: Tray | null = null
  readonly #deps: TrayDeps
  /** What the icon currently shows, so a redraw only happens on a real change. */
  #iconState: TrayState | null = null

  constructor(deps: TrayDeps) {
    this.#deps = deps
  }

  start(): Tray {
    if (this.#tray && !this.#tray.isDestroyed()) return this.#tray

    const tray = new Tray(createTrayIcon())
    tray.setToolTip('Murmur')
    // On Windows/Linux a left click has no menu by default; make it open the Hub.
    tray.on('click', () => this.#deps.openHub())
    this.#tray = tray
    this.refresh()
    return tray
  }

  /**
   * Rebuild the menu — call after anything it reflects changes.
   *
   * That now includes meeting state, so the composition root refreshes on
   * every `meeting.changed`; previously this was only ever called from
   * `start()` and the pause toggle.
   */
  refresh(): void {
    if (!this.#tray || this.#tray.isDestroyed()) return

    const paused = this.#deps.isPaused()
    const meetings = this.#deps.meetings
    // The tray is the only always-visible surface, so it is where recording
    // has to be both startable and — more importantly — stoppable. A recording
    // the user cannot find the off switch for is not a feature.
    const meetingItems: Electron.MenuItemConstructorOptions[] = meetings?.enabled()
      ? [
          meetings.recording()
            ? { label: 'Stop recording meeting', click: () => meetings.stop() }
            : { label: 'Record meeting…', click: () => meetings.start() },
          { type: 'separator' },
        ]
      : []

    const menu = Menu.buildFromTemplate([
      { label: 'Open Hub', click: () => this.#deps.openHub() },
      { type: 'separator' },
      ...meetingItems,
      {
        label: 'Pause Murmur',
        type: 'checkbox',
        checked: paused,
        click: () => {
          this.#deps.setPaused(!paused)
          this.refresh()
        },
      },
      { type: 'separator' },
      { label: `Version ${app.getVersion()}`, enabled: false },
      { label: 'Quit Murmur', accelerator: 'CommandOrControl+Q', click: () => this.#deps.quit() },
    ])

    this.#tray.setContextMenu(menu)
    this.#tray.setToolTip(meetings?.recording() ? 'Murmur — recording this meeting' : 'Murmur')
    this.#applyIcon()
  }

  /**
   * Repaint the glyph for the current state.
   *
   * Recording outranks listening: it is the longer-lived of the two and the
   * one the user needs to be able to see at any moment, whereas listening is
   * over in seconds and the pill is already showing it.
   */
  #applyIcon(): void {
    if (!this.#tray || this.#tray.isDestroyed()) return
    const next: TrayState = this.#deps.meetings?.recording()
      ? 'recording'
      : this.#deps.isListening?.()
        ? 'listening'
        : 'idle'
    if (next === this.#iconState) return
    this.#iconState = next
    this.#tray.setImage(createTrayIcon(next))
  }

  /**
   * Update just the icon, without rebuilding the menu.
   *
   * Dictation state changes many times a second while the level moves;
   * rebuilding a Menu that often would be wasteful and, on macOS, would fight
   * an open menu.
   */
  refreshIcon(): void {
    this.#applyIcon()
  }

  destroy(): void {
    if (this.#tray && !this.#tray.isDestroyed()) this.#tray.destroy()
    this.#tray = null
  }
}
