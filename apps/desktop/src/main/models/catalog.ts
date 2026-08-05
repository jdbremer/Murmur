import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { createEmptyCatalog, validateCatalog, type ModelCatalog } from '@murmur/shared'

/**
 * Loads `resources/catalog/models.json` and puts it through the origin policy
 * (PLAN §8). This is the enforcement point: a catalog that fails validation is
 * discarded wholesale in favour of an empty one, so a tampered or mirrored file
 * cannot get a single out-of-policy model into the picker.
 *
 * Stage 2 adds signature verification and catalog refresh; the shape it returns
 * does not change.
 */

export interface LoadedCatalog {
  catalog: ModelCatalog
  /** Where it came from, or `null` when nothing loadable was found. */
  path: string | null
  /** Populated when validation failed — surface this in the Models section. */
  error: string | null
}

/**
 * Candidate locations, in priority order.
 *
 * @param appPath  `app.getAppPath()` — `apps/desktop` in dev, the asar root when packaged.
 * @param resourcesPath `process.resourcesPath` — where electron-builder's
 *   `extraResources` land in a packaged app.
 */
export function catalogSearchPaths(appPath: string, resourcesPath: string): string[] {
  const paths: string[] = []

  const override = process.env['MURMUR_CATALOG_PATH']
  if (override) paths.push(override)

  // Packaged: Contents/Resources/catalog/models.json
  paths.push(join(resourcesPath, 'catalog', 'models.json'))
  // Dev: <repo>/resources/catalog/models.json, two levels up from apps/desktop
  paths.push(join(appPath, '..', '..', 'resources', 'catalog', 'models.json'))

  return paths
}

export function loadCatalog(appPath: string, resourcesPath: string): LoadedCatalog {
  const candidates = catalogSearchPaths(appPath, resourcesPath)

  for (const path of candidates) {
    let raw: string
    try {
      raw = readFileSync(path, 'utf8')
    } catch {
      continue // not at this location; try the next
    }

    try {
      const catalog = validateCatalog(JSON.parse(raw), { source: path })
      console.log(`[models] catalog loaded from ${path} (${catalog.models.length} entries)`)
      return { catalog, path, error: null }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // Loud on purpose: this is a compliance failure, not a cosmetic one.
      console.error(`[models] REJECTED catalog at ${path}\n${message}`)
      return { catalog: createEmptyCatalog(), path, error: message }
    }
  }

  console.warn(`[models] no catalog found; looked in:\n  ${candidates.join('\n  ')}`)
  return { catalog: createEmptyCatalog(), path: null, error: null }
}
