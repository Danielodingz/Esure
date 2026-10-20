#!/usr/bin/env node

import { access, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { validateScenarioDefinition } from "@esure/backend/scenario-schema.js";
import { prepareScenario } from "@esure/backend/scenario-loader.js";
import { createScenarioRegistry } from "@esure/backend/scenarios.js";
import { StellarTestnetGateway } from "@esure/backend/stellar-gateway.js";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { ValidatedScenario } from "@esure/backend/domain.js";
import type { LedgerExecution, LedgerExecutionOptions } from "@esure/backend/domain.js";

const VERSION = "0.1.0";
const BUNDLED_SCENARIO_DIR_TIMEOUT_MS = 30_000;

// ─────────────────────────────────────────────────────────────────────────────
// Shared types
// ─────────────────────────────────────────────────────────────────────────────

interface CliOptions {
  output?: "human" | "json";
  help?: boolean;
  version?: boolean;
  /** #68 — use ASCII status markers (PASS/FAIL) instead of Unicode glyphs */
  ascii?: boolean;
  /** #59 — write JSON run report to a file */
  reportFile?: string;
  /** #60 — write JUnit XML test report to a file */
  junit?: string;
  /** #157 — write CSV assertion results to a file */
  csv?: string;
  /** #59, #60, #62, #157 — overwrite existing destination file */
  overwrite?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Status markers (#68)
// ─────────────────────────────────────────────────────────────────────────────

interface Markers {
  pass: string;
  fail: string;
}

function markers(ascii: boolean): Markers {
  return ascii ? { pass: "PASS", fail: "FAIL" } : { pass: "✓", fail: "✗" };
}

function statusMarker(status: "passed" | "failed" | string, m: Markers): string {
  return status === "passed" ? m.pass : m.fail;
}

// ─────────────────────────────────────────────────────────────────────────────
// Help & version
// ─────────────────────────────────────────────────────────────────────────────

function showHelp(): void {
  console.log(`
esure - Stellar Testnet scenario testing toolkit

Usage:
  esure list                              List bundled scenarios
  esure validate <file>                   Validate a scenario file
  esure init <file>                       Scaffold a new scenario file (.json, .yaml, .yml)
  esure run <scenario-id>                 Run a bundled scenario
  esure run <file>                        Run a scenario from file
  esure run-suite <id> [<id>...]          Run multiple bundled scenarios sequentially

Options:
  --output <format>        Output format: human (default) or json
  --ascii                  Use ASCII status markers (PASS/FAIL) instead of Unicode glyphs
  --report-file <path>     Write run report JSON to a file
  --junit <path>           Write JUnit XML test results to a file
  --csv <path>             Write assertion results as CSV to a file
  --overwrite              Overwrite existing output files (--report-file, --junit, --csv, init)
  --fail-fast              (run-suite) Stop after first failure
  --help                   Show this help message
  --version                Show version information

Examples:
  esure list
  esure init ./my-scenario.yaml
  esure validate ./my-scenario.yaml
  esure run xlm-payment
  esure run ./my-scenario.yaml --output json --report-file report.json
  esure run ./my-scenario.yaml --junit junit.xml
  esure run ./my-scenario.yaml --csv assertions.csv
  esure run-suite xlm-payment path-payment --fail-fast --report-file suite.json --junit suite.xml

Documentation: https://github.com/Esureorg/Esure
`);
}

function showVersion(): void {
  console.log(`esure v${VERSION}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Argument parsing
// ─────────────────────────────────────────────────────────────────────────────

function parseCliArgs(): {
  command?: string;
  args: string[];
  options: CliOptions;
  failFast: boolean;
} {
  const { values, positionals } = parseArgs({
    options: {
      output: { type: "string" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
      ascii: { type: "boolean" },
      "fail-fast": { type: "boolean" },
      "report-file": { type: "string" },
      junit: { type: "string" },
      "junit-file": { type: "string" },
      csv: { type: "string" },
      overwrite: { type: "boolean" },
      force: { type: "boolean" },
    },
    allowPositionals: true,
    strict: false,
  });

  const rawJunit =
    typeof values.junit === "string"
      ? values.junit
      : typeof values["junit-file"] === "string"
        ? (values["junit-file"] as string)
        : undefined;

  return {
    command: positionals[0],
    args: positionals.slice(1),
    options: {
      output: values.output === "json" ? "json" : "human",
      help: Boolean(values.help),
      version: Boolean(values.version),
      ascii: Boolean(values.ascii),
      reportFile: typeof values["report-file"] === "string" ? values["report-file"] : undefined,
      junit: rawJunit,
      csv: typeof values.csv === "string" ? values.csv : undefined,
      overwrite: Boolean(values.overwrite || values.force),
    },
    failFast: Boolean(values["fail-fast"]),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario loading
// ─────────────────────────────────────────────────────────────────────────────

async function loadScenarioFile(filePath: string): Promise<ValidatedScenario> {
  const absolutePath = resolve(filePath);
  const content = await readFile(absolutePath, "utf-8");

  let parsed: unknown;
  if (filePath.endsWith(".json")) {
    parsed = JSON.parse(content);
  } else if (filePath.endsWith(".yaml") || filePath.endsWith(".yml")) {
    parsed = parseYaml(content);
  } else {
    throw new Error("Scenario file must be .json, .yaml, or .yml");
  }

  const validated = validateScenarioDefinition(parsed);
  return prepareScenario(validated);
}

// ─────────────────────────────────────────────────────────────────────────────
// Execution helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Build a LedgerExecutionOptions object that prints progress in human mode (#66). */
function buildExecutionOptions(options: CliOptions): LedgerExecutionOptions {
  const execOptions: LedgerExecutionOptions = { stepTimeoutMs: BUNDLED_SCENARIO_DIR_TIMEOUT_MS };
  if (options.output === "human") {
    const m = markers(options.ascii ?? false);
    execOptions.onStep = (step) => {
      console.log(`  ${statusMarker(step.status, m)} step  ${step.id}: ${step.message}`);
    };
    execOptions.onAssertion = (assertion) => {
      console.log(`  ${statusMarker(assertion.status, m)} check ${assertion.type}: ${assertion.message}`);
    };
  }
  return execOptions;
}

function buildRunReport(
  scenario: ValidatedScenario,
  execution: LedgerExecution,
): {
  scenarioId: string;
  scenarioVersion: number;
  status: "passed" | "failed";
  steps: LedgerExecution["steps"];
  assertions: LedgerExecution["assertions"];
  summary: {
    stepsPassed: number;
    stepsFailed: number;
    assertionsPassed: number;
    assertionsFailed: number;
  };
} {
  const passed =
    execution.steps.every((s) => s.status === "passed") &&
    execution.assertions.every((a) => a.status === "passed");
  const stepsPassed = execution.steps.filter((s) => s.status === "passed").length;
  const assertionsPassed = execution.assertions.filter((a) => a.status === "passed").length;
  return {
    scenarioId: scenario.id,
    scenarioVersion: scenario.version,
    status: passed ? "passed" : "failed",
    steps: execution.steps,
    assertions: execution.assertions,
    summary: {
      stepsPassed,
      stepsFailed: execution.steps.length - stepsPassed,
      assertionsPassed,
      assertionsFailed: execution.assertions.length - assertionsPassed,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Artifact writing & JUnit export (#59, #60, #62)
// ─────────────────────────────────────────────────────────────────────────────

function escapeCsv(value: unknown): string {
  const str = String(value ?? "");
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function generateCsv(runs: ScenarioRunResultForJunit[]): string {
  const rows: string[] = [
    ["Scenario", "Type", "Status", "Message"].map(escapeCsv).join(","),
  ];

  for (const run of runs) {
    if (run.execution) {
      for (const assertion of run.execution.assertions) {
        rows.push(
          [run.scenarioId, assertion.type, assertion.status, assertion.message]
            .map(escapeCsv)
            .join(","),
        );
      }
    }
  }

  return rows.join("\n") + "\n";
}

export function escapeXml(unsafe: string): string {
  return String(unsafe)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export interface ScenarioRunResultForJunit {
  scenarioId: string;
  execution?: LedgerExecution;
  error?: { message: string };
}

export function generateJunitXml(runs: ScenarioRunResultForJunit[]): string {
  let totalTests = 0;
  let totalFailures = 0;
  let totalErrors = 0;

  const testsuiteXmls: string[] = [];

  for (const run of runs) {
    let suiteTests = 0;
    let suiteFailures = 0;
    let suiteErrors = 0;
    const testcaseXmls: string[] = [];

    if (run.execution) {
      for (const step of run.execution.steps) {
        suiteTests += 1;
        const name = `step ${step.id}: ${step.message || step.type}`;
        if (step.status === "passed") {
          testcaseXmls.push(
            `    <testcase classname="${escapeXml(run.scenarioId)}" name="${escapeXml(name)}" time="0"/>`,
          );
        } else {
          suiteFailures += 1;
          testcaseXmls.push(
            `    <testcase classname="${escapeXml(run.scenarioId)}" name="${escapeXml(name)}" time="0">\n      <failure message="${escapeXml(step.message)}" type="${escapeXml(step.type)}">${escapeXml(step.message)}</failure>\n    </testcase>`,
          );
        }
      }

      for (const assertion of run.execution.assertions) {
        suiteTests += 1;
        const name = `assertion ${assertion.type}: ${assertion.message}`;
        if (assertion.status === "passed") {
          testcaseXmls.push(
            `    <testcase classname="${escapeXml(run.scenarioId)}" name="${escapeXml(name)}" time="0"/>`,
          );
        } else {
          suiteFailures += 1;
          testcaseXmls.push(
            `    <testcase classname="${escapeXml(run.scenarioId)}" name="${escapeXml(name)}" time="0">\n      <failure message="${escapeXml(assertion.message)}" type="${escapeXml(assertion.type)}">${escapeXml(assertion.message)}</failure>\n    </testcase>`,
          );
        }
      }
    }

    if (run.error) {
      suiteTests += 1;
      suiteErrors += 1;
      testcaseXmls.push(
        `    <testcase classname="${escapeXml(run.scenarioId)}" name="execution" time="0">\n      <error message="${escapeXml(run.error.message)}" type="ExecutionError">${escapeXml(run.error.message)}</error>\n    </testcase>`,
      );
    }

    totalTests += suiteTests;
    totalFailures += suiteFailures;
    totalErrors += suiteErrors;

    const testcases = testcaseXmls.length > 0 ? `\n${testcaseXmls.join("\n")}\n  ` : "";
    testsuiteXmls.push(
      `  <testsuite name="${escapeXml(run.scenarioId)}" tests="${suiteTests}" failures="${suiteFailures}" errors="${suiteErrors}">${testcases}</testsuite>`,
    );
  }

  const suites = testsuiteXmls.length > 0 ? `\n${testsuiteXmls.join("\n")}\n` : "\n";
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="esure" tests="${totalTests}" failures="${totalFailures}" errors="${totalErrors}">${suites}</testsuites>\n`;
}

export async function writeArtifactFile(
  filePath: string,
  content: string,
  overwrite: boolean,
  artifactType: "report" | "JUnit" | "CSV" | "scaffold",
): Promise<void> {
  const absolutePath = resolve(filePath);

  let exists = false;
  try {
    await access(absolutePath);
    exists = true;
  } catch {
    exists = false;
  }

  if (exists && !overwrite) {
    const typeLabel =
      artifactType === "report" ? "Report" : artifactType === "JUnit" ? "JUnit" : artifactType === "CSV" ? "CSV" : "Scenario";
    throw new Error(`${typeLabel} file "${filePath}" already exists. Use --overwrite to replace it.`);
  }

  const dir = dirname(absolutePath);
  const base = basename(absolutePath);
  const tempPath = resolve(dir, `.${base}.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`);

  try {
    await writeFile(tempPath, content, "utf-8");
    await rename(tempPath, absolutePath);
  } catch (error) {
    try {
      await unlink(tempPath);
    } catch {
      // ignore unlink error
    }
    throw error;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// #62 — init command
// ─────────────────────────────────────────────────────────────────────────────

async function initCommand(filePath: string, options: CliOptions): Promise<number> {
  try {
    const ext = extname(filePath).toLowerCase();
    if (ext !== ".json" && ext !== ".yaml" && ext !== ".yml") {
      throw new Error(
        `Unsupported file extension "${ext}". Supported extensions are .json, .yaml, and .yml.`,
      );
    }

    const baseName = basename(filePath);
    const rawId = baseName.slice(0, baseName.length - ext.length);
    let scenarioId = rawId
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/^-+|-+$/g, "");
    if (!scenarioId || !/^[a-z]/.test(scenarioId)) {
      scenarioId = "custom-scenario";
    }
    if (scenarioId.length > 64) {
      scenarioId = scenarioId.slice(0, 64);
    }

    const definition = {
      schemaVersion: 1,
      id: scenarioId,
      version: 1,
      name: scenarioId.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
      description: "Send XLM between two Testnet accounts and verify the balance update.",
      network: "testnet",
      accounts: [
        { id: "sender", generate: true, fund: true },
        { id: "receiver", generate: true, fund: true },
      ],
      assets: [{ id: "xlm", type: "native" }],
      steps: [
        {
          id: "payment",
          type: "payment",
          from: "sender",
          to: "receiver",
          asset: "xlm",
          amount: "10.0000000",
        },
      ],
      assertions: [
        {
          type: "transactionConfirmed",
          step: "payment",
        },
        {
          type: "balanceChangedBy",
          account: "receiver",
          asset: "xlm",
          amount: "10.0000000",
        },
      ],
    };

    // Canonical validator verification
    validateScenarioDefinition(definition);

    let content: string;
    if (ext === ".json") {
      content = JSON.stringify(definition, null, 2) + "\n";
    } else {
      content = stringifyYaml(definition);
    }

    await writeArtifactFile(filePath, content, Boolean(options.overwrite), "scaffold");

    if (options.output === "json") {
      console.log(JSON.stringify({ created: true, path: filePath, scenarioId }, null, 2));
    } else {
      console.log(`Scenario scaffolded: ${filePath}`);
      console.log("\nNext steps:");
      console.log(`  Validate: esure validate ${filePath}`);
      console.log(`  Run:      esure run ${filePath}\n`);
    }
    return 0;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (options.output === "json") {
      console.error(JSON.stringify({ error: { message: msg } }));
    } else {
      console.error(`Error: ${msg}`);
    }
    return 1;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Commands
// ─────────────────────────────────────────────────────────────────────────────

async function listCommand(options: CliOptions): Promise<number> {
  try {
    const registry = createScenarioRegistry();
    const scenarios = registry.list();

    if (options.output === "json") {
      console.log(
        JSON.stringify(
          {
            scenarios: scenarios.map((s) => ({
              id: s.id,
              version: s.version,
              name: s.name,
              description: s.description,
            })),
          },
          null,
          2,
        ),
      );
    } else {
      console.log(`\nBundled Scenarios (${scenarios.length}):\n`);
      for (const scenario of scenarios) {
        console.log(`  ${scenario.id}`);
        console.log(`    ${scenario.name}`);
        console.log(`    ${scenario.description}\n`);
      }
    }
    return 0;
  } catch (error) {
    if (options.output === "json") {
      console.error(
        JSON.stringify({ error: { message: error instanceof Error ? error.message : String(error) } }),
      );
    } else {
      console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
    return 1;
  }
}

async function validateCommand(filePath: string, options: CliOptions): Promise<number> {
  try {
    const scenario = await loadScenarioFile(filePath);

    if (options.output === "json") {
      console.log(
        JSON.stringify(
          {
            valid: true,
            scenarioId: scenario.id,
            version: scenario.version,
            schemaVersion: scenario.schemaVersion,
            contentHash: scenario.contentHash,
          },
          null,
          2,
        ),
      );
    } else {
      const m = markers(options.ascii ?? false);
      console.log(`${m.pass} Scenario is valid`);
      console.log(`  ID: ${scenario.id}`);
      console.log(`  Version: ${scenario.version}`);
      console.log(`  Name: ${scenario.name}`);
      console.log(`  Schema: v${scenario.schemaVersion}`);
      console.log(`  Hash: ${scenario.contentHash}`);
    }
    return 0;
  } catch (error) {
    if (options.output === "json") {
      const errorObj: { message: string; issues?: string[] } = {
        message: error instanceof Error ? error.message : String(error),
      };
      if (error && typeof error === "object" && "issues" in error && Array.isArray(error.issues)) {
        errorObj.issues = error.issues as string[];
      }
      console.error(JSON.stringify({ valid: false, error: errorObj }, null, 2));
    } else {
      const m = markers(options.ascii ?? false);
      console.error(
        `${m.fail} Validation failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      if (error && typeof error === "object" && "issues" in error && Array.isArray(error.issues)) {
        for (const issue of error.issues) {
          console.error(`  - ${issue}`);
        }
      }
    }
    return 1;
  }
}

async function runCommand(target: string, options: CliOptions): Promise<number> {
  let scenario: ValidatedScenario | undefined;
  let execution: LedgerExecution | undefined;
  let report: ReturnType<typeof buildRunReport> | undefined;
  let executionError: Error | undefined;

  try {
    // Determine if target is a bundled scenario ID or file path
    if (target.includes("/") || target.includes("\\") || target.includes(".")) {
      scenario = await loadScenarioFile(target);
    } else {
      const registry = createScenarioRegistry();
      const found = registry.find(target);
      if (!found) {
        throw new Error(
          `Bundled scenario "${target}" not found. Run "esure list" to see available scenarios.`,
        );
      }
      scenario = found;
    }

    // Execute scenario on Stellar Testnet
    const gateway = new StellarTestnetGateway(
      "https://horizon-testnet.stellar.org",
      "https://friendbot.stellar.org",
    );

    if (options.output === "human") {
      console.log(`Running scenario: ${scenario.name}`);
      console.log(`ID: ${scenario.id} (v${scenario.version})\n`);
    }

    // #66 — attach onStep / onAssertion for real-time progress in human mode
    const execOptions = buildExecutionOptions(options);
    execution = await gateway.execute(scenario, execOptions);
    report = buildRunReport(scenario, execution);

    if (options.output === "json") {
      console.log(JSON.stringify(report, null, 2));
    } else {
      // In human mode the steps/assertions were already printed via callbacks.
      // Only print the final summary — do not reprint the full step list.
      const m = markers(options.ascii ?? false);
      const passed = report.status === "passed";
      console.log(`\nResult: ${passed ? "PASSED" : "FAILED"}`);
      console.log(
        `  Steps: ${report.summary.stepsPassed}/${execution.steps.length} passed`,
      );
      console.log(
        `  Assertions: ${report.summary.assertionsPassed}/${execution.assertions.length} passed`,
      );
      if (!passed) {
        console.log(`\n${m.fail} One or more checks failed.`);
      }
    }
  } catch (error) {
    executionError = error instanceof Error ? error : new Error(String(error));
    if (error && typeof error === "object" && "report" in error) {
      const rawReport = (error as { report: unknown }).report;
      if (rawReport && typeof rawReport === "object") {
        execution =
          (rawReport as { execution?: LedgerExecution }).execution ??
          (rawReport as LedgerExecution);
      }
    }

    if (options.output === "json") {
      const errorObj: { message: string; report?: unknown } = {
        message: executionError.message,
      };
      if (error && typeof error === "object" && "report" in error) {
        errorObj.report = (error as { report: unknown }).report;
      }
      console.error(JSON.stringify({ status: "error", error: errorObj }, null, 2));
    } else {
      const m = markers(options.ascii ?? false);
      console.error(
        `\n${m.fail} Run failed: ${executionError.message}`,
      );
    }
  }

  // Handle artifact exports (#59, #60, #157)
  const scenarioId = scenario?.id ?? target;
  let artifactError = false;

  if (options.reportFile) {
    try {
      const reportPayload = report ?? {
        scenarioId,
        status: "error",
        error: { message: executionError?.message ?? "Execution failed" },
        steps: execution?.steps ?? [],
        assertions: execution?.assertions ?? [],
      };
      await writeArtifactFile(
        options.reportFile,
        JSON.stringify(reportPayload, null, 2) + "\n",
        Boolean(options.overwrite),
        "report",
      );
    } catch (err: unknown) {
      artifactError = true;
      const msg = err instanceof Error ? err.message : String(err);
      if (options.output === "json") {
        console.error(JSON.stringify({ error: { message: msg } }));
      } else {
        console.error(`Error writing report file: ${msg}`);
      }
    }
  }

  if (options.junit) {
    try {
      const xml = generateJunitXml([
        {
          scenarioId,
          execution,
          error: executionError ? { message: executionError.message } : undefined,
        },
      ]);
      await writeArtifactFile(
        options.junit,
        xml,
        Boolean(options.overwrite),
        "JUnit",
      );
    } catch (err: unknown) {
      artifactError = true;
      const msg = err instanceof Error ? err.message : String(err);
      if (options.output === "json") {
        console.error(JSON.stringify({ error: { message: msg } }));
      } else {
        console.error(`Error writing JUnit file: ${msg}`);
      }
    }
  }

  if (options.csv) {
    try {
      const csv = generateCsv([
        {
          scenarioId,
          execution,
          error: executionError ? { message: executionError.message } : undefined,
        },
      ]);
      await writeArtifactFile(
        options.csv,
        csv,
        Boolean(options.overwrite),
        "CSV",
      );
    } catch (err: unknown) {
      artifactError = true;
      const msg = err instanceof Error ? err.message : String(err);
      if (options.output === "json") {
        console.error(JSON.stringify({ error: { message: msg } }));
      } else {
        console.error(`Error writing CSV file: ${msg}`);
      }
    }
  }

  if (artifactError) return 1;
  if (executionError) return 1;
  return report?.status === "passed" ? 0 : 1;
}

// ─────────────────────────────────────────────────────────────────────────────
// #67 — run-suite command
// ─────────────────────────────────────────────────────────────────────────────

interface SuiteScenarioResult {
  scenarioId: string;
  status: "passed" | "failed" | "error";
  summary?: {
    stepsPassed: number;
    stepsFailed: number;
    assertionsPassed: number;
    assertionsFailed: number;
  };
  error?: { message: string };
}

async function runSuiteCommand(
  ids: string[],
  options: CliOptions,
  failFast: boolean,
): Promise<number> {
  // 1. Validate all IDs before any network work
  let registry: ReturnType<typeof createScenarioRegistry>;
  try {
    registry = createScenarioRegistry();
  } catch (error) {
    if (options.output === "json") {
      console.error(
        JSON.stringify({ error: { message: error instanceof Error ? error.message : String(error) } }),
      );
    } else {
      console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
    return 1;
  }

  // Check for duplicate IDs
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) duplicates.push(id);
    seen.add(id);
  }
  if (duplicates.length > 0) {
    const msg = `Duplicate scenario IDs: ${duplicates.join(", ")}`;
    if (options.output === "json") {
      console.error(JSON.stringify({ error: { message: msg } }));
    } else {
      console.error(`Error: ${msg}`);
    }
    return 1;
  }

  // Check all IDs exist
  const invalid: string[] = [];
  const scenarios: ValidatedScenario[] = [];
  for (const id of ids) {
    const scenario = registry.find(id);
    if (!scenario) {
      invalid.push(id);
    } else {
      scenarios.push(scenario);
    }
  }
  if (invalid.length > 0) {
    const msg = `Unknown bundled scenario IDs: ${invalid.join(", ")}. Run "esure list" to see available scenarios.`;
    if (options.output === "json") {
      console.error(JSON.stringify({ error: { message: msg } }));
    } else {
      console.error(`Error: ${msg}`);
    }
    return 1;
  }

  // 2. Execute sequentially with isolated gateway per scenario
  const results: SuiteScenarioResult[] = [];
  const suiteJunitRuns: ScenarioRunResultForJunit[] = [];
  let suitePassed = true;

  if (options.output === "human") {
    console.log(`\nRun suite: ${ids.length} scenario(s)\n`);
  }

  for (const scenario of scenarios) {
    if (options.output === "human") {
      console.log(`Running: ${scenario.id} — ${scenario.name}`);
    }

    let result: SuiteScenarioResult;
    let execution: LedgerExecution | undefined;
    try {
      const gateway = new StellarTestnetGateway(
        "https://horizon-testnet.stellar.org",
        "https://friendbot.stellar.org",
      );
      // Per-scenario isolated execution with progress callbacks in human mode
      const execOptions = buildExecutionOptions(options);
      execution = await gateway.execute(scenario, execOptions);
      const report = buildRunReport(scenario, execution);
      result = {
        scenarioId: scenario.id,
        status: report.status,
        summary: report.summary,
      };
      suiteJunitRuns.push({
        scenarioId: scenario.id,
        execution,
      });
    } catch (error) {
      const errObj = { message: error instanceof Error ? error.message : String(error) };
      result = {
        scenarioId: scenario.id,
        status: "error",
        error: errObj,
      };
      suiteJunitRuns.push({
        scenarioId: scenario.id,
        error: errObj,
      });
    }

    results.push(result);
    if (result.status !== "passed") suitePassed = false;

    if (options.output === "human") {
      const m = markers(options.ascii ?? false);
      const marker = result.status === "passed" ? m.pass : m.fail;
      if (result.status === "error") {
        console.log(`  ${marker} ${scenario.id}: error — ${result.error?.message ?? "unknown"}\n`);
      } else {
        const s = result.summary!;
        console.log(
          `  ${marker} ${scenario.id}: ${result.status} (steps ${s.stepsPassed}/${s.stepsPassed + s.stepsFailed}, checks ${s.assertionsPassed}/${s.assertionsPassed + s.assertionsFailed})\n`,
        );
      }
    }

    if (!suitePassed && failFast) break;
  }

  // 3. Output final summary
  const passedCount = results.filter((r) => r.status === "passed").length;
  const failedCount = results.length - passedCount;

  if (options.output === "json") {
    console.log(
      JSON.stringify(
        {
          status: suitePassed ? "passed" : "failed",
          total: results.length,
          passed: passedCount,
          failed: failedCount,
          scenarios: results,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(`Suite result: ${suitePassed ? "PASSED" : "FAILED"}`);
    console.log(`  ${passedCount}/${results.length} scenarios passed`);
    if (failFast && !suitePassed && results.length < ids.length) {
      console.log(
        `  Stopped early (--fail-fast). ${ids.length - results.length} scenario(s) not run.`,
      );
    }
  }

  // Handle artifacts for suite (#59, #60)
  let artifactError = false;

  if (options.reportFile) {
    try {
      const suiteReportPayload = {
        status: suitePassed ? "passed" : "failed",
        total: results.length,
        passed: passedCount,
        failed: failedCount,
        scenarios: results,
      };
      await writeArtifactFile(
        options.reportFile,
        JSON.stringify(suiteReportPayload, null, 2) + "\n",
        Boolean(options.overwrite),
        "report",
      );
    } catch (err: unknown) {
      artifactError = true;
      const msg = err instanceof Error ? err.message : String(err);
      if (options.output === "json") {
        console.error(JSON.stringify({ error: { message: msg } }));
      } else {
        console.error(`Error writing report file: ${msg}`);
      }
    }
  }

  if (options.junit) {
    try {
      const xml = generateJunitXml(suiteJunitRuns);
      await writeArtifactFile(
        options.junit,
        xml,
        Boolean(options.overwrite),
        "JUnit",
      );
    } catch (err: unknown) {
      artifactError = true;
      const msg = err instanceof Error ? err.message : String(err);
      if (options.output === "json") {
        console.error(JSON.stringify({ error: { message: msg } }));
      } else {
        console.error(`Error writing JUnit file: ${msg}`);
      }
    }
  }

  if (artifactError) return 1;
  return suitePassed ? 0 : 1;
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const { command, args, options, failFast } = parseCliArgs();

  if (options.version) {
    showVersion();
    return 0;
  }

  if (options.help || !command) {
    showHelp();
    return command ? 0 : 1;
  }

  switch (command) {
    case "list":
      return listCommand(options);
    case "validate":
      if (args.length === 0) {
        console.error("Error: Missing file path argument");
        console.error("Usage: esure validate <file>");
        return 1;
      }
      return validateCommand(args[0], options);
    case "init":
      if (args.length === 0) {
        console.error("Error: Missing file path argument");
        console.error("Usage: esure init <file>");
        return 1;
      }
      return initCommand(args[0], options);
    case "run":
      if (args.length === 0) {
        console.error("Error: Missing scenario ID or file path");
        console.error("Usage: esure run <scenario-id> or esure run <file>");
        return 1;
      }
      return runCommand(args[0], options);
    case "run-suite":
      if (args.length === 0) {
        console.error("Error: Missing scenario IDs");
        console.error("Usage: esure run-suite <id> [<id>...]");
        return 1;
      }
      return runSuiteCommand(args, options, failFast);
    default:
      console.error(`Error: Unknown command "${command}"`);
      console.error('Run "esure --help" for usage information');
      return 1;
  }
}

main()
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error) => {
    console.error("Fatal error:", error);
    process.exitCode = 1;
  });
