/**
 * Decode an audio or video file to the pipeline's native format — 16 kHz mono
 * Float32 PCM (PLAN §18.4).
 *
 * This lives in the renderer on purpose: Chromium's media stack is the only
 * decoder in the app that reads MP3, AAC/MP4 and friends, and it is already
 * shipped. Bundling ffmpeg to do the same job in main would add ~25 MB per
 * platform to decode formats Electron decodes for free.
 *
 * The resampling is free too: `decodeAudioData` resamples to its context's
 * rate, so decoding through a 16 kHz `OfflineAudioContext` hands back exactly
 * what the engines eat — no second pass, no resampler of our own.
 *
 * ## Memory, honestly
 *
 * `decodeAudioData` is all-or-nothing: the whole file decodes into memory at
 * once. At 16 kHz that is ~3.8 MB per channel-minute — a two-hour stereo
 * podcast is ~920 MB transiently, halved once it is mixed down to mono. The
 * caps below are where "let it try" would tip into "crash the Hub renderer",
 * and they are enforced *before* the big allocation: the duration probe reads
 * only metadata, so a nine-hour file is refused for the price of a header.
 */

import { mixToMono } from './downmix'

/** Refuse containers bigger than this before even reading them into memory. */
export const MAX_FILE_BYTES = 2 * 1024 ** 3
/** Refuse audio longer than this; see the memory note above. */
export const MAX_DURATION_MS = 4 * 3_600_000

/** What the drop zone advertises. Chromium decodes more; these are the safe promises. */
export const ACCEPTED_EXTENSIONS = [
  '.mp3',
  '.mp4',
  '.m4a',
  '.wav',
  '.aac',
  '.flac',
  '.ogg',
  '.oga',
  '.opus',
  '.webm',
  '.mov',
  '.aiff',
  '.aif',
] as const

export const FILE_INPUT_ACCEPT = [...ACCEPTED_EXTENSIONS, 'audio/*', 'video/*'].join(',')

export interface DecodedAudio {
  /** 16 kHz mono Float32 PCM. */
  pcm: Float32Array
  durationMs: number
}

export async function decodeFileToPcm(file: File): Promise<DecodedAudio> {
  if (file.size > MAX_FILE_BYTES) {
    throw new Error(
      `${file.name} is ${Math.round(file.size / 1024 ** 3)} GB — files over 2 GB cannot be read in one piece.`,
    )
  }

  // Cheap gate first: metadata only, no decode, no big allocation.
  const probedMs = await probeDurationMs(file)
  if (probedMs !== null && probedMs > MAX_DURATION_MS) {
    throw new Error(
      `${file.name} is ${Math.round(probedMs / 3_600_000)} hours long — the limit is 4 hours per file.`,
    )
  }

  const bytes = await file.arrayBuffer()

  // Rate 16 000 is the decode target; the channel count and length arguments
  // describe a render this context never performs.
  const context = new OfflineAudioContext(1, 1, 16_000)
  let decoded: AudioBuffer
  try {
    decoded = await context.decodeAudioData(bytes)
  } catch {
    throw new Error(
      `Murmur could not read audio from ${file.name}. It handles MP3, MP4/M4A, WAV, FLAC, OGG/Opus, WebM, MOV and AIFF.`,
    )
  }

  const durationMs = decoded.duration * 1000
  // The probe can miss (some containers report no metadata to <audio>), so the
  // cap is re-checked against the authoritative number.
  if (durationMs > MAX_DURATION_MS) {
    throw new Error(
      `${file.name} is ${Math.round(durationMs / 3_600_000)} hours long — the limit is 4 hours per file.`,
    )
  }
  if (decoded.length === 0) {
    throw new Error(`${file.name} contains no audio.`)
  }

  const channels: Float32Array[] = []
  for (let channel = 0; channel < decoded.numberOfChannels; channel += 1) {
    channels.push(decoded.getChannelData(channel))
  }

  return { pcm: mixToMono(channels, decoded.length), durationMs }
}

/**
 * Duration from container metadata alone, or `null` when the element cannot
 * say — an unreadable answer is not an error here, because `decodeAudioData`
 * is the authority and gets its own chance to object.
 */
function probeDurationMs(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file)
    const audio = new Audio()
    audio.preload = 'metadata'

    const finish = (value: number | null): void => {
      URL.revokeObjectURL(url)
      audio.removeAttribute('src')
      resolve(value)
    }

    audio.onloadedmetadata = () => {
      const { duration } = audio
      finish(Number.isFinite(duration) ? duration * 1000 : null)
    }
    audio.onerror = () => finish(null)
    audio.src = url
  })
}
