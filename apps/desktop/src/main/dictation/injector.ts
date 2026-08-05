import { clipboard } from 'electron'

import type { InsertTextResult, MurmurNative } from '@murmur/shared'

import { createLogger, redact, type Logger } from '../logging'

/**
 * Getting text into the frontmost app (PLAN §3.2.5, §4).
 *
 * The sequence, and why each step is where it is:
 *
 *  1. **Refuse on secure input.** `IsSecureEventInputEnabled()` is true when a
 *     password field (or a password manager that left it on) owns the keyboard.
 *     Synthesising ⌘V there would either do nothing or paste a transcript into
 *     a password box. We refuse with a typed error the Bar names.
 *  2. **Save the clipboard.** Text *and* HTML, because pasting into a rich-text
 *     app and then restoring only `text/plain` silently destroys what the user
 *     had copied.
 *  3. **Write the transcript, then synthesise ⌘V.** This is the technique every
 *     Flow-class app uses; nothing else works across the whole app population.
 *  4. **AX fallback.** Some apps (Electron apps with unusual focus handling,
 *     VMs, remote desktops) drop synthetic keystrokes. When the paste reports
 *     failure we write straight into the focused `AXUIElement`.
 *  5. **Restore the clipboard, after a delay.** The paste is asynchronous from
 *     our point of view — the target app reads the pasteboard on its own
 *     schedule — so restoring immediately races it and pastes the *old*
 *     clipboard. ~150 ms is the usual compromise (PLAN §3.2.5).
 *
 * Non-macOS returns `{ ok: false, reason: 'unsupported-platform' }` cleanly:
 * the stub's `sendPasteShortcut` reports failure, and this module turns that
 * into a typed result rather than an exception.
 */

/**
 * Delay before the clipboard is put back (PLAN §3.2.5).
 * Windows needs a longer settle — Win11 Notepad / packaged apps often read the
 * pasteboard after the synthetic Ctrl+V returns, so 150 ms races the restore.
 */
export const CLIPBOARD_RESTORE_MS = process.platform === 'win32' ? 400 : 150

export type InjectionFailure =
  | 'secure-input'
  | 'elevated-target'
  | 'unsupported-platform'
  | 'no-focus'
  | 'paste-failed'
  | 'empty-text'

export interface InjectionResult extends InsertTextResult {
  reason?: InjectionFailure
}

export interface InjectorOptions {
  native: () => MurmurNative
  log?: Logger
  /** Injected for tests so a suite does not wait 150 ms per case. */
  restoreDelayMs?: number
  /** Injected for tests; defaults to Electron's clipboard. */
  clipboardImpl?: ClipboardLike
}

/** The slice of Electron's clipboard this module uses. */
export interface ClipboardLike {
  readText(): string
  readHTML(): string
  writeText(text: string): void
  write(data: { text?: string; html?: string }): void
  clear(): void
}

export class TextInjector {
  readonly #native: () => MurmurNative
  readonly #log: Logger
  readonly #restoreDelayMs: number
  readonly #clipboard: ClipboardLike
  #restoreTimer: NodeJS.Timeout | null = null

  constructor(options: InjectorOptions) {
    this.#native = options.native
    this.#log = options.log ?? createLogger('inject')
    this.#restoreDelayMs = options.restoreDelayMs ?? CLIPBOARD_RESTORE_MS
    this.#clipboard = options.clipboardImpl ?? clipboard
  }

  /**
   * Check whether insertion is possible *before* running a model.
   *
   * Called at hotkey-down, not at insert time: telling the user "this is a
   * password field" the moment they start speaking is far better than
   * transcribing five seconds and then refusing.
   */
  precheck(): { ok: true } | { ok: false; reason: InjectionFailure; message: string } {
    const native = this.#native()
    if (!native.available) {
      return {
        ok: false,
        reason: 'unsupported-platform',
        message:
          'Text insertion needs the native helper, which is not available yet on this build.',
      }
    }
    if (native.isSecureInputActive()) {
      return {
        ok: false,
        reason: 'secure-input',
        message: 'Secure field — Murmur will not type here.',
      }
    }
    // Windows UIPI: non-elevated Murmur cannot SendInput into an elevated app.
    if (typeof native.isForegroundElevated === 'function' && native.isForegroundElevated()) {
      return {
        ok: false,
        reason: 'elevated-target',
        message:
          'That app is running as administrator — Murmur cannot type into it. Use a non-admin window, or run Murmur as admin too.',
      }
    }
    return { ok: true }
  }

  /** Run the full insertion sequence. Never throws. */
  insert(text: string): InjectionResult {
    if (text.trim().length === 0) {
      return { ok: false, method: 'none', reason: 'empty-text', error: 'Nothing to insert' }
    }

    const precheck = this.precheck()
    if (!precheck.ok) {
      return { ok: false, method: 'none', reason: precheck.reason, error: precheck.message }
    }

    const native = this.#native()
    const saved = this.#saveClipboard()

    this.#clipboard.writeText(text)
    const paste = native.sendPasteShortcut()

    if (paste.ok) {
      this.#log.debug(`pasted ${redact(text)}`)
      this.#scheduleRestore(saved)
      return { ok: true, method: 'paste' }
    }

    // The paste did not land. Put the clipboard back *now* — the fallback does
    // not use it, and leaving a transcript on the pasteboard is a small leak.
    this.#restore(saved)

    this.#log.warn(`paste failed (${paste.error ?? 'unknown'}); trying accessibility insertion`)
    const accessibility = native.insertTextViaAccessibility(text)
    if (accessibility.ok) return { ok: true, method: 'accessibility' }

    return {
      ok: false,
      method: 'none',
      reason: 'paste-failed',
      error:
        accessibility.error ??
        paste.error ??
        'Could not insert text into the frontmost app. Try clicking into the field first.',
    }
  }

  /** Cancel a pending clipboard restore — used on quit. */
  dispose(): void {
    if (this.#restoreTimer) clearTimeout(this.#restoreTimer)
    this.#restoreTimer = null
  }

  #saveClipboard(): { text: string; html: string } {
    try {
      return { text: this.#clipboard.readText(), html: this.#clipboard.readHTML() }
    } catch {
      return { text: '', html: '' }
    }
  }

  #scheduleRestore(saved: { text: string; html: string }): void {
    if (this.#restoreTimer) clearTimeout(this.#restoreTimer)
    this.#restoreTimer = setTimeout(() => {
      this.#restoreTimer = null
      this.#restore(saved)
    }, this.#restoreDelayMs)
    this.#restoreTimer.unref?.()
  }

  #restore(saved: { text: string; html: string }): void {
    try {
      if (!saved.text && !saved.html) {
        // The clipboard was empty before we touched it; leave it empty rather
        // than leaving the transcript sitting there.
        this.#clipboard.clear()
        return
      }
      const data: { text?: string; html?: string } = {}
      if (saved.text) data.text = saved.text
      if (saved.html) data.html = saved.html
      this.#clipboard.write(data)
    } catch (error) {
      this.#log.warn('could not restore the clipboard:', error)
    }
  }
}
