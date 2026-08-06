import { z } from 'zod'

/**
 * The update flow (PLAN §10.2), driven entirely by the user.
 *
 * Nothing here runs on a timer. Help promises no telemetry and nothing on a
 * schedule, and a background check would quietly make that false — it would
 * tell GitHub this machine's IP, its version and when it is awake, on a
 * cadence the user never agreed to. So: a button to check, a button to
 * download, a button to restart. Three deliberate acts.
 *
 * `none` is distinct from `current` because "you are up to date" is a claim,
 * and it would be a false one when the truth is that nothing has ever been
 * published. `unsupported` covers the builds that genuinely cannot self-update
 * — a dev run from source, or a macOS app without a Developer ID signature,
 * which Squirrel refuses to replace.
 */
export const UpdateStatusSchema = z.enum([
  'idle',
  'checking',
  'available',
  'downloading',
  'downloaded',
  'current',
  'none',
  'unsupported',
  'error',
])
export type UpdateStatus = z.infer<typeof UpdateStatusSchema>

export const UpdateStateSchema = z.object({
  status: UpdateStatusSchema,
  /** The running build, so the UI never has to ask twice. */
  currentVersion: z.string(),
  /** Null until a release is found. */
  latestVersion: z.string().nullable(),
  /** 0–100 while `downloading`. */
  percent: z.number().min(0).max(100).nullable(),
  /** The release page — the fallback when self-update is unavailable. */
  url: z.string(),
  /** Present on `error` and `unsupported`: what to tell the user. */
  message: z.string().optional(),
})
export type UpdateState = z.infer<typeof UpdateStateSchema>

/** Back-compat alias — the old name for what is now {@link UpdateState}. */
export const UpdateCheckResultSchema = UpdateStateSchema
export type UpdateCheckResult = UpdateState
