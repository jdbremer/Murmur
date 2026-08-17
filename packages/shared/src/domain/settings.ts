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

/**
 * Presets shown on Linux/X11.
 *
 * Narrower than either of the others, and for a reason that is structural
 * rather than stylistic: XRecord is listen-only, so the Linux backend cannot
 * swallow a key. Every preset whose contract depends on suppression is out —
 * Caps Lock would toggle caps on each dictation, and the Space chords would
 * type a space. `fn` never reaches X at all (the firmware consumes it). What
 * remains is the three right-hand modifiers, which no platform suppresses
 * anyway, plus a custom keycode the user has chosen knowing it still types.
 */
export const LINUX_HOTKEY_KEYS = [
  'rightCtrl',
  'rightOpt',
  'rightCmd',
  'custom',
] as const satisfies readonly HotkeyKey[]

/** True when `key` is one the Linux/X11 backend can actually bind. */
export function isLinuxSupportedHotkeyKey(key: HotkeyKey): boolean {
  return (LINUX_HOTKEY_KEYS as readonly HotkeyKey[]).includes(key)
}

/** Shipped Linux default hotkey — Right Ctrl, as on Windows. */
export const LINUX_DEFAULT_HOTKEY_KEY: HotkeyKey = 'rightCtrl'

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
  const isLinux = platform === 'linux'
  const platformDefault = isWindows
    ? WINDOWS_DEFAULT_HOTKEY_KEY
    : isLinux
      ? LINUX_DEFAULT_HOTKEY_KEY
      : MAC_DEFAULT_HOTKEY_KEY

  if (isIncompleteCustomHotkey(hotkey)) {
    return { ...hotkey, key: platformDefault, customKeyCode: null }
  }
  // Linux is checked against an allow-list rather than the two deny-lists: its
  // supported set straddles both (Right Ctrl is "Windows-only", Right Super and
  // Right Alt are "Mac-only"), so either deny-list would heal away a key X11
  // binds perfectly well.
  if (isLinux) {
    if (!isLinuxSupportedHotkeyKey(hotkey.key)) {
      return { ...hotkey, key: LINUX_DEFAULT_HOTKEY_KEY, customKeyCode: null }
    }
    return hotkey
  }
  if (isWindows && (isMacOnlyHotkeyKey(hotkey.key) || isSpaceChordHotkey(hotkey.key))) {
    return { ...hotkey, key: WINDOWS_DEFAULT_HOTKEY_KEY, customKeyCode: null }
  }
  if (!isWindows && isWindowsOnlyHotkeyKey(hotkey.key)) {
    return { ...hotkey, key: MAC_DEFAULT_HOTKEY_KEY, customKeyCode: null }
  }
  // A custom key code is a per-OS value: macOS stores a CGKeyCode, Windows a
  // Win32 VK, Linux an X11 keycode. The same number means a different physical
  // key on each, so a synced `custom` binding is not portable.
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

/**
 * PLAN §2.1 visibility modes for the floating Bar.
 *
 * Defaults to `always` — the resting sliver is on screen from launch, and
 * turning it off is a choice the user makes rather than one they have to
 * discover. An indicator that only exists while it is already too late to look
 * at it teaches nobody where dictation lives; at 44 × 8 px of translucent
 * hairline it costs almost nothing to leave on.
 */
export const BarVisibilitySchema = z.enum(['showWhileDictating', 'always', 'hidden'])
export type BarVisibility = z.infer<typeof BarVisibilitySchema>

/**
 * Which shape the dictation indicator takes.
 *
 * `pill` is the bottom-centre capsule of PLAN §2.1. `corner` is the same state
 * machine drawn as a small orb that peeks out from behind a bottom corner of
 * the screen — far less of the screen covered, at the cost of the error text
 * having nowhere to sit until you look at it.
 *
 * One enum rather than a boolean because a third shape is plausible (a
 * menu-bar-adjacent drop, a top-centre notch) and a `barIsCorner` flag would
 * have to be migrated the day one arrives.
 */
export const BarStyleSchema = z.enum(['pill', 'corner'])
export type BarStyle = z.infer<typeof BarStyleSchema>

/** Which corner the `corner` style peeks out of. Ignored by the pill. */
export const BarCornerSchema = z.enum(['bottomLeft', 'bottomRight'])
export type BarCorner = z.infer<typeof BarCornerSchema>

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
// Meetings
// ---------------------------------------------------------------------------

/**
 * Long-form meeting capture (PLAN §18.2).
 *
 * **Off by default, and "off" means inert rather than quiet.** With `enabled`
 * false nothing polls, no window title is read, no capture lease is taken, no
 * tap subprocess is spawned, and the system-audio permission is never
 * requested — a user who never turns this on is never even asked for a fourth
 * permission. `autoDetect` is a second switch so manual recording is usable
 * without any process polling at all.
 */
export const MeetingSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  /** Watch for meetings and offer to record. Requires `enabled`. */
  autoDetect: z.boolean().default(false),
  /**
   * Where transcripts are written. `null` means
   * `~/Documents/Murmur Meetings` — resolved in main, because this package
   * may not touch Node built-ins.
   */
  folder: z.string().min(1).nullable().default(null),
  /**
   * Keep the recorded audio beside the transcript. Deliberately separate from
   * `audioRetention`, which is about dictation: one switch controlling both a
   * few MB of utterances and a 350 MB meeting WAV would be a bad control.
   */
  keepAudio: z.boolean().default(false),
  /**
   * Per-bundle-id answers remembered from the consent prompt, so a user who
   * said "always" for Zoom is not asked again.
   */
  autoRecord: z.record(z.string(), z.enum(['ask', 'always', 'never'])).default({}),
})
export type MeetingSettings = z.infer<typeof MeetingSettingsSchema>

/**
 * Updates (PLAN §10.2).
 *
 * The one place Murmur reaches the network without being asked in the moment,
 * and the reason the privacy copy in Help names it explicitly rather than
 * claiming nothing is ever automatic. What a check discloses to GitHub is one
 * HTTPS request for a small YAML feed — which reveals this machine's IP, the
 * running version, and roughly when it is awake. That is a real if modest
 * disclosure, so it gets a switch, and the switch is named in Help next to the
 * sentence describing the traffic.
 *
 * On by default all the same: a dictation tool that silently rots three
 * versions behind, on a machine whose owner never thinks to look, is the worse
 * outcome — and the update is how they get every fix.
 */
export const UpdateSettingsSchema = z.object({
  /** Check on launch and every few hours. Off means the button is the only path. */
  checkAutomatically: z.boolean().default(true),
  /**
   * Fetch the installer as soon as one is found, so the user only has to
   * restart. Requires `checkAutomatically` — there is nothing to download
   * automatically if nothing looks automatically.
   */
  autoDownload: z.boolean().default(true),
})
export type UpdateSettings = z.infer<typeof UpdateSettingsSchema>

// ---------------------------------------------------------------------------
// Vibe coding
// ---------------------------------------------------------------------------

/**
 * Reading the editor you are dictating into (PLAN §18.3).
 *
 * **Both switches are off by default, and off means nothing is read.** This is
 * the one feature in Murmur that looks at screen content, so it is opt-in twice
 * over: the user turns it on, *and* has to turn on their IDE's own Screen
 * Reader Accessibility Mode before the editor exposes any text at all.
 *
 * Scoped to three bundle ids (VS Code, Cursor, Windsurf) in `code-context.ts`.
 * Nothing extracted is stored, logged, or sent anywhere — see that file for the
 * full set of gates and why each one is where it is.
 */
export const VibeCodingSettingsSchema = z.object({
  /** Feed identifiers from the open file to recognition. */
  variableRecognition: z.boolean().default(false),
  /**
   * Rewrite spoken filenames to the real ones, and prefix `@` in Cursor and
   * Windsurf so their chat attaches the file. Requires `variableRecognition`,
   * because it is the editor read that supplies the list of real filenames.
   */
  fileTagging: z.boolean().default(false),
})
export type VibeCodingSettings = z.infer<typeof VibeCodingSettingsSchema>

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
  barStyle: BarStyleSchema,
  barCorner: BarCornerSchema,
  /**
   * The flourish that marks the two moments the user cannot see for
   * themselves: a ring blooming outward when dictation starts and collapsing
   * inward when it stops.
   *
   * On by default, and suppressed entirely under Reduce Motion — it is pure
   * travel-and-scale, which is exactly what that preference is about.
   */
  barFlourish: z.boolean(),
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
  /**
   * The two-note cue that marks the start and end of an utterance (PLAN §2.1).
   * On by default: with the Bar set to Hidden it is the only confirmation that
   * the key press registered at all, and the ear notices a missing sound long
   * before the eye notices a missing pill.
   */
  soundCuesEnabled: z.boolean(),
  /** Long-form meeting capture. Off by default — see {@link MeetingSettingsSchema}. */
  meetings: MeetingSettingsSchema,
  /**
   * Keep the per-app tally behind the Insights section's breakdown.
   *
   * On by default, because an Insights tab that is empty until you find a
   * switch is not a feature. Narrower than it sounds: the counters live in the
   * same local database as everything else, never leave the machine, and the
   * word/streak totals Murmur has always kept are unaffected by this flag —
   * only "which apps, how often" is. Settings offers a reset that zeroes the
   * lot without deleting a single transcript.
   */
  insightsEnabled: z.boolean(),
  /** Code-aware dictation. Off by default — see {@link VibeCodingSettingsSchema}. */
  vibeCoding: VibeCodingSettingsSchema,
  /** Automatic update checks and downloads — see {@link UpdateSettingsSchema}. */
  updates: UpdateSettingsSchema,
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
  barVisibility: settingsFields.barVisibility.default('always'),
  barStyle: settingsFields.barStyle.default('pill'),
  barCorner: settingsFields.barCorner.default('bottomLeft'),
  barFlourish: settingsFields.barFlourish.default(true),
  sttModelId: settingsFields.sttModelId.default(null),
  polishModelId: settingsFields.polishModelId.default(null),
  externalEndpoint: settingsFields.externalEndpoint.default(null),
  appearance: settingsFields.appearance.default('system'),
  onboardingCompleted: settingsFields.onboardingCompleted.default(false),
  commandModeEnabled: settingsFields.commandModeEnabled.default(true),
  soundCuesEnabled: settingsFields.soundCuesEnabled.default(true),
  meetings: settingsFields.meetings.default(() => MeetingSettingsSchema.parse({})),
  insightsEnabled: settingsFields.insightsEnabled.default(true),
  vibeCoding: settingsFields.vibeCoding.default(() => VibeCodingSettingsSchema.parse({})),
  updates: settingsFields.updates.default(() => UpdateSettingsSchema.parse({})),
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
