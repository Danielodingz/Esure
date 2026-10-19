import { Account, Horizon, Transaction } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createScenarioRegistry } from "../src/scenarios.js";
import { prepareScenario } from "../src/scenario-loader.js";
import { StellarTestnetGateway } from "../src/stellar-gateway.js";
import { InMemoryRunStore } from "../src/run-store.js";
import { RunService } from "../src/run-service.js";

afterEach(() => vi.restoreAllMocks());

function rejection(transaction: string, operations: string[]) {
  return { response: { data: { extras: {
    result_codes: { transaction, operations }, envelope_xdr: "private-envelope",
  } } } };
}

describe("unfunded destination fixture", () => {
  it("validates as a native payment with only the sender funded", () => {
    const scenario = createScenarioRegistry().find("unfunded-destination")!;
    const { contentHash: _hash, ...definition } = scenario;
    expect(prepareScenario(definition)).toEqual(scenario);
    expect(scenario.accounts).toEqual([
      { id: "sender", generate: true, fund: true },
      { id: "destination", generate: true, fund: false },
    ]);
    expect(scenario.assets).toEqual([{ id: "xlm", type: "native" }]);
    expect(scenario.steps).toEqual([{ id: "pay-unfunded-destination", type: "payment", from: "sender", to: "destination", asset: "xlm", amount: "1" }]);
    expect(scenario.assertions).toEqual([{ type: "stepFailedWith", step: "pay-unfunded-destination", transactionCode: "tx_failed", operationCodes: ["op_no_destination"] }]);
  });

  it.each([
    ["exact expected failure", rejection("tx_failed", ["op_no_destination"]), "passed"],
    ["different operation failure", rejection("tx_failed", ["op_underfunded"]), "failed"],
    ["different transaction failure", rejection("tx_bad_seq", []), "failed"],
    ["extra operation code", rejection("tx_failed", ["op_no_destination", "op_success"]), "failed"],
    ["missing operation code", rejection("tx_failed", []), "failed"],
    ["network failure", new Error("private-envelope"), "failed"],
    ["unexpected success", undefined, "failed"],
  ] as const)("passes only for the exact expected outcome: %s", async (_label, error, expectedStatus) => {
    const scenario = createScenarioRegistry().find("unfunded-destination")!;
    const fetchFunding = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}", { status: 200 }));
    const loadAccount = vi.spyOn(Horizon.Server.prototype, "loadAccount").mockImplementation(async (key) =>
      new Account(key, "1") as unknown as Awaited<ReturnType<Horizon.Server["loadAccount"]>>);
    vi.spyOn(Horizon.Server.prototype, "fetchTimebounds").mockResolvedValue({ minTime: 0, maxTime: 2_000_000_000 });
    const submit = vi.spyOn(Horizon.Server.prototype, "submitTransaction");
    if (error === undefined) submit.mockResolvedValue({ hash: "a".repeat(64), ledger: 123 } as Horizon.HorizonApi.SubmitTransactionResponse);
    else submit.mockRejectedValue(error);
    const gateway = new StellarTestnetGateway("https://horizon.example", "https://friendbot.example", {
      fetch: fetchFunding, horizonRetry: { maxRetries: 0 },
    });
    const store = new InMemoryRunStore();
    const service = new RunService(store, gateway, { maxConcurrentRuns: 1, runTimeoutMs: 5_000, stepTimeoutMs: 1_000 });
    const started = await service.start(scenario);
    await vi.waitFor(() => expect(store.get(started.id)?.completedAt).toBeDefined());
    await service.drain();
    const report = store.get(started.id)!;
    expect(report.status).toBe(expectedStatus);

    // Observe actual funding requests and the transaction submitted to Horizon.
    expect(fetchFunding).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledTimes(1);
    const built = submit.mock.calls[0]![0] as Transaction;
    expect(built.operations).toHaveLength(1);
    const payment = built.operations[0]!;
    expect(payment.type).toBe("payment");
    if (payment.type !== "payment") throw new Error("Expected a payment operation");
    expect(payment.asset.isNative()).toBe(true);
    expect(payment.amount).toBe("1.0000000");
    const fundingUrl = new URL(String(fetchFunding.mock.calls[0]![0]));
    expect(fundingUrl.searchParams.get("addr")).toBe(built.source);
    expect(payment.destination).not.toBe(built.source);
    expect(loadAccount).toHaveBeenCalledExactlyOnceWith(built.source);
    expect(JSON.stringify(report)).not.toContain("private-envelope");
    expect(JSON.stringify(report)).not.toContain(built.source);
    expect(JSON.stringify(report)).not.toContain(payment.destination);

    if (expectedStatus === "passed") {
      expect(report.steps).toContainEqual(expect.objectContaining({
        id: "pay-unfunded-destination", status: "passed", stellarTransactionCode: "tx_failed", stellarOperationCodes: ["op_no_destination"],
      }));
      expect(report.assertions).toEqual([expect.objectContaining({
        type: "stepFailedWith", status: "passed", expected: "tx_failed/op_no_destination", actual: "tx_failed/op_no_destination",
      })]);
    } else {
      expect(report.error).toBeDefined();
      expect(report.assertions.every((assertion) => assertion.status === "passed") && report.summary.stepsFailed === 0).toBe(false);
    }
  });
});
