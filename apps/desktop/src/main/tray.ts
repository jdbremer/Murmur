import { app, Menu, Tray } from 'electron'

import { createTrayIcon } from './tray-icon'

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
}

export class TrayController {
  #tray: Tray | null = null
  readonly #deps: TrayDeps

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
  }

  destroy(): void {
    if (this.#tray && !this.#tray.isDestroyed()) this.#tray.destroy()
    this.#tray = null
  }
}
