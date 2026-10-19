import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validateScenarioDefinition } from "@esure/backend/scenario-schema.js";
import { parse as parseYaml } from "yaml";

const execFileAsync = promisify(execFile);
const cliPath = resolve(__dirname, "../dist/cli.js");

describe("CLI init command (#62)", () => {
  let tempDir: string;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "esure-init-test-"));
  });

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("fails when missing file path argument", async () => {
    try {
      await execFileAsync(process.execPath, [cliPath, "init"], { cwd: tempDir });
      expect.unreachable("should have exited with error code");
    } catch (err: any) {
      expect(err.code).toBe(1);
      expect(err.stderr).toContain("Missing file path argument");
      expect(err.stderr).toContain("Usage: esure init <file>");
    }
  });

  it("scaffolds a valid JSON scenario file and prints next steps", async () => {
    const target = join(tempDir, "my-payment.json");
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [cliPath, "init", target],
      { cwd: tempDir },
    );

    expect(stderr).toBe("");
    expect(stdout).toContain(`Scenario scaffolded: ${target}`);
    expect(stdout).toContain(`Validate: esure validate ${target}`);
    expect(stdout).toContain(`Run:      esure run ${target}`);

    const content = await readFile(target, "utf-8");
    const parsed = JSON.parse(content);

    // Validate with canonical backend validator
    const validated = validateScenarioDefinition(parsed);
    expect(validated.id).toBe("my-payment");
    expect(validated.network).toBe("testnet");
    expect(validated.accounts.every((a) => a.generate === true)).toBe(true);
    expect(validated.steps.length).toBeGreaterThan(0);
    expect(validated.assertions.length).toBeGreaterThan(0);
  });

  it("scaffolds a valid YAML scenario file", async () => {
    const target = join(tempDir, "sample-transfer.yaml");
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [cliPath, "init", target],
      { cwd: tempDir },
    );

    expect(stderr).toBe("");
    expect(stdout).toContain(`Scenario scaffolded: ${target}`);

    const content = await readFile(target, "utf-8");
    const parsed = parseYaml(content);

    const validated = validateScenarioDefinition(parsed);
    expect(validated.id).toBe("sample-transfer");
    expect(validated.network).toBe("testnet");
  });

  it("scaffolds a valid YML scenario file", async () => {
    const target = join(tempDir, "sample-alt.yml");
    const { stdout } = await execFileAsync(
      process.execPath,
      [cliPath, "init", target],
      { cwd: tempDir },
    );
    expect(stdout).toContain(`Scenario scaffolded: ${target}`);
    const content = await readFile(target, "utf-8");
    const parsed = parseYaml(content);
    const validated = validateScenarioDefinition(parsed);
    expect(validated.id).toBe("sample-alt");
  });

  it("refuses to overwrite an existing file by default", async () => {
    const target = join(tempDir, "existing-scenario.json");
    await writeFile(target, JSON.stringify({ custom: "data" }), "utf-8");

    try {
      await execFileAsync(process.execPath, [cliPath, "init", target], { cwd: tempDir });
      expect.unreachable("should have refused to overwrite");
    } catch (err: any) {
      expect(err.code).toBe(1);
      expect(err.stderr).toContain(`Scenario file "${target}" already exists. Use --overwrite to replace it.`);
    }

    // Verify original content was not altered
    const content = await readFile(target, "utf-8");
    expect(JSON.parse(content)).toEqual({ custom: "data" });
  });

  it("overwrites existing file when --overwrite is passed", async () => {
    const target = join(tempDir, "overwrite-scenario.json");
    await writeFile(target, JSON.stringify({ custom: "old" }), "utf-8");

    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [cliPath, "init", target, "--overwrite"],
      { cwd: tempDir },
    );

    expect(stderr).toBe("");
    expect(stdout).toContain(`Scenario scaffolded: ${target}`);
    const content = await readFile(target, "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed.id).toBe("overwrite-scenario");
  });

  it("rejects unsupported file extensions with clear error", async () => {
    const target = join(tempDir, "scenario.toml");
    try {
      await execFileAsync(process.execPath, [cliPath, "init", target], { cwd: tempDir });
      expect.unreachable("should have rejected unsupported extension");
    } catch (err: any) {
      expect(err.code).toBe(1);
      expect(err.stderr).toContain("Unsupported file extension");
      expect(err.stderr).toContain(".json, .yaml, and .yml");
    }
  });

  it("supports JSON output format", async () => {
    const target = join(tempDir, "json-mode.json");
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [cliPath, "init", target, "--output", "json"],
      { cwd: tempDir },
    );

    expect(stderr).toBe("");
    const parsed = JSON.parse(stdout);
    expect(parsed.created).toBe(true);
    expect(parsed.scenarioId).toBe("json-mode");
  });
});
