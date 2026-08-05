import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'

import Database from 'better-sqlite3'
import type { Database as DatabaseType } from 'better-sqlite3'

import { createLogger, type Logger } from '../logging'
import { currentVersion, LATEST_SCHEMA_VERSION, migrate } from './migrations'

/**
 * Opening the history database, safely (PLAN §9, §15.2).
 *
 * The requirement is specific and worth restating, because it is the difference
 * between "an app with a database" and "an app that will not crash-loop on a
 * user's machine at 9am":
 *
 *  - **WAL mode**, so a reader never blocks the dictation loop's write;
 *  - **integrity check at boot**; a corrupt file is moved aside with a
 *    timestamped name and re-initialised, never surfaced as a crash;
 *  - **pre-migration backup** taken before any schema change, so a migration
 *    bug is recoverable by copying one file back.
 *
 * Nothing here is clever. It is all "the boring thing, actually done".
 */

export interface OpenDatabaseResult {
  db: DatabaseType
  /** Path the database was opened from. */
  path: string
  /** Set when a corrupt file was moved aside; the path it was moved to. */
  recoveredFrom: string | null
  /** Set when a migration ran; the backup taken beforehand. */
  backupPath: string | null
  appliedMigrations: string[]
}

export const DATABASE_FILE_NAME = 'murmur.db'

export interface OpenDatabaseOptions {
  log?: Logger
  /** Injected for tests; defaults to `Date.now`. */
  now?: () => number
}

export function openDatabase(path: string, options: OpenDatabaseOptions = {}): OpenDatabaseResult {
  const log = options.log ?? createLogger('db')
  const now = options.now ?? Date.now

  mkdirSync(dirname(path), { recursive: true })

  let recoveredFrom: string | null = null

  // Two ways a file can be unusable, and both must end in a clean re-init
  // rather than a crash loop (PLAN §15.2):
  //
  //  1. it is not a SQLite database at all — `PRAGMA journal_mode` throws
  //     "file is not a database" before anything else can run; or
  //  2. it is a database, but a damaged one — only `integrity_check` sees that.
  //
  // The first is the case a naive "open then check integrity" misses, because
  // the open itself is what fails.
  let db: DatabaseType
  try {
    db = openWithPragmas(path)
    const problem = checkIntegrity(db)
    if (problem) throw new Error(`integrity check failed: ${problem}`)
  } catch (error) {
    log.error(`history database at ${path} is unusable; re-initialising:`, error)
    recoveredFrom = quarantineDatabase(path, now())
    db = openWithPragmas(path)
  }

  // Pre-migration backup, but only when there is something to migrate *and*
  // something to lose (version 0 means the file was just created).
  const from = currentVersion(db)
  let backupPath: string | null = null
  if (from > 0 && from < LATEST_SCHEMA_VERSION) {
    backupPath = `${path}.v${from}.${new Date(now()).toISOString().replace(/[:.]/g, '-')}.bak`
    // `VACUUM INTO` produces a consistent copy even with the WAL non-empty,
    // which a plain file copy would not.
    db.exec(`VACUUM INTO '${backupPath.replaceAll("'", "''")}'`)
    log.info(`backed up schema v${from} to ${backupPath}`)
  }

  let appliedMigrations: string[]
  try {
    appliedMigrations = migrate(db).applied
  } catch (error) {
    // A migration that throws leaves a database this build cannot use. Treat it
    // exactly like corruption: move aside, start clean, keep the old file.
    log.error('migration failed:', error)
    db.close()
    recoveredFrom = quarantineDatabase(path, now())
    db = openWithPragmas(path)
    appliedMigrations = migrate(db).applied
  }

  if (appliedMigrations.length > 0) log.info(`applied migrations: ${appliedMigrations.join(', ')}`)

  return { db, path, recoveredFrom, backupPath, appliedMigrations }
}

function openWithPragmas(path: string): DatabaseType {
  const db = new Database(path)
  // WAL: concurrent reads during a write, and no reader/writer stalls in the
  // dictation loop (PLAN §15.2).
  db.pragma('journal_mode = WAL')
  // NORMAL is the documented companion to WAL: durable across app crashes,
  // and only at risk from an OS-level power loss, which history rows survive
  // losing far better than the app survives an fsync per insert.
  db.pragma('synchronous = NORMAL')
  db.pragma('foreign_keys = ON')
  // Fail fast rather than hang if another instance somehow holds the lock.
  db.pragma('busy_timeout = 5000')
  return db
}

/** `null` when healthy, otherwise the first problem SQLite reported. */
export function checkIntegrity(db: DatabaseType): string | null {
  try {
    const rows = db.pragma('integrity_check') as { integrity_check?: string }[]
    const first = rows[0]?.integrity_check
    return first === 'ok' ? null : (first ?? 'unknown integrity failure')
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/**
 * Move a bad database (and its WAL sidecars) aside, returning the new path.
 *
 * The file is *kept*, not deleted: a user's dictation history is not ours to
 * throw away, and a support request can still recover rows from it.
 */
function quarantineDatabase(path: string, now: number): string {
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-')
  const target = `${path}.corrupt-${stamp}`
  try {
    renameSync(path, target)
  } catch {
    // Rename can fail across devices; fall back to copy-then-remove.
    copyFileSync(path, target)
    rmSync(path, { force: true })
  }
  // The -wal/-shm files belong to the old database and would confuse the new one.
  for (const suffix of ['-wal', '-shm']) {
    rmSync(`${path}${suffix}`, { force: true })
  }
  return target
}

/** `<userData>/murmur.db`. */
export function databasePath(userDataPath: string): string {
  return join(userDataPath, DATABASE_FILE_NAME)
}

/** True when a database file already exists at `path`. */
export function databaseExists(path: string): boolean {
  return existsSync(path)
}
