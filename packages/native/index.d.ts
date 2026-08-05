/**
 * Types for `@murmur/native`.
 *
 * Kept self-contained (no import from `@murmur/shared`) so this package stays
 * installable and typeable on its own. The same interface is declared as
 * `MurmurNative` in `@murmur/shared/src/native/interface.ts`, which is what the
 * desktop app types against — on a non-macOS dev box npm skips this package
 * entirely, so these declarations are not always present.
 */

export type PermissionKind = 'microphone' | 'accessibility' | 'inputMonitoring'
export type PermissionState = 'granted' | 'denied' | 'unknown' | 'unavailable'

export interface PermissionsStatus {
  microphone: PermissionState
  accessibility: PermissionState
  inputMonitoring: PermissionState
}

export interface HotkeyConfig {
  key: 'fn' | 'rightCmd' | 'rightOpt' | 'custom'
  customKeyCode: number | null
  activation: 'hold' | 'toggle'
  doubleTapHandsFree: boolean
}

export interface HotkeyEvent {
  type: 'down' | 'up' | 'doubleTap'
  timestamp: number
}

export type HotkeyListener = (event: HotkeyEvent) => void

/** What one native side effect reports back. Never throws across the boundary. */
export interface NativeActionResult {
  ok: boolean
  /** Present when `ok` is false. Safe to show the user; never contains text. */
  error?: string
}

export interface FrontmostApp {
  bundleId: string
  name: string
}

export interface NativePermissions {
  check(): PermissionsStatus
  request(kind: PermissionKind): Promise<PermissionState>
  openSettings(kind: PermissionKind): void
}

export interface MurmurNative {
  /** `false` when this is the stub — every call below is then a no-op. */
  readonly available: boolean
  /**
   * Install the listen-only CGEventTap. Returns `false` from the binding when
   * the tap could not be created (almost always missing Input Monitoring).
   */
  startHotkeyListener(config: HotkeyConfig, listener: HotkeyListener): void
  stopHotkeyListener(): void
  /** Synthesize ⌘V. The clipboard save/set/restore dance lives in main. */
  sendPasteShortcut(): NativeActionResult
  /** AX fallback for apps that drop synthetic keystrokes. */
  insertTextViaAccessibility(text: string): NativeActionResult
  getFrontmostApp(): FrontmostApp | null
  isSecureInputActive(): boolean
  readonly permissions: NativePermissions
  platformInfo(): string
}

/**
 * The module's default export. It is a CommonJS `module.exports = <object>`,
 * so consumers need `esModuleInterop` (or `require()`) to reach it.
 */
declare const native: MurmurNative & {
  /** Exposed for tests and for callers that want an explicit inert instance. */
  createStub(reason: string): MurmurNative
}

export default native
