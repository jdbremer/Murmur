/**
 * The one piece of decode arithmetic that is ours rather than Chromium's.
 *
 * In its own DOM-free module so the unit tests can compile it under the node
 * tsconfig — `decoder.ts` needs `OfflineAudioContext` and friends, which do
 * not exist there.
 */

/**
 * Equal-weight downmix.
 *
 * A plain average, not a broadcast-standard matrix: the engines want speech
 * energy, not faithful imaging, and averaging is the one mix that cannot clip
 * what was not already clipped.
 */
export function mixToMono(channels: readonly Float32Array[], length: number): Float32Array {
  const first = channels[0]
  if (!first) return new Float32Array(0)
  if (channels.length === 1) {
    // Already mono — copy rather than alias, so the AudioBuffer can be freed.
    return first.slice(0, length)
  }
  const out = new Float32Array(length)
  for (const channel of channels) {
    for (let i = 0; i < length; i += 1) out[i] = (out[i] ?? 0) + (channel[i] ?? 0)
  }
  const scale = 1 / channels.length
  for (let i = 0; i < length; i += 1) out[i] = (out[i] ?? 0) * scale
  return out
}
