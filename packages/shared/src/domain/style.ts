import { z } from 'zod'
import { AppCategorySchema, type AppCategory } from './dictation'
import { mergeDefined } from '../internal/merge'

/**
 * Per-app-category tone controls (PLAN §2.2.3, §9 `style_profiles`). The polish
 * prompt is assembled from the profile matching the frontmost app's category.
 */

/**
 * The tone range, matching the reference product's Styles.
 *
 * `neutral` is **deprecated** and kept in the enum for one reason: it was the
 * shipped default, so it is sitting in every existing `style_profiles` row on
 * disk and removing it would make those profiles fail to parse. It is not
 * offered for any category (see {@link formalityOptionsFor}) and
 * {@link healStyleProfiles} migrates it away on load.
 */
export const FormalitySchema = z.enum(['veryCasual', 'casual', 'neutral', 'formal', 'excited'])
export type Formality = z.infer<typeof FormalitySchema>

/**
 * Which tones a category offers — not every tone suits every destination, and
 * the asymmetry is copied from the reference product rather than invented:
 * Very Casual is personal-messaging only, and Email trades it for Excited.
 */
export function formalityOptionsFor(category: AppCategory): readonly Formality[] {
  switch (category) {
    case 'personal':
      return ['veryCasual', 'casual', 'formal', 'excited']
    case 'email':
      return ['casual', 'formal', 'excited']
    default:
      return ['casual', 'formal', 'excited']
  }
}

/**
 * The shipped tone per category: chatty where the writing is chatty, buttoned
 * up everywhere else. Matches the reference product's onboarding defaults.
 */
export function defaultFormalityFor(category: AppCategory): Formality {
  return category === 'personal' ? 'casual' : 'formal'
}

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

/** The shipped starting point: one profile per category, at that category's tone. */
export function createDefaultStyleProfiles(): StyleProfileSet {
  return AppCategorySchema.options.map((category) =>
    StyleProfileSchema.parse({ category, formality: defaultFormalityFor(category) }),
  )
}

/**
 * Migrate profiles whose tone the product no longer offers.
 *
 * Only `neutral` qualifies today. It was the shipped default for every
 * category, so almost every existing install has four of them; left alone they
 * would render as a Select with no matching option — the control would silently
 * display someone else's value and the first click would change a setting the
 * user never touched. Healing on load makes the stored state and the UI agree.
 *
 * Returns the same array when nothing changed, so a caller can cheaply tell
 * whether it needs to persist and log.
 */
export function healStyleProfiles(profiles: StyleProfileSet): StyleProfileSet {
  let changed = false
  const healed = profiles.map((profile) => {
    if (formalityOptionsFor(profile.category).includes(profile.formality)) return profile
    changed = true
    return { ...profile, formality: defaultFormalityFor(profile.category) }
  })
  return changed ? healed : profiles
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
