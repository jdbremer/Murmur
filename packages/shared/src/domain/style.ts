import { z } from 'zod'
import { AppCategorySchema } from './dictation'
import { mergeDefined } from '../internal/merge'

/**
 * Per-app-category tone controls (PLAN §2.2.3, §9 `style_profiles`). The polish
 * prompt is assembled from the profile matching the frontmost app's category.
 */

export const FormalitySchema = z.enum(['casual', 'neutral', 'formal'])
export type Formality = z.infer<typeof FormalitySchema>

/** What to do with "um", "uh", "like", and false starts. */
export const FillerHandlingSchema = z.enum(['keep', 'trim', 'remove'])
export type FillerHandling = z.infer<typeof FillerHandlingSchema>

export const EmojiPolicySchema = z.enum(['never', 'preserve', 'allow'])
export type EmojiPolicy = z.infer<typeof EmojiPolicySchema>

const styleProfileFields = {
  category: AppCategorySchema,
  formality: FormalitySchema,
  fillerHandling: FillerHandlingSchema,
  emoji: EmojiPolicySchema,
  /** Free-text appended to the system prompt for this category. */
  customInstructions: z.string().max(2000),
} as const

export const StyleProfileSchema = z.object({
  category: styleProfileFields.category,
  formality: styleProfileFields.formality.default('neutral'),
  fillerHandling: styleProfileFields.fillerHandling.default('remove'),
  emoji: styleProfileFields.emoji.default('preserve'),
  customInstructions: styleProfileFields.customInstructions.default(''),
})
export type StyleProfile = z.infer<typeof StyleProfileSchema>

/** Sparse update; `category` identifies the profile and cannot be patched. */
export const StyleProfilePatchSchema = z
  .object(styleProfileFields)
  .omit({ category: true })
  .partial()
  .extend({ category: styleProfileFields.category })
export type StyleProfilePatch = z.infer<typeof StyleProfilePatchSchema>

/** One profile per category, always complete. */
export const StyleProfileSetSchema = z.array(StyleProfileSchema)
export type StyleProfileSet = z.infer<typeof StyleProfileSetSchema>

/** The shipped starting point: one neutral profile per category. */
export function createDefaultStyleProfiles(): StyleProfileSet {
  return AppCategorySchema.options.map((category) => StyleProfileSchema.parse({ category }))
}

/**
 * Apply a sparse patch to the profile it names, leaving the others untouched.
 * The result is re-validated, so a bad patch cannot corrupt the set.
 */
export function applyStyleProfilePatch(
  profiles: StyleProfileSet,
  patch: StyleProfilePatch,
): StyleProfileSet {
  return profiles.map((profile) =>
    profile.category === patch.category
      ? StyleProfileSchema.parse(mergeDefined(profile, patch))
      : profile,
  )
}
