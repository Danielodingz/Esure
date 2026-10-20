import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import pg, { type Pool, type PoolClient, type QueryResultRow } from "pg";
import type { AppConfig } from "./config.js";

const { Pool: PgPool } = pg;
const migrationPattern = /^(\d{3})_[a-z0-9_]+\.sql$/;
const migrationLockKey = 7_235_817_221;

export class DatabaseUnavailableError extends Error {
  constructor() { super("Database operation unavailable"); this.name = "DatabaseUnavailableError"; }
}

export interface Queryable {
  query<T extends QueryResultRow = QueryResultRow>(text: string, values?: readonly unknown[]): Promise<{ rows: T[]; rowCount: number | null }>;
}

export class Database {
  readonly pool: Pool;
  readonly queryTimeoutMs: number;

  constructor(config: AppConfig) {
    if (!config.databaseUrl) throw new Error("DATABASE_URL is required for database construction");
    this.queryTimeoutMs = config.databaseQueryTimeoutMs;
    this.pool = new PgPool({
      connectionString: config.databaseUrl,
      max: config.databasePoolMax,
      connectionTimeoutMillis: config.databaseConnectionTimeoutMs,
      idleTimeoutMillis: config.databaseIdleTimeoutMs,
      statement_timeout: config.databaseQueryTimeoutMs,
      query_timeout: config.databaseQueryTimeoutMs,
      application_name: "esure-backend",
      allowExitOnIdle: true,
    });
    this.pool.on("error", () => undefined);
  }

  async query<T extends QueryResultRow = QueryResultRow>(text: string, values: readonly unknown[] = []) {
    try { return await this.pool.query<T>(text, [...values]); }
    catch (error) { throw classifyDatabaseError(error); }
  }

  async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    let client: PoolClient | undefined;
    try {
      client = await this.pool.connect();
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      if (client) await client.query("ROLLBACK").catch(() => undefined);
      throw classifyDatabaseError(error);
    } finally { client?.release(); }
  }

  async readiness(): Promise<void> { await this.query("SELECT 1"); }
  async close(): Promise<void> { await this.pool.end(); }
}

export async function runMigrations(database: Database, directory = resolve(process.cwd(), "migrations"), role?: "esure_migrations"): Promise<void> {
  const files = await migrationFiles(directory);
  await database.transaction(async (client) => {
    if (role) await client.query(`SET LOCAL ROLE ${role}`);
    await client.query("SELECT pg_advisory_xact_lock($1)", [migrationLockKey]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version integer PRIMARY KEY,
      filename text NOT NULL UNIQUE,
      checksum text NOT NULL CHECK (checksum ~ '^sha256:[0-9a-f]{64}$'),
      applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
    )`);
    for (const migration of files) {
      const { filename, version, sql, checksum } = migration;
      const existing = await client.query<{ checksum: string; filename: string }>("SELECT checksum, filename FROM schema_migrations WHERE version = $1", [version]);
      if (existing.rowCount) {
        const applied = existing.rows[0];
        if (applied?.checksum !== checksum || applied.filename !== filename) throw new Error(`Migration ${version} checksum mismatch`);
        continue;
      }
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations(version, filename, checksum) VALUES ($1, $2, $3)", [version, filename, checksum]);
    }
  });
}

export async function assertMigrationsCurrent(database: Database, directory = resolve(process.cwd(), "migrations")): Promise<void> {
  const expected = await migrationFiles(directory);
  const applied = await database.query<{ version: number; filename: string; checksum: string }>("SELECT version, filename, checksum FROM schema_migrations ORDER BY version");
  if (applied.rows.length !== expected.length) throw new Error("Database schema migrations are not current");
  for (let index = 0; index < expected.length; index += 1) {
    const left = expected[index]!;
    const right = applied.rows[index]!;
    if (left.version !== right.version || left.filename !== right.filename || left.checksum !== right.checksum) throw new Error(`Migration ${left.version} checksum mismatch`);
  }
}

export interface MigrationFileStatus { version: number; filename: string }

export interface MigrationStatusReport {
  /** Versions present on disk and applied with a matching filename/checksum. */
  applied: MigrationFileStatus[];
  /** Versions present on disk but not yet applied. */
  pending: MigrationFileStatus[];
  /** Versions recorded as applied but with no matching file on disk. */
  unexpected: MigrationFileStatus[];
  /** Versions applied with a filename/checksum that no longer matches the file on disk. */
  mismatched: MigrationFileStatus[];
}

/**
 * Read-only counterpart to `runMigrations` (issue #79): reports applied,
 * pending, unexpected, and checksum-mismatched migration versions without
 * making any schema or data changes. Reuses the same file-enumeration and
 * checksum logic as `runMigrations`/`assertMigrationsCurrent`.
 *
 * Handles an uninitialized database (no `schema_migrations` table yet) by
 * reporting every file on disk as pending, rather than crashing.
 */
export async function migrationStatus(database: Database, directory = resolve(process.cwd(), "migrations")): Promise<MigrationStatusReport> {
  const files = await migrationFiles(directory);
  const byVersion = new Map(files.map((file) => [file.version, file]));

  let appliedRows: { version: number; filename: string; checksum: string }[];
  try {
    const result = await database.query<{ version: number; filename: string; checksum: string }>(
      "SELECT version, filename, checksum FROM schema_migrations ORDER BY version",
    );
    appliedRows = result.rows;
  } catch (error) {
    if (!isUndefinedTableError(error)) throw error;
    appliedRows = [];
  }

  const appliedVersions = new Set<number>();
  const applied: MigrationFileStatus[] = [];
  const unexpected: MigrationFileStatus[] = [];
  const mismatched: MigrationFileStatus[] = [];
  for (const row of appliedRows) {
    appliedVersions.add(row.version);
    const file = byVersion.get(row.version);
    if (!file) { unexpected.push({ version: row.version, filename: row.filename }); continue; }
    if (file.checksum !== row.checksum || file.filename !== row.filename) {
      mismatched.push({ version: row.version, filename: row.filename });
      continue;
    }
    applied.push({ version: row.version, filename: row.filename });
  }
  const pending = files
    .filter((file) => !appliedVersions.has(file.version))
    .map((file) => ({ version: file.version, filename: file.filename }));

  return { applied, pending, unexpected, mismatched };
}

/** True for Postgres "undefined_table" (42P01) — the migrations table does not exist yet. */
function isUndefinedTableError(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as { code?: unknown }).code === "42P01";
}

async function migrationFiles(directory: string) {
  const filenames = (await readdir(directory)).filter((file) => migrationPattern.test(file)).sort();
  return Promise.all(filenames.map(async (filename) => {
    const match = migrationPattern.exec(filename)!;
    const sql = await readFile(resolve(directory, filename), "utf8");
    return { filename, version: Number(match[1]), sql, checksum: `sha256:${createHash("sha256").update(sql).digest("hex")}` };
  }));
}

function classifyDatabaseError(error: unknown): Error {
  if (error instanceof Error && (/checksum mismatch/.test(error.message) || "code" in error && typeof error.code === "string" && !isAvailabilityCode(error.code))) return error;
  return new DatabaseUnavailableError();
}

function isAvailabilityCode(code: string): boolean {
  return code.startsWith("08") || [
    "57P01", "57P02", "57P03", "53300", "53400",
    "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "EPIPE",
  ].includes(code);
}
