import { existsSync, mkdirSync, readdirSync, rmSync, statSync, type Dirent } from 'node:fs'
import { isAbsolute, join, normalize, sep } from 'node:path'

import type { InstalledModel, ModelEntry } from '@murmur/shared'

/**
 * Where downloaded models live, and the rules for touching that directory
 * (PLAN §8, §15.3).
 *
 * Layout: `<userData>/models/<modelId>/<filename>`. One directory per model
 * means "delete this model" is one `rm -rf` of a path we constructed, and disk
 * accounting is a directory walk rather than a manifest that can drift.
 *
 * The security-relevant part is {@link resolveModelPath}. Model ids and file
 * names arrive from a JSON catalog that could, in principle, be hand-edited, so
 * neither is allowed to escape the models root: the schema already rejects path
 * separators in `filename`, and this function re-checks the *resolved* path,
 * because defence in depth is cheap and a path-traversal bug here writes
 * arbitrary files as the user.
 */

export const MODELS_DIR_NAME = 'models'

export class UnsafeModelPathError extends Error {
  override readonly name = 'UnsafeModelPathError'
  constructor(value: string) {
    super(`Refusing to use "${value}" as a model path component — it escapes the models directory.`)
  }
}

/** `<userData>/models`. */
export function modelsRoot(userDataPath: string): string {
  return join(userDataPath, MODELS_DIR_NAME)
}

/**
 * A safe absolute path inside the models root.
 *
 * @throws {UnsafeModelPathError} when any component contains a separator, `..`,
 *   or resolves outside the root.
 */
export function resolveModelPath(root: string, ...components: string[]): string {
  for (const component of components) {
    if (
      component.length === 0 ||
      component === '.' ||
      component === '..' ||
      component.includes('/') ||
      component.includes('\\') ||
      component.includes('\0') ||
      isAbsolute(component)
    ) {
      throw new UnsafeModelPathError(component)
    }
  }

  const resolved = normalize(join(root, ...components))
  const rootWithSep = normalize(root).endsWith(sep) ? normalize(root) : `${normalize(root)}${sep}`
  if (!resolved.startsWith(rootWithSep)) throw new UnsafeModelPathError(components.join('/'))
  return resolved
}

/** Directory for one model. Created on demand. */
export function modelDirectory(root: string, modelId: string): string {
  return resolveModelPath(root, modelId)
}

export function ensureModelDirectory(root: string, modelId: string): string {
  const directory = modelDirectory(root, modelId)
  mkdirSync(directory, { recursive: true })
  return directory
}

/** True when every file the catalog lists is present with the right size. */
export function isModelInstalled(root: string, entry: ModelEntry): boolean {
  let directory: string
  try {
    directory = modelDirectory(root, entry.id)
  } catch {
    return false
  }
  if (!existsSync(directory)) return false

  return entry.files.every((file) => {
    try {
      const path = resolveModelPath(directory, file.filename)
      const stats = statSync(path)
      // Size is a cheap proxy for "complete"; the SHA-256 was verified at
      // download time and re-hashing gigabytes on every Hub render is not free.
      return stats.isFile() && stats.size === file.bytes
    } catch {
      return false
    }
  })
}

/** Total bytes under a directory, following no symlinks. */
export function directorySize(path: string): number {
  let total = 0
  let entries: Dirent[]
  try {
    entries = readdirSync(path, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const child = join(path, entry.name)
    if (entry.isDirectory()) total += directorySize(child)
    else if (entry.isFile()) {
      try {
        total += statSync(child).size
      } catch {
        /* raced with a delete */
      }
    }
  }
  return total
}

/** Every model currently on disk, catalog-known or not. */
export function listInstalled(root: string, entries: readonly ModelEntry[]): InstalledModel[] {
  if (!existsSync(root)) return []
  const byId = new Map(entries.map((entry) => [entry.id, entry]))

  const installed: InstalledModel[] = []
  for (const dirent of readdirSync(root, { withFileTypes: true })) {
    if (!dirent.isDirectory() || dirent.name.startsWith('.')) continue
    const entry = byId.get(dirent.name)
    if (!entry) continue
    if (!isModelInstalled(root, entry)) continue

    const directory = join(root, dirent.name)
    installed.push({
      modelId: entry.id,
      kind: entry.kind,
      engine: entry.engine,
      path: directory,
      bytes: directorySize(directory),
      installedAt: safeMtime(directory),
      source: 'catalog',
    })
  }
  return installed
}

function safeMtime(path: string): number {
  try {
    return Math.floor(statSync(path).mtimeMs)
  } catch {
    return 0
  }
}

/** Delete one model's directory. Returns the bytes reclaimed. */
export function deleteModel(root: string, modelId: string): number {
  const directory = modelDirectory(root, modelId)
  if (!existsSync(directory)) return 0
  const bytes = directorySize(directory)
  rmSync(directory, { recursive: true, force: true })
  return bytes
}

/** Sum of everything under the models root, including quarantined files. */
export function totalDiskUsage(root: string): number {
  return directorySize(root)
}
