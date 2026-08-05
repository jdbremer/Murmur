import { z } from 'zod'

/**
 * The result of a user-pressed "Check for updates" (PLAN §10.2).
 *
 * `none` is distinct from `current` on purpose: "you are up to date" is a
 * claim, and it would be a false one when the real answer is that nothing has
 * ever been published. A repo with no releases yet must not be reported as
 * confirmation that the running build is the newest.
 *
 * There is no `downloading` or `installing` state. macOS refuses to
 * self-update an app that is not Developer-ID signed, so this reports and
 * links; it never pretends it can install.
 */
export const UpdateCheckStatusSchema = z.enum(['current', 'available', 'none', 'error'])
export type UpdateCheckStatus = z.infer<typeof UpdateCheckStatusSchema>

export const UpdateCheckResultSchema = z.object({
  status: UpdateCheckStatusSchema,
  /** The running build, so the UI never has to ask twice. */
  currentVersion: z.string(),
  /** Null unless a published release was found. */
  latestVersion: z.string().nullable(),
  /** Where to get it — the release page, opened in the user's browser. */
  url: z.string(),
  /** Present on `error`: what to tell the user. */
  message: z.string().optional(),
})
export type UpdateCheckResult = z.infer<typeof UpdateCheckResultSchema>
