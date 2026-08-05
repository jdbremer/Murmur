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
  request(kind: PermissionKind): Promise<PermissionState>
  openSettings(kind: PermissionKind): void
}

export interface MurmurNative {
  /** `false` when this is the stub — every call below is then a no-op. */
  readonly available: boolean
  startHotkeyListener(config: HotkeyConfig, listener: HotkeyListener): void
  stopHotkeyListener(): void
  insertText(text: string): InsertTextResult
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
