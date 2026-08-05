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
}

export type HotkeyListener = (event: HotkeyEvent) => void

export interface InsertTextResult {
  ok: boolean
  /** How the text got in — or why it did not. */
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
  /** Begin listening for the configured hotkey. Listen-only (PLAN §10.5). */
  startHotkeyListener(config: HotkeyConfig, listener: HotkeyListener): void
  stopHotkeyListener(): void
  /** Clipboard-swap + synthetic ⌘V, with AX insertion as fallback. */
  insertText(text: string): InsertTextResult
  getFrontmostApp(): FrontmostApp | null
  /** True when a password field owns input; Murmur must refuse to type. */
  isSecureInputActive(): boolean
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
      /* no-op: no event tap without the native module */
    },
    stopHotkeyListener() {
      /* no-op */
    },
    insertText() {
      return { ok: false, method: 'none', error: reason }
    },
    getFrontmostApp() {
      return null
    },
    isSecureInputActive() {
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
