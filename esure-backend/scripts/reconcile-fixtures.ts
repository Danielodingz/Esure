import { loadConfig } from "../src/config.js";
import { assertMigrationsCurrent, Database } from "../src/database.js";
import { PublishedScenarioRepository } from "../src/published-scenarios.js";
import { createScenarioRegistry } from "../src/scenarios.js";

/**
 * Issue #80: --dry-run previews what reconciliation would do (unchanged /
 * new / changed scenarios and the proposed version numbers) without
 * inserting any scenario_versions rows. --json switches the dry-run
 * output to a single machine-readable JSON document on stdout; the
 * default output is a human-readable summary. Neither mode ever prints
 * DATABASE_URL or any other connection secret.
 */
const dryRun = process.argv.includes("--dry-run");
const asJson = process.argv.includes("--json");

const config = loadConfig({ ...process.env, PERSISTENCE_MODE: "published", DATABASE_URL: process.env.DATABASE_MIGRATION_URL });
const database = new Database(config);
try {
  await assertMigrationsCurrent(database);
  const repository = new PublishedScenarioRepository(database);
  const registry = createScenarioRegistry(config.scenarioDirectory);

  if (dryRun) {
    const report = await repository.dryRunReconcile(registry);
    if (asJson) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`Fixture reconciliation dry run (${report.generatedAt}) — no rows were written.`);
      for (const entry of report.entries) {
        if (entry.status === "unchanged") {
          console.log(`  unchanged  ${entry.id} (version ${entry.currentVersion})`);
        } else if (entry.status === "new") {
          console.log(`  new        ${entry.id} would be introduced as version ${entry.proposedVersion}`);
        } else {
          console.log(`  changed    ${entry.id} would move from version ${entry.currentVersion} to version ${entry.proposedVersion}`);
        }
      }
      console.log(`Summary: ${report.summary.unchanged} unchanged, ${report.summary.new} new, ${report.summary.changed} changed.`);
    }
  } else {
    await repository.reconcile(registry);
  }
} finally {
  await database.close();
}
