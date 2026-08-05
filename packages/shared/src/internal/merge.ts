/**
 * Overlay `patch` onto `base`, ignoring keys whose value is `undefined`.
 *
 * Sparse patches arrive from IPC as objects with genuinely-absent keys, but
 * spreading them (`{ ...base, ...patch }`) reintroduces those keys as
 * `undefined` and blows a hole in the merged type. This keeps the result
 * complete so it can be re-validated against the full schema.
 *
 * Internal to `@murmur/shared` — not part of the public surface.
 */
export function mergeDefined<T extends object>(base: T, patch: object): T {
  const merged: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) merged[key] = value
  }
  return merged as T
}
