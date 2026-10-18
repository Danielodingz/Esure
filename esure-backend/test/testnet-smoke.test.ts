import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import type { RunReport } from "../src/domain.js";
import { completeScenario } from "./fixtures.js";

const live = process.env.RUN_STELLAR_SMOKE === "1";

describe.runIf(live)("real Stellar Testnet smoke", () => {
  const app = buildApp({
    config: loadConfig({
      RUN_TIMEOUT_MS: "180000",
      STEP_TIMEOUT_MS: "45000",
      MAX_CONCURRENT_RUNS: "1",
      RUN_RATE_LIMIT_MAX: "20",
    }),
  });

  beforeAll(async () => app.ready());
  afterAll(async () => app.close());

  for (const scenarioId of ["xlm-payment", "issued-asset-payment", "missing-trustline", "payment-with-memo", "unfunded-destination", "trustline-limit-exact"] as const) {
    it(`executes ${scenarioId} through the public API`, async () => {
      const started = await app.inject({
        method: "POST",
        url: "/api/v1/runs",
        payload: { scenarioId, inputs: {} },
      });
      expect(started.statusCode).toBe(202);
      const report = await waitForRun(started.json().id as string);
      expect(report.status).toBe("passed");
      expect(report.steps.every((step) => step.status === "passed")).toBe(true);
      expect(report.assertions.every((assertion) => assertion.status === "passed")).toBe(true);
      if (scenarioId === "payment-with-memo") {
        expect(report.assertions).toContainEqual(expect.objectContaining({
          type: "transactionMemoEquals", status: "passed", expected: "Esure memo tracking", actual: "Esure memo tracking",
        }));
      }
      if (scenarioId === "xlm-payment") {
        expect(report.assertions[0]).toMatchObject({ type: "balanceChangedBy", expected: "5", actual: "5" });
      }
      if (scenarioId === "missing-trustline") {
        expect(report.assertions[0]).toMatchObject({
          type: "stepFailedWith",
          actual: "tx_failed/op_no_trust",
        });
      }
      if (scenarioId === "unfunded-destination") {
        expect(report.steps).toContainEqual(expect.objectContaining({
          id: "pay-unfunded-destination", status: "passed", stellarTransactionCode: "tx_failed", stellarOperationCodes: ["op_no_destination"],
        }));
        expect(report.assertions).toEqual([expect.objectContaining({
          type: "stepFailedWith", status: "passed", expected: "tx_failed/op_no_destination", actual: "tx_failed/op_no_destination",
        })]);
      }
      if (scenarioId === "trustline-limit-exact") {
        expect(report.assertions).toEqual([
          expect.objectContaining({ type: "stepSucceeded", status: "passed", actual: true }),
          expect.objectContaining({ type: "stepSucceeded", status: "passed", actual: true }),
          expect.objectContaining({ type: "transactionConfirmed", status: "passed", actual: true }),
          expect.objectContaining({ type: "balanceEquals", status: "passed", expected: "100.1234567", actual: "100.1234567" }),
        ]);
      }
      const downloaded = await app.inject({ method: "GET", url: `/api/v1/runs/${report.id}/report` });
      expect(downloaded.statusCode).toBe(200);
      expect(downloaded.headers["content-disposition"]).toContain(`esure-run-${report.id}.json`);
    }, 150_000);
  }

  it("executes a completely new inline scenario without source registration", async () => {
    const definition = { ...completeScenario(), id: "live-inline-complete", name: "Live inline complete" };
    const started = await app.inject({ method: "POST", url: "/api/v1/runs/definitions", payload: definition });
    expect(started.statusCode).toBe(202);
    const report = await waitForRun(started.json().id as string);
    expect(report.status, JSON.stringify(report, null, 2)).toBe("passed");
    expect(report.scenarioId).toBe("live-inline-complete");
    expect(report.scenarioContentHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(new Set(report.assertions.map((assertion) => assertion.type))).toEqual(new Set([
      "balanceEquals", "balanceChangedBy", "stepSucceeded", "stepFailedWith",
      "trustlineExists", "trustlineMissing", "transactionConfirmed", "accountExists",
    ]));
    expect(report.assertions.every((assertion) => assertion.status === "passed")).toBe(true);
    expect(report.assertions.find((assertion) => assertion.type === "stepFailedWith")).toMatchObject({
      expected: "tx_failed/op_no_trust",
      actual: "tx_failed/op_no_trust",
    });
  }, 150_000);

  async function waitForRun(id: string): Promise<RunReport> {
    const deadline = Date.now() + 140_000;
    while (Date.now() < deadline) {
      const response = await app.inject({ method: "GET", url: `/api/v1/runs/${id}` });
      const report = response.json() as RunReport;
      if (report.status === "passed" || report.status === "failed") return report;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(`Run ${id} did not finish before the smoke-test deadline`);
  }
});
