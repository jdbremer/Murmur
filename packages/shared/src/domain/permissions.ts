import { z } from 'zod'

/**
 * macOS permission surface (PLAN §4). `unavailable` is what a non-macOS build
 * reports — the concept simply does not exist there, which is different from
 * "the user said no".
 */

export const PermissionKindSchema = z.enum(['microphone', 'accessibility', 'inputMonitoring'])
export type PermissionKind = z.infer<typeof PermissionKindSchema>

export const PermissionStateSchema = z.enum(['granted', 'denied', 'unknown', 'unavailable'])
export type PermissionState = z.infer<typeof PermissionStateSchema>

export const PermissionsStatusSchema = z.object({
  /** `getUserMedia` in the hidden capture renderer. */
  microphone: PermissionStateSchema,
  /** Synthetic ⌘V / AX text insertion. */
  accessibility: PermissionStateSchema,
  /** The listen-only CGEventTap behind the global hotkey. */
  inputMonitoring: PermissionStateSchema,
})
export type PermissionsStatus = z.infer<typeof PermissionsStatusSchema>

/** Nothing checked yet — what the Help panel shows before its first probe. */
export function createUnknownPermissionsStatus(): PermissionsStatus {
  return { microphone: 'unknown', accessibility: 'unknown', inputMonitoring: 'unknown' }
}

/** What a platform without these concepts (Linux dev, Windows) reports. */
export function createUnavailablePermissionsStatus(): PermissionsStatus {
  return {
    microphone: 'unavailable',
    accessibility: 'unavailable',
    inputMonitoring: 'unavailable',
  }
}
