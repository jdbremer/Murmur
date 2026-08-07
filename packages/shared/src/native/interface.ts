import type { HotkeyConfig } from '../domain/settings'
import type { PermissionKind, PermissionState, PermissionsStatus } from '../domain/permissions'
import { createUnavailablePermissionsStatus } from '../domain/permissions'

/**
 * The contract `@murmur/native` implements (PLAN §4).
 *
 * It lives here rather than in `@murmur/native` for one practical reason: that
 * package declares `"os": ["darwin"]`, so on a Linux dev box npm skips it
 * entirely and neither its runtime nor its `.d.ts` exists. Typing against this
 * interface keeps `npm run typecheck` honest on every platform, and the desktop
 * app falls back to {@link createNativeStub} when the real module is absent.
 */

/** Which physical key produced the event, resolved from {@link HotkeyConfig}. */
export interface HotkeyEvent {
  type: 'down' | 'up' | 'doubleTap'
  /** Monotonic milliseconds, for double-tap timing. */
  timestamp: number
  /**
   * True for edges that did not come from the physical keyboard —
   * `debug.simulateHotkey`, the SIGUSR2 driver, or the bridge's own
   * reconciliation. The bridge skips the physical-state watchdog for these:
   * asking the HID system about a key nobody pressed would end the utterance
   * a poll later.
   */
  synthetic?: boolean
}

export type HotkeyListener = (event: HotkeyEvent) => void

/** What one native side effect reports back. Never throws across the boundary. */
export interface NativeActionResult {
  ok: boolean
  /** Present when `ok` is false. Safe to show the user; never contains text. */
  error?: string
}

/**
 * The outcome of the *whole* injection sequence, assembled in the main process
 * (PLAN §3.2.5). `method` is what actually worked, and it is the same union the
 * `inserted` dictation event carries.
 */
export interface InsertTextResult {
  ok: boolean
  method: 'paste' | 'accessibility' | 'none'
  error?: string
}

export interface FrontmostApp {
  bundleId: string
  name: string
}

export interface NativePermissions {
  check(): PermissionsStatus
  /** Triggers the OS prompt where one exists; resolves with the new state. */
  request(kind: PermissionKind): Promise<PermissionState>
  /** Deep-links into the relevant System Settings pane. */
  openSettings(kind: PermissionKind): void
}

export interface MurmurNative {
  /** `false` means this is the stub: every call below is a safe no-op. */
  readonly available: boolean
  /**
   * Begin listening for the configured hotkey. Listen-only (PLAN §10.5).
   *
   * `false` means the OS refused to install the hook — Input Monitoring not
   * granted on macOS, `SetWindowsHookEx` failing on Windows, or a preset this
   * platform's backend cannot bind. It is a status, not an exception: a throw
   * here would land in Electron bootstrap.
   */
  startHotkeyListener(config: HotkeyConfig, listener: HotkeyListener): boolean
  stopHotkeyListener(): void
  /**
   * Clear a stuck chord latch (e.g. after a failed begin while Space is still
   * held). Safe no-op when nothing is latched. Does not synthesize a user key.
   */
  releaseHotkeyLatch(): void
  /**
   * Synthesize ⌘V into whatever owns input right now.
   *
   * Deliberately *only* the keystroke: the clipboard save/set/restore dance
   * lives in the main process where Electron's `clipboard` module already
   * handles every pasteboard type (PLAN §3.2.5).
   */
  sendPasteShortcut(): NativeActionResult
  /**
   * The HID system's own answer to "is the configured hotkey held right now",
   * independent of event delivery. Taps can be disabled for slowness and other
   * apps' active taps can swallow an edge; this is the reconciliation truth
   * the bridge polls while a hold is live.
   */
  hotkeyPhysicallyDown(): boolean
  /**
   * Fallback for apps that ignore synthetic keystrokes: write `text` straight
   * into the focused `AXUIElement`.
   */
  insertTextViaAccessibility(text: string): NativeActionResult
  /**
   * The focused element's current selection, for command mode (PLAN §18.1).
   * `{ ok: true, text: '' }` means "no selection" — a normal answer; `ok:
   * false` is reserved for a missing permission or an uncooperative app.
   */
  getSelectedText(): { ok: boolean; text?: string; error?: string }
  /**
   * Up to `maxChars` of text immediately before the insertion point, so
   * dictation can match the capitalisation of what it lands in
   * (dictation/sentence-case.ts).
   *
   * A much narrower read than getSelectedText: a handful of characters the
   * user did not select, used to decide one boolean and never logged or
   * stored. `ok: false` means *unknown* — no text control, no such API on this
   * platform — and callers must leave the text alone rather than guess.
   * `{ ok: true, text: '' }` is a real answer: the cursor is at the start.
   */
  getTextBeforeCursor(maxChars?: number): { ok: boolean; text?: string; error?: string }
  /**
   * Frontmost window title of a specific process, for meeting detection
   * (PLAN §18.2). macOS-only and optional — treat a missing implementation as
   * "no title", which degrades detection rather than breaking it.
   *
   * The narrowest possible read: a bundle id cannot distinguish a Google Meet
   * tab from any other tab, so this is the only way to recognise — or name — a
   * browser-hosted call. Callers must only ask about a process already holding
   * both microphone and speakers, and must never log the result.
   */
  getWindowTitle?(pid: number): { ok: boolean; title?: string; error?: string }
  getFrontmostApp(): FrontmostApp | null
  /** True when a password field owns input; Murmur must refuse to type. */
  isSecureInputActive(): boolean
  /**
   * True when the frontmost app runs elevated and this process does not
   * (Windows UIPI). Optional on stubs/macOS — treat missing as `false`.
   */
  isForegroundElevated?(): boolean
  readonly permissions: NativePermissions
  /** Free-form build/runtime description, e.g. `"stub"` or `"darwin arm64"`. */
  platformInfo(): string
}

/**
 * A fully inert implementation with the same shape. Used on non-macOS dev
 * machines and whenever loading the compiled binding fails (for example when
 * the user has not granted Input Monitoring yet).
 */
export function createNativeStub(reason = 'native module unavailable'): MurmurNative {
  return {
    available: false,
    startHotkeyListener() {
      // No event tap without the native module — and say so, rather than
      // letting the caller believe a listener is running.
      return false
    },
    stopHotkeyListener() {
      /* no-op */
    },
    releaseHotkeyLatch() {
      /* no-op */
    },
    sendPasteShortcut() {
      return { ok: false, error: reason }
    },
    hotkeyPhysicallyDown() {
      return false
    },
    insertTextViaAccessibility() {
      return { ok: false, error: reason }
    },
    getSelectedText() {
      return { ok: false, error: reason }
    },
    getTextBeforeCursor() {
      return { ok: false, error: reason }
    },
    getWindowTitle() {
      return { ok: false, error: reason }
    },
    getFrontmostApp() {
      return null
    },
    isSecureInputActive() {
      return false
    },
    isForegroundElevated() {
      return false
    },
    permissions: {
      check() {
        return createUnavailablePermissionsStatus()
      },
      async request() {
        return 'unavailable'
      },
      openSettings() {
        /* no-op */
      },
    },
    platformInfo() {
      return `stub (${reason})`
    },
  }
}
