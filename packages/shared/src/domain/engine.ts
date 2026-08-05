import { z } from 'zod'
import { ModelEngineSchema } from '../catalog/schema'

/**
 * What the STT and polish engines report about themselves (PLAN §6.1, §7.1).
 *
 * Engines never throw at the boundary — a missing sidecar binary, an absent
 * ONNX Runtime or a model that was deleted underneath us all resolve to a
 * status the Hub can render and the Bar can name. That is what keeps PLAN
 * §15.1's "no dead ends" promise reachable: the dictation loop asks the engine
 * for its status and turns anything other than `ready` into a typed error
 * state, rather than hanging on a request that will never be answered.
 */

/**
 * Lifecycle of one engine slot (there is one for STT and one for polishing).
 *
 *  - `idle`        — nothing selected, or unloaded after the idle timer fired.
 *  - `loading`     — sidecar spawning / session being created.
 *  - `ready`       — model resident, `transcribe`/`polish` will be answered.
 *  - `unavailable` — a precondition is missing and no retry will fix it until
 *                    the user acts (install a binary, download the model…).
 *  - `error`       — it was working and broke; the watchdog may still recover.
 */
export const EngineStateSchema = z.enum(['idle', 'loading', 'ready', 'unavailable', 'error'])
export type EngineState = z.infer<typeof EngineStateSchema>

/**
 * Machine-readable cause, so the UI can offer the right next action rather
 * than printing a sentence. PLAN §15.5: "every error message names a next
 * action" — these are what the action is chosen from.
 */
export const EngineUnavailableReasonSchema = z.enum([
  /** No model chosen for this slot yet. */
  'no-model-selected',
  /** The catalog model is selected but its files are not on disk. */
  'model-missing',
  /** `whisper-server` / `llama-server` is not in the app bundle. */
  'binary-missing',
  /** `onnxruntime-node` did not load (not installed for this platform). */
  'runtime-missing',
  /** The sidecar exited repeatedly; the watchdog gave up (PLAN §15.1). */
  'crash-loop',
  /** Engine cannot run on this OS at all. */
  'unsupported-platform',
  /** Anything else, with `detail` carrying the specifics. */
  'unknown',
])
export type EngineUnavailableReason = z.infer<typeof EngineUnavailableReasonSchema>

export const EngineStatusSchema = z.object({
  /** Which implementation is filling this slot; `null` when nothing is loaded. */
  engine: ModelEngineSchema.nullable().default(null),
  state: EngineStateSchema,
  /** Catalog (or imported) id of the model this slot holds. */
  modelId: z.string().min(1).nullable().default(null),
  /** Set whenever `state` is `unavailable` or `error`. */
  reason: EngineUnavailableReasonSchema.nullable().default(null),
  /** One human-readable line. Never contains transcript text (PLAN §15.3). */
  detail: z.string().default(''),
  /**
   * Non-fatal advisories, e.g. "endpoint http://10.0.0.5:1234 is not loopback".
   * Rendered as a warning badge, not an error (PLAN §7.1).
   */
  warnings: z.array(z.string()).default([]),
})
export type EngineStatus = z.infer<typeof EngineStatusSchema>

/** Whether a loopback sidecar binary is on disk (not whether it is running). */
export const SidecarBinaryStatusSchema = z.object({
  installed: z.boolean(),
  path: z.string().nullable().default(null),
})
export type SidecarBinaryStatus = z.infer<typeof SidecarBinaryStatusSchema>

/** Both slots at once — what `engines.status` returns and broadcasts. */
export const EnginesStatusSchema = z.object({
  stt: EngineStatusSchema,
  polish: EngineStatusSchema,
  /**
   * Sidecar binaries the UI can offer to install. Present so Models can hide
   * "Recommended" on polish when llama-server is missing, and show an Install button.
   */
  sidecars: z
    .object({
      whisper: SidecarBinaryStatusSchema,
      llama: SidecarBinaryStatusSchema,
    })
    .optional(),
})
export type EnginesStatus = z.infer<typeof EnginesStatusSchema>

export function createIdleEngineStatus(): EngineStatus {
  return EngineStatusSchema.parse({ state: 'idle' })
}

export function createEnginesStatus(): EnginesStatus {
  return { stt: createIdleEngineStatus(), polish: createIdleEngineStatus() }
}

// ---------------------------------------------------------------------------
// Transcripts
// ---------------------------------------------------------------------------

/** What every `SttEngine.transcribe` resolves to (PLAN §6.1). */
export const TranscriptSchema = z.object({
  text: z.string(),
  /** Mean per-token log probability where the engine reports one. */
  avgLogProb: z.number().nullable().default(null),
  /** Wall-clock milliseconds the engine spent on this utterance. */
  durationMs: z.number().nonnegative(),
})
export type Transcript = z.infer<typeof TranscriptSchema>
