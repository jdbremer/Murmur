import type { Database } from 'better-sqlite3'

/**
 * Forward-only schema migrations (PLAN §9, §15.2).
 *
 * Rules, deliberately rigid:
 *
 *  - migrations are **append-only**; an existing entry is never edited, because
 *    a shipped build has already run it;
 *  - each one is idempotent-by-version, tracked in `user_version`;
 *  - each runs inside a transaction, so a failure leaves the previous version
 *    intact rather than half-applied;
 *  - the caller takes a **pre-migration backup** first (see `db.ts`), which is
 *    the actual safety net — a migration that corrupts data is recoverable, one
 *    that does so with no copy of the old file is not.
 *
 * There is no `down`. Rolling an app back to a build that predates a migration
 * is handled by restoring the pre-migration backup, which is a file copy rather
 * than a second set of SQL nobody has ever run.
 */

export interface Migration {
  /** 1-based, contiguous. Matches the `user_version` after it has run. */
  version: number
  name: string
  up(db: Database): void
}

export const MIGRATIONS: readonly Migration[] = Object.freeze([
  {
    version: 1,
    name: 'initial-schema',
    up(db) {
      // -- dictations (PLAN §9) -------------------------------------------
      db.exec(`
        CREATE TABLE dictations (
          id            TEXT PRIMARY KEY,
          ts            INTEGER NOT NULL,
          raw_text      TEXT NOT NULL,
          polished_text TEXT,
          app_bundle_id TEXT,
          app_category  TEXT NOT NULL DEFAULT 'other',
          duration_ms   INTEGER NOT NULL DEFAULT 0,
          stt_model     TEXT NOT NULL,
          polish_model  TEXT,
          timings_json  TEXT NOT NULL DEFAULT '{}'
        );
        CREATE INDEX idx_dictations_ts ON dictations (ts DESC);
      `)

      // FTS5 over both text columns. `content=` makes it an external-content
      // index: the text lives once, in `dictations`, and the triggers below
      // keep the index in step. Halves the on-disk size of a long history.
      db.exec(`
        CREATE VIRTUAL TABLE dictations_fts USING fts5(
          raw_text,
          polished_text,
          content='dictations',
          content_rowid='rowid',
          tokenize='unicode61 remove_diacritics 2'
        );

        CREATE TRIGGER dictations_ai AFTER INSERT ON dictations BEGIN
          INSERT INTO dictations_fts(rowid, raw_text, polished_text)
          VALUES (new.rowid, new.raw_text, new.polished_text);
        END;

        CREATE TRIGGER dictations_ad AFTER DELETE ON dictations BEGIN
          INSERT INTO dictations_fts(dictations_fts, rowid, raw_text, polished_text)
          VALUES ('delete', old.rowid, old.raw_text, old.polished_text);
        END;

        CREATE TRIGGER dictations_au AFTER UPDATE ON dictations BEGIN
          INSERT INTO dictations_fts(dictations_fts, rowid, raw_text, polished_text)
          VALUES ('delete', old.rowid, old.raw_text, old.polished_text);
          INSERT INTO dictations_fts(rowid, raw_text, polished_text)
          VALUES (new.rowid, new.raw_text, new.polished_text);
        END;
      `)

      // -- dictionary (PLAN §9) -------------------------------------------
      // `replacement IS NULL` = vocabulary-boost only; the UNIQUE index makes
      // "add the same term twice" a no-op rather than a duplicate row.
      db.exec(`
        CREATE TABLE dictionary (
          id          TEXT PRIMARY KEY,
          term        TEXT NOT NULL,
          replacement TEXT,
          enabled     INTEGER NOT NULL DEFAULT 1
        );
        CREATE UNIQUE INDEX idx_dictionary_term ON dictionary (term COLLATE NOCASE);
      `)

      // -- style profiles (PLAN §9) ---------------------------------------
      db.exec(`
        CREATE TABLE style_profiles (
          category            TEXT PRIMARY KEY,
          formality           TEXT NOT NULL,
          filler_handling     TEXT NOT NULL,
          emoji               TEXT NOT NULL,
          custom_instructions TEXT NOT NULL DEFAULT ''
        );
      `)
    },
  },
])

export const LATEST_SCHEMA_VERSION = MIGRATIONS.reduce(
  (highest, migration) => Math.max(highest, migration.version),
  0,
)

export function currentVersion(db: Database): number {
  const row = db.pragma('user_version', { simple: true })
  return typeof row === 'number' ? row : 0
}

export interface MigrationResult {
  from: number
  to: number
  applied: string[]
}

/**
 * Bring `db` up to {@link LATEST_SCHEMA_VERSION}.
 *
 * @throws when the database is *newer* than this build understands — running an
 *   old binary against a new schema silently drops columns, so it must refuse.
 */
export function migrate(db: Database): MigrationResult {
  const from = currentVersion(db)

  if (from > LATEST_SCHEMA_VERSION) {
    throw new Error(
      `Database schema version ${from} is newer than this build supports ` +
        `(${LATEST_SCHEMA_VERSION}). Update Murmur, or restore a backup.`,
    )
  }

  const applied: string[] = []
  for (const migration of MIGRATIONS) {
    if (migration.version <= from) continue
    db.transaction(() => {
      migration.up(db)
      // `pragma` cannot be parameterised, and `version` is a number from our
      // own frozen table — never user input.
      db.pragma(`user_version = ${migration.version}`)
    })()
    applied.push(`${migration.version}:${migration.name}`)
  }

  return { from, to: currentVersion(db), applied }
}
