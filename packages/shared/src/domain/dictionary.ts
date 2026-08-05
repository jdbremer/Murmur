import { z } from 'zod'

/**
 * User vocabulary (PLAN §2.2.2, §9 `dictionary`).
 *
 * A `null` replacement means "boost this term only" — it steers recognition
 * (Whisper's `initial_prompt`; shallow-fusion biasing on the ONNX Runtime path
 * is backlogged, PLAN §18.12) and seeds the polish prompt, but never rewrites
 * text on its own. A non-null replacement additionally runs as a post-STT
 * substitution.
 */
export const DictionaryEntrySchema = z.object({
  id: z.string().min(1),
  term: z.string().min(1),
  replacement: z.string().min(1).nullable(),
  enabled: z.boolean(),
})
export type DictionaryEntry = z.infer<typeof DictionaryEntrySchema>

/** Fields accepted when creating an entry; the store assigns the id. */
export const DictionaryEntryDraftSchema = DictionaryEntrySchema.omit({ id: true }).extend({
  enabled: z.boolean().default(true),
})
export type DictionaryEntryDraft = z.infer<typeof DictionaryEntryDraftSchema>

/** Sparse update to an existing entry. */
export const DictionaryEntryPatchSchema = z
  .object({
    term: z.string().min(1),
    replacement: z.string().min(1).nullable(),
    enabled: z.boolean(),
  })
  .partial()
export type DictionaryEntryPatch = z.infer<typeof DictionaryEntryPatchSchema>
