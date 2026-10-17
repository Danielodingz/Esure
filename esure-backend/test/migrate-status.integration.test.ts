import { appendFile, cp, mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Database, migrationStatus, runMigrations } from "../src/database.js";

const port = 55_433;
let postgres: EmbeddedPostgres;
let database: Database;
let directory: string;

const postgresAvailable = process.platform !== "win32" || existsSync("C:/Windows/System32/VCRUNTIME140.dll") ||
  existsSync("node_modules/@embedded-postgres/windows-x64/native/bin/VCRUNTIME140.dll");

// Issue #79: read-only migration status reporting. Mirrors the embedded-postgres
// setup already used by database.integration.test.ts.
(postgresAvailable ? describe.sequential : describe.skip)("migrate-status (read-only migration state)", () => {
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "esure-migrate-status-"));
    postgres = new EmbeddedPostgres({ databaseDir: directory, user: "postgres", password: "test-password", port, persistent: true, onLog: () => undefined, onError: () => undefined });
    await postgres.initialise();
    await postgres.start();
    database = new Database({
      host: "127.0.0.1", port: 3001, logLevel: "silent", horizonUrl: "https://horizon-testnet.stellar.org", friendbotUrl: "https://friendbot.stellar.org",
      runTimeoutMs: 5_000, stepTimeoutMs: 1_000, maxConcurrentRuns: 2, maxStoredRuns: 100, runRetentionMs: 60_000,
      rateLimitMax: 100, runRateLimitMax: 50, rateLimitWindowMs: 60_000, bodyLimitBytes: 16_384,
      persistenceMode: "published", databaseUrl: `postgresql://postgres:test-password@127.0.0.1:${port}/postgres`,
      databasePoolMax: 5, databaseConnectionTimeoutMs: 5_000, databaseQueryTimeoutMs: 5_000, databaseIdleTimeoutMs: 10_000,
      runPersistenceEnabled: false,
    });
  }, 60_000);

  afterAll(async () => {
    await database?.close();
    await postgres?.stop();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }, 30_000);

  it("reports every migration file as pending on an uninitialized database, without crashing", async () => {
    const status = await migrationStatus(database);
    expect(status.applied).toHaveLength(0);
    expect(status.unexpected).toHaveLength(0);
    expect(status.mismatched).toHaveLength(0);
    expect(status.pending.length).toBeGreaterThan(0);
  });

  it("reports everything applied and nothing pending on a fully current schema", async () => {
    await runMigrations(database, undefined, "esure_migrations");
    const status = await migrationStatus(database);
    expect(status.pending).toHaveLength(0);
    expect(status.unexpected).toHaveLength(0);
    expect(status.mismatched).toHaveLength(0);
    expect(status.applied.length).toBeGreaterThan(0);
  });

  it("reports a pending file that exists on disk but has not been applied", async () => {
    const trimmedCopy = join(directory, "trimmed-migrations");
    await cp(resolve("migrations"), trimmedCopy, { recursive: true });
    const fullStatus = await migrationStatus(database, resolve("migrations"));
    const highestVersion = Math.max(...fullStatus.applied.map((item) => item.version));
    // Roll the database back one version worth of bookkeeping by querying against
    // a directory copy that's missing the highest-numbered migration file, which
    // makes that applied version look "unexpected" from this directory's viewpoint,
    // while a genuinely new, never-applied file (added below) is reported pending.
    const { readdir, unlink, writeFile } = await import("node:fs/promises");
    const files = (await readdir(trimmedCopy)).filter((file) => /^\d{3}_.*\.sql$/.test(file)).sort();
    const highestFile = files.find((file) => Number(file.slice(0, 3)) === highestVersion);
    if (highestFile) await unlink(join(trimmedCopy, highestFile));
    await writeFile(join(trimmedCopy, "999_not_yet_applied.sql"), "-- no-op pending migration\nSELECT 1;\n");

    const status = await migrationStatus(database, trimmedCopy);
    expect(status.pending.map((item) => item.version)).toContain(999);
    if (highestFile) expect(status.unexpected.map((item) => item.version)).toContain(highestVersion);
  });

  it("reports a checksum mismatch when a file's content changes after being applied", async () => {
    const modifiedCopy = join(directory, "modified-migrations");
    await cp(resolve("migrations"), modifiedCopy, { recursive: true });
    await appendFile(join(modifiedCopy, "001_persistence_foundation.sql"), "\n-- modified after being applied\n");

    const status = await migrationStatus(database, modifiedCopy);
    expect(status.mismatched.map((item) => item.version)).toContain(1);
    expect(status.applied.map((item) => item.version)).not.toContain(1);
  });
});
