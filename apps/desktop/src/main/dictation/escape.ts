import { globalShortcut } from 'electron'

import { createLogger, type Logger } from '../logging'

/**
 * Esc cancels a dictation in progress (PLAN §2.1 "Interaction").
 *
 * It has to live in main. The Bar window is deliberately non-activating and
 * `focusable: false`, so it never receives a key event — a `keydown` listener in
 * the Bar renderer only fires in the rare case that the Bar somehow has focus,
 * and the user pressing Esc is typing into someone else's app.
 *
 * The shortcut is held for exactly as long as the machine is `listening`, and
 * released the moment it is not. That matters: a permanently registered Esc
 * would swallow the key from every other app on the system, which is the kind
 * of quiet hostility that gets a dictation tool uninstalled.
 */
export class EscapeCancel {
  readonly #cancel: () => void
  readonly #log: Logger
  #armed = false

  constructor(options: { cancel: () => void; log?: Logger }) {
    this.#cancel = options.cancel
    this.#log = options.log ?? createLogger('hotkey')
  }

  get armed(): boolean {
    return this.#armed
  }

  arm(): void {
    if (this.#armed) return
    try {
      this.#armed = globalShortcut.register('Escape', this.#cancel)
      if (!this.#armed) this.#log.warn('another app owns Esc; cancel-by-Esc is unavailable')
    } catch (error) {
      // Registration can fail on a headless/Linux dev box. Not fatal: the
      // hotkey release path still ends the utterance.
      this.#log.warn('could not register Esc:', error)
      this.#armed = false
    }
  }

  disarm(): void {
    if (!this.#armed) return
    this.#armed = false
    try {
      globalShortcut.unregister('Escape')
    } catch (error) {
      this.#log.warn('could not release Esc:', error)
    }
  }

  dispose(): void {
    this.disarm()
  }
}
