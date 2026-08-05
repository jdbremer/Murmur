import { z } from 'zod'
import { mergeDefined } from '../internal/merge'

/**
 * User-facing settings (PLAN §2.2 "Settings", §9 `settings` table).
 *
 * Every field carries a shipped default so `SettingsSchema.parse({})` yields a
 * complete, valid `Settings` — that is how the main-process store bootstraps and
 * how it heals a settings.json that predates a new field.
 */

// ---------------------------------------------------------------------------
// Hotkey
// ---------------------------------------------------------------------------

/**
 * Which physical key holds-to-talk. `fn` is the default (matches the reference
 * UX); the right-hand modifiers exist for external keyboards that have no `fn`.
 * `custom` defers to {@link HotkeyConfig.customKeyCode}.
 */
export const HotkeyKeySchema = z.enum(['fn', 'rightCmd', 'rightOpt', 'custom'])
export type HotkeyKey = z.infer<typeof HotkeyKeySchema>

/** `hold` = push-to-talk; `toggle` = press once to start, again to stop. */
export const HotkeyActivationSchema = z.enum(['hold', 'toggle'])
export type HotkeyActivation = z.infer<typeof HotkeyActivationSchema>

export const HotkeyConfigSchema = z.object({
  key: HotkeyKeySchema.default('fn'),
  /** macOS virtual key code; only meaningful when `key === 'custom'`. */
  customKeyCode: z.number().int().nonnegative().nullable().default(null),
  activation: HotkeyActivationSchema.default('hold'),
  /** Double-tapping the hotkey latches hands-free dictation (PLAN §2.1). */
  doubleTapHandsFree: z.boolean().default(true),
})
export type HotkeyConfig = z.infer<typeof HotkeyConfigSchema>

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

/** `off` deletes immediately after use; `days` keeps a rolling window. */
export const RetentionPolicySchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('off') }),
  z.object({ mode: z.literal('days'), days: z.number().int().positive().max(3650) }),
])
export type RetentionPolicy = z.infer<typeof RetentionPolicySchema>

// ---------------------------------------------------------------------------
// Polishing / appearance
// ---------------------------------------------------------------------------

/** PLAN §2.2: Off (raw transcript) / Clean (punctuation, fillers) / Rewrite (tone). */
export const PolishingLevelSchema = z.enum(['off', 'clean', 'rewrite'])
export type PolishingLevel = z.infer<typeof PolishingLevelSchema>

/** PLAN §2.1 visibility modes for the floating Bar. */
export const BarVisibilitySchema = z.enum(['showWhileDictating', 'always', 'hidden'])
export type BarVisibility = z.infer<typeof BarVisibilitySchema>

export const AppearanceSchema = z.enum(['system', 'light', 'dark'])
export type Appearance = z.infer<typeof AppearanceSchema>

/**
 * An OpenAI-compatible endpoint to use for polishing instead of the bundled
 * llama-server (PLAN §7.1). Callers must still enforce the loopback/RFC-1918
 * warning — this schema only describes the shape.
 */
export const ExternalEndpointSchema = z.object({
  baseUrl: z.url(),
  apiKey: z.string().min(1).nullable().default(null),
  model: z.string().min(1),
})
export type ExternalEndpoint = z.infer<typeof ExternalEndpointSchema>

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/**
 * The settings shape *without* defaults. Declared once so the full schema and
 * the patch schema can never drift apart.
 *
 * Note (zod v4 gotcha): `.partial()` does **not** strip `.default()`s — a
 * partial built from a defaulted object still materialises every default, which
 * would make a patch overwrite untouched fields. Hence the split below.
 */
const settingsFields = {
  hotkey: HotkeyConfigSchema,
  /** `MediaDeviceInfo.deviceId`; `null` = system default input. */
  micDeviceId: z.string().min(1).nullable(),
  /** BCP-47-ish tag, or `auto` where the model detects language natively. */
  language: z.string().min(2),
  polishingLevel: PolishingLevelSchema,
  /** Audio is memory-only unless the user opts in (PLAN §10.4). */
  audioRetention: RetentionPolicySchema,
  historyRetention: RetentionPolicySchema,
  launchAtLogin: z.boolean(),
  barVisibility: BarVisibilitySchema,
  /** Catalog id of the active STT model; `null` until onboarding picks one. */
  sttModelId: z.string().min(1).nullable(),
  /** Catalog id of the active polish model; `null` when polishing is off. */
  polishModelId: z.string().min(1).nullable(),
  externalEndpoint: ExternalEndpointSchema.nullable(),
  appearance: AppearanceSchema,
} as const

/** Full settings: unknown/missing keys fall back to the shipped defaults. */
export const SettingsSchema = z.object({
  hotkey: settingsFields.hotkey.default(() => HotkeyConfigSchema.parse({})),
  micDeviceId: settingsFields.micDeviceId.default(null),
  language: settingsFields.language.default('en'),
  polishingLevel: settingsFields.polishingLevel.default('clean'),
  audioRetention: settingsFields.audioRetention.default(() => ({ mode: 'off' as const })),
  historyRetention: settingsFields.historyRetention.default(() => ({
    mode: 'days' as const,
    days: 90,
  })),
  launchAtLogin: settingsFields.launchAtLogin.default(false),
  barVisibility: settingsFields.barVisibility.default('showWhileDictating'),
  sttModelId: settingsFields.sttModelId.default(null),
  polishModelId: settingsFields.polishModelId.default(null),
  externalEndpoint: settingsFields.externalEndpoint.default(null),
  appearance: settingsFields.appearance.default('system'),
})
export type Settings = z.infer<typeof SettingsSchema>

/**
 * A sparse update. Omitted keys are left untouched; nested objects
 * (`hotkey`, `externalEndpoint`) are replaced wholesale, not deep-merged.
 */
export const SettingsPatchSchema = z.object(settingsFields).partial()
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>

/** A fresh, mutable copy of the shipped defaults. */
export function createDefaultSettings(): Settings {
  return SettingsSchema.parse({})
}

/** Apply a sparse patch to a settings object and re-validate the result. */
export function applySettingsPatch(current: Settings, patch: SettingsPatch): Settings {
  return SettingsSchema.parse(mergeDefined(current, patch))
}
