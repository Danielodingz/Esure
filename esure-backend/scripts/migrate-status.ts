/**
 * Read-only migration status report (issue #79).
 *
 * Lists applied, pending, unexpected (recorded as applied but with no
 * matching file), and checksum-mismatched migration versions. Makes NO
 * schema or data changes — it only runs SELECT queries against
 * schema_migrations (via `migrationStatus`), reusing the same
 * file-enumeration and checksum logic as scripts/migrate.ts.
 *
 * Exit codes:
 *   0 - in sync: every file on disk is applied and matches, or there are
 *       only pending files (pending-only is not an error — it mirrors how
 *       migrate.ts treats unapplied migrations as normal work still to do).
 *   1 - incompatible migration state: at least one unexpected or
 *       checksum-mismatched version is present. This mirrors runMigrations/
 *       assertMigrationsCurrent, which both throw in exactly these cases.
 *   2 - the status check itself failed (e.g. cannot reach the database).
 *       Connection details/credentials are redacted from any logged error.
 */
import { loadConfig } from "../src/config.js";
import { Database, migrationStatus } from "../src/database.js";

const config = loadConfig({ ...process.env, PERSISTENCE_MODE: "published", DATABASE_URL: process.env.DATABASE_MIGRATION_URL });
const database = new Database(config);

try {
  const status = await migrationStatus(database);
  console.log(JSON.stringify(status, null, 2));

  const incompatible = status.unexpected.length > 0 || status.mismatched.length > 0;
  if (incompatible) {
    console.error(
      `Incompatible migration state: ${status.unexpected.length} unexpected, ${status.mismatched.length} checksum-mismatched version(s).`,
    );
    process.exitCode = 1;
  } else {
    if (status.pending.length > 0) console.log(`${status.pending.length} migration(s) pending (not an error).`);
    process.exitCode = 0;
  }
} catch (error) {
  console.error(`migrate-status failed: ${redactConnectionDetails(error instanceof Error ? error.message : String(error))}`);
  process.exitCode = 2;
} finally {
  await database.close();
}

/** Strips any connection string / credential-bearing substrings from a log message. */
function redactConnectionDetails(message: string): string {
  return message.replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, "[REDACTED_CONNECTION_STRING]");
}
