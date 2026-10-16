import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, getRun, listScenarios, startRun, type RunReport, type ScenarioSummary } from "./api";

const scenario: ScenarioSummary = {
  id: "xlm-payment",
  version: 1,
  name: "XLM payment",
  description: "Transfer XLM on Testnet.",
  contentHash: "sha256:scenario",
};

const run: RunReport = {
  id: "run-123",
  scenarioId: scenario.id,
  scenarioVersion: 1,
  scenarioSchemaVersion: 1,
  scenarioContentHash: scenario.contentHash,
  network: "testnet",
  status: "failed",
  createdAt: "2026-10-16T00:00:00.000Z",
  completedAt: "2026-10-16T00:00:10.000Z",
  steps: [{
    id: "pay",
    type: "payment",
    status: "failed",
    message: "Payment failed.",
    transactionHash: "f".repeat(64),
    stellarOperationCodes: ["op_no_trust"],
  }],
  assertions: [{
    type: "balanceEquals",
    status: "failed",
    expected: "100.0000000",
    actual: "0.0000000",
    message: "Balance mismatch.",
  }],
  summary: { stepsPassed: 0, stepsFailed: 1, assertionsPassed: 0, assertionsFailed: 1 },
  error: {
    code: "STELLAR_TRANSACTION_FAILED",
    message: "Payment failed.",
    category: "stellar",
    retryable: false,
    failedStepId: "pay",
  },
};

function mockResponse(body: string, status = 200) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, {
    status,
    headers: { "content-type": "application/json" },
  })));
}

async function expectInvalidResponse(promise: Promise<unknown>) {
  const error = await promise.catch((reason: unknown) => reason);
  expect(error).toBeInstanceOf(ApiError);
  if (!(error instanceof ApiError)) throw new Error("Expected ApiError");
  expect(error).toMatchObject({
    message: "The server returned an invalid response. Please try again.",
    code: "INVALID_RESPONSE",
    status: 200,
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("frontend API response validation", () => {
  it("turns malformed JSON from a successful response into a recoverable API error", async () => {
    mockResponse("<html>upstream failure details</html>");

    await expectInvalidResponse(listScenarios());
    await expectInvalidResponse(getRun("run-123"));
  });

  it("rejects empty objects and missing catalogue items", async () => {
    mockResponse("{}");
    await expectInvalidResponse(listScenarios());
    await expectInvalidResponse(getRun("run-123"));

    mockResponse('{"scenarios":[]}');
    await expectInvalidResponse(listScenarios());
  });

  it("rejects catalogue rows with invalid field types", async () => {
    mockResponse(JSON.stringify({ items: [{ ...scenario, version: "1" }] }));

    await expectInvalidResponse(listScenarios());
  });

  it("rejects unknown run statuses and malformed report arrays", async () => {
    mockResponse(JSON.stringify({ ...run, status: "complete" }));
    await expectInvalidResponse(getRun("run-123"));

    mockResponse(JSON.stringify({ ...run, steps: {} }));
    await expectInvalidResponse(getRun("run-123"));

    mockResponse(JSON.stringify({
      ...run,
      assertions: [{ ...run.assertions[0], status: "skipped" }],
    }));
    await expectInvalidResponse(getRun("run-123"));

    mockResponse(JSON.stringify({ ...run, summary: { ...run.summary, stepsFailed: "1" } }));
    await expectInvalidResponse(getRun("run-123"));
  });

  it("preserves valid decimal strings, optional fields, and run data", async () => {
    mockResponse(JSON.stringify({ items: [scenario] }));
    await expect(listScenarios()).resolves.toEqual([scenario]);

    mockResponse(JSON.stringify(run));
    const result = await getRun("run-123");
    expect(result.assertions[0].expected).toBe("100.0000000");
    expect(result.assertions[0].actual).toBe("0.0000000");
    expect(result.steps[0].transactionHash).toBe("f".repeat(64));
    expect(result.steps[0].stellarOperationCodes).toEqual(["op_no_trust"]);
    expect(result.error?.failedStepId).toBe("pay");

    mockResponse(JSON.stringify(run));
    await expect(startRun("xlm-payment")).resolves.toEqual(run);
  });

  it("does not expose malformed upstream bodies for unsuccessful responses", async () => {
    mockResponse("<html>private upstream diagnostic</html>", 502);

    const error = await listScenarios().catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      message: "The request failed.",
      code: "UNKNOWN_ERROR",
      status: 502,
    });
    if (!(error instanceof ApiError)) throw new Error("Expected ApiError");
    expect(error.message).not.toContain("private upstream diagnostic");
  });
});
