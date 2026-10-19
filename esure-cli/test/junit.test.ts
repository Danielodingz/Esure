import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { escapeXml, generateJunitXml } from "../src/cli.js";

const execFileAsync = promisify(execFile);
const cliPath = resolve(__dirname, "../dist/cli.js");

describe("JUnit XML export (#60)", () => {
  describe("Unit tests for XML generation", () => {
    it("escapes special characters correctly in names and messages", () => {
      const unsafe = `Text with & and <tag> and "quotes" and 'apostrophes'`;
      const escaped = escapeXml(unsafe);
      expect(escaped).toBe(
        "Text with &amp; and &lt;tag&gt; and &quot;quotes&quot; and &apos;apostrophes&apos;",
      );
    });

    it("generates valid XML for passing scenario steps and assertions", () => {
      const xml = generateJunitXml([
        {
          scenarioId: "test-passing",
          execution: {
            scenarioId: "test-passing",
            scenarioVersion: 1,
            steps: [
              {
                id: "pay",
                type: "payment",
                status: "passed",
                message: "Payment confirmed",
              },
            ],
            assertions: [
              {
                type: "accountExists",
                status: "passed",
                message: "Account bob exists",
                expected: true,
                actual: true,
              },
            ],
          },
        },
      ]);

      expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
      expect(xml).toContain('<testsuites name="esure" tests="2" failures="0" errors="0">');
      expect(xml).toContain('<testsuite name="test-passing" tests="2" failures="0" errors="0">');
      expect(xml).toContain(
        '<testcase classname="test-passing" name="step pay: Payment confirmed" time="0"/>',
      );
      expect(xml).toContain(
        '<testcase classname="test-passing" name="assertion accountExists: Account bob exists" time="0"/>',
      );
      expect(xml).not.toContain("<failure");
      expect(xml).not.toContain("<error");
    });

    it("represents expected ledger failures that pass assertions as passing test cases", () => {
      const xml = generateJunitXml([
        {
          scenarioId: "insufficient-xlm-balance",
          execution: {
            scenarioId: "insufficient-xlm-balance",
            scenarioVersion: 1,
            steps: [
              {
                id: "overdraw",
                type: "payment",
                status: "passed", // Expected failure marked as passed by ledger gateway
                message: "Operation failed with tx_failed [op_underfunded] as expected.",
              },
            ],
            assertions: [
              {
                type: "stepFailedWith",
                status: "passed",
                message: "Step overdraw failed with tx_failed [op_underfunded] as expected.",
                expected: "tx_failed:op_underfunded",
                actual: "tx_failed:op_underfunded",
              },
            ],
          },
        },
      ]);

      expect(xml).toContain('tests="2" failures="0" errors="0"');
      expect(xml).toContain(
        '<testcase classname="insufficient-xlm-balance" name="step overdraw: Operation failed with tx_failed [op_underfunded] as expected." time="0"/>',
      );
      expect(xml).not.toContain("<failure");
      expect(xml).not.toContain("<error");
    });

    it("records unexpected failures with <failure> elements", () => {
      const xml = generateJunitXml([
        {
          scenarioId: "failing-scenario",
          execution: {
            scenarioId: "failing-scenario",
            scenarioVersion: 1,
            steps: [
              {
                id: "pay",
                type: "payment",
                status: "failed",
                message: "Transaction submission timed out & failed",
              },
            ],
            assertions: [
              {
                type: "accountExists",
                status: "failed",
                message: "Account does not exist <timeout>",
                expected: true,
                actual: false,
              },
            ],
          },
        },
      ]);

      expect(xml).toContain('tests="2" failures="2" errors="0"');
      expect(xml).toContain(
        '<failure message="Transaction submission timed out &amp; failed" type="payment">Transaction submission timed out &amp; failed</failure>',
      );
      expect(xml).toContain(
        '<failure message="Account does not exist &lt;timeout&gt;" type="accountExists">Account does not exist &lt;timeout&gt;</failure>',
      );
    });

    it("records execution errors with <error> element without double-counting cases", () => {
      const xml = generateJunitXml([
        {
          scenarioId: "crashed-scenario",
          error: { message: "Network connection refused" },
        },
      ]);

      expect(xml).toContain('tests="1" failures="0" errors="1"');
      expect(xml).toContain(
        '<testcase classname="crashed-scenario" name="execution" time="0">',
      );
      expect(xml).toContain(
        '<error message="Network connection refused" type="ExecutionError">Network connection refused</error>',
      );
    });

    it("aggregates multiple scenarios in suite runs", () => {
      const xml = generateJunitXml([
        {
          scenarioId: "suite-scenario-1",
          execution: {
            scenarioId: "suite-scenario-1",
            scenarioVersion: 1,
            steps: [{ id: "s1", type: "payment", status: "passed", message: "ok" }],
            assertions: [],
          },
        },
        {
          scenarioId: "suite-scenario-2",
          error: { message: "Gateway error" },
        },
      ]);

      expect(xml).toContain('tests="2" failures="0" errors="1"');
      expect(xml).toContain('<testsuite name="suite-scenario-1" tests="1" failures="0" errors="0">');
      expect(xml).toContain('<testsuite name="suite-scenario-2" tests="1" failures="0" errors="1">');
    });
  });

  describe("Integration tests via CLI flags", () => {
    let tempDir: string;
    let failingScenarioPath: string;

    beforeAll(async () => {
      tempDir = await mkdtemp(join(tmpdir(), "esure-junit-cli-"));

      failingScenarioPath = join(tempDir, "failing.json");
      await writeFile(
        failingScenarioPath,
        JSON.stringify({
          schemaVersion: 1,
          id: "failing-cli-test",
          version: 1,
          name: "Failing CLI Test",
          description: "Invalid network scenario",
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

    it("writes JUnit XML file on scenario error with --junit", async () => {
      const junitPath = join(tempDir, "results.xml");

      try {
        await execFileAsync(
          process.execPath,
          [cliPath, "run", failingScenarioPath, "--junit", junitPath],
          { cwd: tempDir },
        );
      } catch {
        // Expected exit code 1
      }

      const xml = await readFile(junitPath, "utf-8");
      expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
      expect(xml).toContain('classname=');
      expect(xml).toContain('failing.json');
      expect(xml).toContain('<error message=');
    });

    it("supports --junit-file alias", async () => {
      const junitPath = join(tempDir, "results-alias.xml");

      try {
        await execFileAsync(
          process.execPath,
          [cliPath, "run", failingScenarioPath, "--junit-file", junitPath],
          { cwd: tempDir },
        );
      } catch {
        // Expected exit code 1
      }

      const xml = await readFile(junitPath, "utf-8");
      expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    });

    it("keeps XML artifact separate from console output mode", async () => {
      const junitPath = join(tempDir, "results-json.xml");

      let consoleOutput = "";
      try {
        const res = await execFileAsync(
          process.execPath,
          [cliPath, "run", failingScenarioPath, "--output", "json", "--junit", junitPath],
          { cwd: tempDir },
        );
        consoleOutput = res.stdout;
      } catch (err: any) {
        consoleOutput = err.stderr || err.stdout;
      }

      // Console output remains JSON
      const parsed = JSON.parse(consoleOutput);
      expect(parsed.status).toBe("error");

      // While file output is XML
      const xml = await readFile(junitPath, "utf-8");
      expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    });
  });
});
