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
 * Which physical key / chord holds-to-talk.
 *
 * macOS presets: `fn` (default), `rightCmd`, `rightOpt`.
 * Windows presets (PLAN §4.1 / overnight lock): `rightCtrl` (default on win32),
 * `ctrlSpace`, `altSpace`, `capsLock`.
 * `custom` defers to {@link HotkeyConfig.customKeyCode}.
 *
 * One shared enum keeps `settings.json` portable across OSes; the Settings UI
 * and native backends filter to the keys they support.
 */
export const HotkeyKeySchema = z.enum([
  'fn',
  'rightCmd',
  'rightOpt',
  'rightCtrl',
  'ctrlSpace',
  'altSpace',
  'capsLock',
  'custom',
])
export type HotkeyKey = z.infer<typeof HotkeyKeySchema>

/** Presets shown on macOS (no Windows chords). */
export const MAC_HOTKEY_KEYS = [
  'fn',
  'rightCmd',
  'rightOpt',
  'custom',
] as const satisfies readonly HotkeyKey[]

/** Presets shown on Windows (no fn / ⌘ / ⌥). Overnight default: Right Ctrl. */
export const WINDOWS_HOTKEY_KEYS = [
  'rightCtrl',
  'ctrlSpace',
  'altSpace',
  'capsLock',
  'custom',
] as const satisfies readonly HotkeyKey[]

/** True when `key` is a macOS-only preset that must not surface on Windows. */
export function isMacOnlyHotkeyKey(key: HotkeyKey): boolean {
  return key === 'fn' || key === 'rightCmd' || key === 'rightOpt'
}

/** True when `key` is a Windows-only preset that macOS cannot install. */
export function isWindowsOnlyHotkeyKey(key: HotkeyKey): boolean {
  return key === 'rightCtrl' || key === 'ctrlSpace' || key === 'altSpace' || key === 'capsLock'
}

/** Shipped Windows default hotkey (DEFINITION-OF-DONE overnight lock). */
export const WINDOWS_DEFAULT_HOTKEY_KEY: HotkeyKey = 'rightCtrl'

/** Shipped macOS default hotkey (PLAN §2.1). */
export const MAC_DEFAULT_HOTKEY_KEY: HotkeyKey = 'fn'

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

/** True when `custom` was chosen without a key code — native cannot install a hook. */
export function isIncompleteCustomHotkey(hotkey: HotkeyConfig): boolean {
  return hotkey.key === 'custom' && (hotkey.customKeyCode === null || hotkey.customKeyCode < 0)
}

/** Space-swallowing chords — easy to leave Space stuck if a hold fails mid-key. */
export function isSpaceChordHotkey(key: HotkeyKey): boolean {
  return key === 'ctrlSpace' || key === 'altSpace'
}

/**
 * Heal a hotkey config so the native module never throws at boot.
 * Pass `process.platform` from the main process (shared stays Node-free).
 *
 * `settings.json` is deliberately portable across OSes, which means a config
 * can arrive on a machine whose native backend cannot install it — synced
 * between a work Windows box and a personal Mac, or carried by Migration
 * Assistant. Healing has to run in *both* directions: a key the platform
 * cannot bind produces no hook and no error, so the app looks configured and
 * silently never dictates.
 *
 * On Windows we also migrate Ctrl+Space / Alt+Space → Right Ctrl: swallowing
 * Space system-wide is too risky until the hook is rock-solid.
 */
export function sanitizeHotkeyForPlatform(hotkey: HotkeyConfig, platform: string): HotkeyConfig {
  const isWindows = platform === 'win32'
  const platformDefault = isWindows ? WINDOWS_DEFAULT_HOTKEY_KEY : MAC_DEFAULT_HOTKEY_KEY

  if (isIncompleteCustomHotkey(hotkey)) {
    return { ...hotkey, key: platformDefault, customKeyCode: null }
  }
  if (isWindows && (isMacOnlyHotkeyKey(hotkey.key) || isSpaceChordHotkey(hotkey.key))) {
    return { ...hotkey, key: WINDOWS_DEFAULT_HOTKEY_KEY, customKeyCode: null }
  }
  // Non-Windows: a Windows-only preset can never fire here. Note this also
  // covers Linux, where nothing fires either way — healing to `fn` at least
  // leaves the stored key honest about what this build would bind.
  if (!isWindows && isWindowsOnlyHotkeyKey(hotkey.key)) {
    return { ...hotkey, key: MAC_DEFAULT_HOTKEY_KEY, customKeyCode: null }
  }
  // A custom key code is a per-OS value: macOS stores a CGKeyCode, Windows a
  // Win32 VK. The same number means a different physical key on the other
  // platform, so a synced `custom` binding is not portable.
  return hotkey
}

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
  /**
   * False until the first-run sequence finishes (PLAN §2.4). The Hub renders
   * onboarding instead of its sections while this is false, so the flag lives
   * with the rest of the persisted state rather than in a marker file.
   */
  onboardingCompleted: z.boolean(),
  /**
   * Command mode (PLAN §18.1): holding the dictation key with text selected
   * treats the utterance as an edit instruction and rewrites the selection in
   * place. On by default — it is the reference product's flagship gesture.
   */
  commandModeEnabled: z.boolean(),
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
  onboardingCompleted: settingsFields.onboardingCompleted.default(false),
  commandModeEnabled: settingsFields.commandModeEnabled.default(true),
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
