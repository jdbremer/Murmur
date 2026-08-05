import { type z } from 'zod'
import { ModelCatalogSchema, type ModelCatalog, type ModelEntry } from './schema'

/**
 * Origin policy enforcement (PLAN §8).
 *
 * The policy is compiled into the app — it is *not* taken on trust from the
 * catalog file. A catalog declares its own `originPolicy`, and both of these
 * must hold before a single entry reaches the model picker:
 *
 *  1. the catalog's declared policy is a subset of {@link COMPILED_ORIGIN_POLICY},
 *     so a hand-edited file cannot widen the allowlist; and
 *  2. every entry's `origin` is inside that policy.
 *
 * Either failure throws {@link CatalogOriginPolicyError} naming what offended.
 */

/** The allowlist baked into the build. US-only, by owner decision (PLAN §8). */
export const COMPILED_ORIGIN_POLICY: readonly string[] = Object.freeze(['US'])

export class CatalogValidationError extends Error {
  override readonly name: string = 'CatalogValidationError'
  readonly issues: readonly string[]

  constructor(message: string, issues: readonly string[] = []) {
    super(message)
    this.issues = issues
  }
}

export class CatalogOriginPolicyError extends CatalogValidationError {
  override readonly name: string = 'CatalogOriginPolicyError'
  /** Catalog ids of the entries that failed the policy; empty if the catalog's
   *  declared policy itself was out of bounds. */
  readonly offendingModelIds: readonly string[]
  readonly allowedOrigins: readonly string[]

  constructor(
    message: string,
    offendingModelIds: readonly string[],
    allowedOrigins: readonly string[],
  ) {
    super(message)
    this.offendingModelIds = offendingModelIds
    this.allowedOrigins = allowedOrigins
  }
}

export interface ValidateCatalogOptions {
  /**
   * Origins this build will accept. Defaults to {@link COMPILED_ORIGIN_POLICY};
   * override only in tests.
   */
  allowedOrigins?: readonly string[]
  /**
   * Where the catalog came from, used in error messages
   * (e.g. `resources/catalog/models.json`).
   */
  source?: string
}

function describeEntry(entry: ModelEntry): string {
  return `"${entry.id}" (${entry.displayName}, org "${entry.org}", origin "${entry.origin}")`
}

/**
 * Parse and policy-check a catalog. Returns the catalog only if it is both
 * structurally valid and fully inside the origin allowlist.
 *
 * @throws {CatalogValidationError} on a malformed catalog.
 * @throws {CatalogOriginPolicyError} on an origin-policy violation.
 */
export function validateCatalog(
  input: unknown,
  options: ValidateCatalogOptions = {},
): ModelCatalog {
  const allowed = options.allowedOrigins ?? COMPILED_ORIGIN_POLICY
  const where = options.source ? ` (${options.source})` : ''

  const parsed = ModelCatalogSchema.safeParse(input)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '<root>'
      return `${path}: ${issue.message}`
    })
    throw new CatalogValidationError(
      `Model catalog${where} is malformed:\n  - ${issues.join('\n  - ')}`,
      issues,
    )
  }

  const catalog = parsed.data

  // 1. The catalog may narrow the compiled policy, never widen it.
  const widened = catalog.originPolicy.filter((origin) => !allowed.includes(origin))
  if (widened.length > 0) {
    throw new CatalogOriginPolicyError(
      `Model catalog${where} declares originPolicy [${catalog.originPolicy.join(', ')}], which ` +
        `includes ${widened.map((o) => `"${o}"`).join(', ')} outside this build's allowlist ` +
        `[${allowed.join(', ')}]. A catalog cannot widen the origin policy.`,
      [],
      allowed,
    )
  }

  // 2. Every entry must sit inside the (now verified) policy.
  const effective = catalog.originPolicy
  const offenders = catalog.models.filter((entry) => !effective.includes(entry.origin))
  if (offenders.length > 0) {
    const listed = offenders.map((entry) => `  - ${describeEntry(entry)}`).join('\n')
    throw new CatalogOriginPolicyError(
      `Model catalog${where} rejected by origin policy [${effective.join(', ')}]. ` +
        `${offenders.length} entr${offenders.length === 1 ? 'y is' : 'ies are'} out of policy:\n` +
        `${listed}\n` +
        `Murmur only lists models from allow-listed origins; see PLAN.md §8.`,
      offenders.map((entry) => entry.id),
      effective,
    )
  }

  // 3. Ids must be unique — the picker and the settings store key on them.
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const entry of catalog.models) {
    if (seen.has(entry.id)) duplicates.add(entry.id)
    seen.add(entry.id)
  }
  if (duplicates.size > 0) {
    throw new CatalogValidationError(
      `Model catalog${where} contains duplicate model ids: ${[...duplicates].join(', ')}`,
      [...duplicates],
    )
  }

  return catalog
}

/** Non-throwing variant for call sites that want to surface the error in UI. */
export function safeValidateCatalog(
  input: unknown,
  options: ValidateCatalogOptions = {},
): { ok: true; catalog: ModelCatalog } | { ok: false; error: CatalogValidationError } {
  try {
    return { ok: true, catalog: validateCatalog(input, options) }
  } catch (error) {
    if (error instanceof CatalogValidationError) return { ok: false, error }
    throw error
  }
}

/** An empty catalog with today's timestamp — used as a safe fallback. */
export function createEmptyCatalog(now: Date = new Date()): ModelCatalog {
  return ModelCatalogSchema.parse({
    schemaVersion: 1,
    updatedAt: now.toISOString(),
    originPolicy: [...COMPILED_ORIGIN_POLICY],
    models: [],
  } satisfies z.input<typeof ModelCatalogSchema>)
}
