import { z } from 'zod'

/**
 * Long-form meeting capture (PLAN §18.2) — the second, long-lived loop that
 * sits beside dictation.
 *
 * Deliberately its own vocabulary rather than an extension of
 * `domain/dictation`. A dictation is a few seconds long, ends in an injection
 * and one history row; a meeting runs for an hour, ends in a file, and can be
 * live *at the same time as* a dictation. Sharing `DictationEvent` would force
 * the Bar's single-state switch to render two concurrent things.
 */

/**
 * Which side of the conversation a segment came from.
 *
 * `me` is the microphone, `them` is the system-audio tap. Keeping them as
 * separate tracks rather than one mix is what gives speaker attribution for
 * free — and what makes the echo problem in `meeting/holdback.ts` tractable,
 * since the far end is available as a clean reference signal.
 */
export const MeetingTrackSchema = z.enum(['me', 'them'])
export type MeetingTrack = z.infer<typeof MeetingTrackSchema>

/** How system audio is being captured, or why it is not. */
export const SystemAudioModeSchema = z.enum([
  /** macOS 14.2+ CoreAudio process tap. */
  'native',
  /** Windows WASAPI loopback via Electron's `audio: 'loopback'`. */
  'loopback',
  /** Platform or OS version cannot do it; meetings run mic-only. */
  'unsupported',
])
export type SystemAudioMode = z.infer<typeof SystemAudioModeSchema>

/**
 * System-audio permission, learned by probing rather than asked.
 *
 * macOS exposes no API to query `kTCCServiceAudioCapture`, so the only honest
 * check is to attempt a tap and watch what happens. The result is persisted
 * because re-probing would re-prompt.
 */
export const SystemAudioAccessSchema = z.object({
  mode: SystemAudioModeSchema,
  status: z.enum(['granted', 'denied', 'unknown', 'unavailable']),
  /** Why it is unavailable, for UI that has to explain itself. */
  detail: z.string().default(''),
})
export type SystemAudioAccess = z.infer<typeof SystemAudioAccessSchema>

// ---------------------------------------------------------------------------
// Segments
// ---------------------------------------------------------------------------

/** One transcribed slice of one track. */
export const MeetingSegmentSchema = z.object({
  id: z.string().min(1),
  track: MeetingTrackSchema,
  /** Milliseconds from the start of the recording, not epoch. */
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().nonnegative(),
  text: z.string(),
})
export type MeetingSegment = z.infer<typeof MeetingSegmentSchema>

// ---------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------

export const MeetingRecordSchema = z.object({
  id: z.string().min(1),
  /** Epoch milliseconds when recording began. */
  startedAt: z.number().int().nonnegative(),
  /** `null` while still recording. */
  endedAt: z.number().int().nonnegative().nullable(),
  title: z.string().min(1),
  /** Absolute path to the Markdown transcript. */
  path: z.string().min(1),
  /** Bundle id of the app the meeting was detected in, if any. */
  appBundleId: z.string().min(1).nullable(),
  /** Whether the far side was captured, or only the microphone. */
  hadSystemAudio: z.boolean(),
  segmentCount: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
})
export type MeetingRecord = z.infer<typeof MeetingRecordSchema>

export const MeetingListSchema = z.object({ meetings: z.array(MeetingRecordSchema) })
export type MeetingList = z.infer<typeof MeetingListSchema>

// ---------------------------------------------------------------------------
// Live state
// ---------------------------------------------------------------------------

/**
 * What the recorder is doing right now, broadcast to every window.
 *
 * A flat discriminated union on `state`, the same shape as `DictationEvent`,
 * so the Bar and Hub can switch on it without a second lookup.
 */
export const MeetingEventSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('idle') }),
  /**
   * A meeting was detected and the user has not answered yet. Carries enough
   * to render the prompt without a round-trip.
   */
  z.object({
    state: z.literal('offered'),
    title: z.string(),
    appBundleId: z.string().nullable(),
  }),
  z.object({
    state: z.literal('recording'),
    id: z.string().min(1),
    title: z.string(),
    /** Milliseconds since recording began, for the elapsed readout. */
    elapsedMs: z.number().int().nonnegative(),
    segmentCount: z.number().int().nonnegative(),
    /** False when the tap failed or was denied and this is mic-only. */
    hasSystemAudio: z.boolean(),
    /**
     * Set when transcription is failing but capture continues. The recording
     * is still worth keeping; the transcript gets a gap marker.
     */
    degraded: z.string().nullable(),
  }),
  z.object({
    state: z.literal('finishing'),
    id: z.string().min(1),
    title: z.string(),
  }),
  z.object({
    state: z.literal('error'),
    message: z.string().min(1),
  }),
])
export type MeetingEvent = z.infer<typeof MeetingEventSchema>

export const MEETING_IDLE: MeetingEvent = Object.freeze({ state: 'idle' })

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export const MeetingStartRequestSchema = z.object({
  /** Overrides the detected/derived name. Blank falls back to the default. */
  title: z.string().default(''),
  appBundleId: z.string().min(1).nullable().default(null),
})
export type MeetingStartRequest = z.infer<typeof MeetingStartRequestSchema>

/** The answer to a detection prompt. */
export const MeetingOfferResponseSchema = z.object({
  accept: z.boolean(),
  /** Remember this answer for the offering app, so it stops asking. */
  remember: z.boolean().default(false),
})
export type MeetingOfferResponse = z.infer<typeof MeetingOfferResponseSchema>
