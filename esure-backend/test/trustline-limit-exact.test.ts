import { Account, Asset, Horizon, Transaction } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createScenarioRegistry } from "../src/scenarios.js";
import { prepareScenario } from "../src/scenario-loader.js";
import { StellarTestnetGateway } from "../src/stellar-gateway.js";
import { InMemoryRunStore } from "../src/run-store.js";
import { RunService } from "../src/run-service.js";

afterEach(() => vi.restoreAllMocks());

describe("exact trustline limit fixture", () => {
  it("validates the explicit fractional limit, equal payment, and exact balance assertion", () => {
    const scenario = createScenarioRegistry().find("trustline-limit-exact")!;
    const { contentHash: _hash, ...definition } = scenario;
    expect(prepareScenario(definition)).toEqual(scenario);
    expect(scenario.accounts).toEqual([
      { id: "issuer", generate: true, fund: true },
      { id: "recipient", generate: true, fund: true },
    ]);
    expect(scenario.steps).toEqual([
      { id: "create-limited-trustline", type: "changeTrust", account: "recipient", asset: "limited-asset", limit: "100.1234567" },
      { id: "fill-trustline", type: "payment", from: "issuer", to: "recipient", asset: "limited-asset", amount: "100.1234567" },
    ]);
    expect(scenario.assertions).toEqual([
      { type: "stepSucceeded", step: "create-limited-trustline" },
      { type: "stepSucceeded", step: "fill-trustline" },
      { type: "transactionConfirmed", step: "fill-trustline" },
      { type: "balanceEquals", account: "recipient", asset: "limited-asset", amount: "100.1234567" },
    ]);
  });

  it.each([
    ["exact balance and confirmation", "100.1234567", 123, "passed"],
    ["balance one stroop short", "100.1234566", 123, "failed"],
    ["missing confirmation", "100.1234567", 0, "failed"],
  ] as const)("checks the built operations and report: %s", async (_label, finalBalance, ledger, expectedStatus) => {
    const scenario = createScenarioRegistry().find("trustline-limit-exact")!;
    let recipient: string | undefined;
    let issuer: string | undefined;
    let paid = false;
    const funding = vi.fn<typeof fetch>().mockImplementation(async () => new Response("{}", { status: 200 }));
    vi.spyOn(Horizon.Server.prototype, "loadAccount").mockImplementation(async (key) => {
      const balances = paid && key === recipient ? [{ asset_type: "credit_alphanum12", asset_code: "LIMITED", asset_issuer: issuer, balance: finalBalance }] : [];
      return Object.assign(new Account(key, "1"), { balances }) as unknown as Awaited<ReturnType<Horizon.Server["loadAccount"]>>;
    });
    vi.spyOn(Horizon.Server.prototype, "fetchTimebounds").mockResolvedValue({ minTime: 0, maxTime: 2_000_000_000 });
    const submit = vi.spyOn(Horizon.Server.prototype, "submitTransaction").mockImplementation(async (transaction) => {
      const built = transaction as Transaction;
      const operation = built.operations[0]!;
      if (operation.type === "changeTrust") {
        if (!(operation.line instanceof Asset)) throw new Error("Expected a classic issued asset");
        recipient = built.source;
        issuer = operation.line.getIssuer();
      } else if (operation.type === "payment") paid = true;
      return { hash: "a".repeat(64), ledger } as Horizon.HorizonApi.SubmitTransactionResponse;
    });
    const gateway = new StellarTestnetGateway("https://horizon.example", "https://friendbot.example", { fetch: funding });
    const store = new InMemoryRunStore();
    const service = new RunService(store, gateway, { maxConcurrentRuns: 1, runTimeoutMs: 5_000, stepTimeoutMs: 1_000 });
    const started = await service.start(scenario);
    await vi.waitFor(() => expect(store.get(started.id)?.completedAt).toBeDefined());
    await service.drain();
    const report = store.get(started.id)!;
    expect(report.status).toBe(expectedStatus);
    expect(funding).toHaveBeenCalledTimes(2);
    expect(submit).toHaveBeenCalledTimes(2);
    const trust = submit.mock.calls[0]![0] as Transaction;
    const payment = submit.mock.calls[1]![0] as Transaction;
    expect(trust.operations).toHaveLength(1);
    expect(payment.operations).toHaveLength(1);
    const trustOperation = trust.operations[0]!;
    const paymentOperation = payment.operations[0]!;
    if (trustOperation.type !== "changeTrust" || paymentOperation.type !== "payment") throw new Error("Unexpected operation types");
    if (!(trustOperation.line instanceof Asset)) throw new Error("Expected a classic issued asset");
    expect(trustOperation.limit).toBe("100.1234567");
    expect(paymentOperation.amount).toBe(trustOperation.limit);
    expect(paymentOperation.asset.getCode()).toBe("LIMITED");
    expect(paymentOperation.asset.getIssuer()).toBe(payment.source);
    expect(trustOperation.line.getIssuer()).toBe(payment.source);
    expect(paymentOperation.destination).toBe(trust.source);
    expect(payment.source).not.toBe(trust.source);
    expect(new Set(funding.mock.calls.map(([url]) => new URL(String(url)).searchParams.get("addr")))).toEqual(new Set([trust.source, payment.source]));
    expect(report.assertions).toContainEqual(expect.objectContaining({ type: "stepSucceeded", status: "passed", actual: true }));
    expect(report.assertions).toContainEqual(expect.objectContaining({ type: "transactionConfirmed", status: ledger ? "passed" : "failed", actual: Boolean(ledger) }));
    expect(report.assertions).toContainEqual(expect.objectContaining({ type: "balanceEquals", status: finalBalance === "100.1234567" ? "passed" : "failed", expected: "100.1234567", actual: finalBalance }));
    expect(JSON.stringify(report)).not.toContain(trust.source);
    expect(JSON.stringify(report)).not.toContain(payment.source);
  });
});
