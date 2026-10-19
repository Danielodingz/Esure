import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const cliPath = resolve(__dirname, "../dist/cli.js");

describe("CLI terminal run report file (#59)", () => {
  let tempDir: string;
  let validScenarioPath: string;
  let failingScenarioPath: string;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "esure-report-test-"));

    validScenarioPath = join(tempDir, "valid-scenario.json");
    await writeFile(
      validScenarioPath,
      JSON.stringify({
        schemaVersion: 1,
        id: "valid-scenario",
        version: 1,
        name: "Valid scenario",
        description: "A scenario for report testing",
        network: "testnet",
        accounts: [{ id: "alice", generate: true, fund: true }],
        assets: [{ id: "xlm", type: "native" }],
        steps: [],
        assertions: [{ type: "accountExists", account: "alice" }],
      }),
      "utf-8",
    );

    failingScenarioPath = join(tempDir, "failing-scenario.json");
    await writeFile(
      failingScenarioPath,
      JSON.stringify({
        schemaVersion: 1,
        id: "failing-scenario",
        version: 1,
        name: "Failing scenario",
        description: "A scenario with invalid network to trigger failure",
        network: "mainnet",
        accounts: [{ id: "alice", generate: true, fund: true }],
        assets: [{ id: "xlm", type: "native" }],
        steps: [],
        assertions: [{ type: "accountExists", account: "alice" }],
      }),
      "utf-8",
    );
  });

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("refuses to overwrite an existing file without explicit overwrite flag", async () => {
    const reportPath = join(tempDir, "existing-report.json");
    await writeFile(reportPath, JSON.stringify({ initial: "content" }), "utf-8");

    try {
      await execFileAsync(
        process.execPath,
        [cliPath, "run", failingScenarioPath, "--report-file", reportPath],
        { cwd: tempDir },
      );
      expect.unreachable("should have refused to overwrite");
    } catch (err: any) {
      expect(err.code).toBe(1);
      expect(err.stderr).toContain(`Report file "${reportPath}" already exists. Use --overwrite to replace it.`);
    }

    // Verify existing file was preserved untouched
    const content = await readFile(reportPath, "utf-8");
    expect(JSON.parse(content)).toEqual({ initial: "content" });
  });

  it("reports filesystem error for non-existent directory without secret material", async () => {
    const reportPath = join(tempDir, "missing-dir/sub/report.json");

    try {
      await execFileAsync(
        process.execPath,
        [cliPath, "run", failingScenarioPath, "--report-file", reportPath],
        { cwd: tempDir },
      );
      expect.unreachable("should have failed on missing directory");
    } catch (err: any) {
      expect(err.code).toBe(1);
      expect(err.stderr).toContain("Error writing report file:");
      expect(err.stderr).not.toContain("secret");
      expect(err.stderr).not.toContain("seed");
    }
  });

  it("writes failure report to report-file on execution failure and exits with code 1", async () => {
    const reportPath = join(tempDir, "error-report.json");

    try {
      await execFileAsync(
        process.execPath,
        [cliPath, "run", failingScenarioPath, "--report-file", reportPath],
        { cwd: tempDir },
      );
      expect.unreachable("failing scenario should exit with 1");
    } catch (err: any) {
      expect(err.code).toBe(1);
    }

    // Verify the report was written despite the scenario failure
    const content = await readFile(reportPath, "utf-8");
    const report = JSON.parse(content);
    expect(report.status).toBe("error");
    expect(report.error).toBeDefined();
    expect(report.error.message).toBeDefined();

    // Verify atomic sibling temp file was cleaned up
    const files = await readdir(tempDir);
    const tmpSiblings = files.filter((f) => f.startsWith(".error-report.json.tmp"));
    expect(tmpSiblings.length).toBe(0);
  });

  it("overwrites existing report when --overwrite is specified", async () => {
    const reportPath = join(tempDir, "overwrite-report.json");
    await writeFile(reportPath, JSON.stringify({ old: "data" }), "utf-8");

    try {
      await execFileAsync(
        process.execPath,
        [cliPath, "run", failingScenarioPath, "--report-file", reportPath, "--overwrite"],
        { cwd: tempDir },
      );
    } catch {
      // Expected non-zero code for failing scenario
    }

    const content = await readFile(reportPath, "utf-8");
    const report = JSON.parse(content);
    expect(report.old).toBeUndefined();
    expect(report.status).toBe("error");
  });
});
