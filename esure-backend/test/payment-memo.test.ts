import { Account, Horizon, Networks, Transaction } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareScenario } from "../src/scenario-loader.js";
import { ScenarioValidationError } from "../src/scenario-schema.js";
import { createScenarioRegistry } from "../src/scenarios.js";
import { StellarTestnetGateway } from "../src/stellar-gateway.js";
import { openApiDocument } from "../src/openapi.js";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import type { ApiOperations } from "../src/generated/api-types.js";
import type { ScenarioDefinition } from "../src/domain.js";

function definition(memo: string = "Esure memo tracking"): ScenarioDefinition {
  return {
    schemaVersion: 1, id: "memo-test", version: 1, name: "Memo test", description: "Synthetic memo test", network: "testnet",
    accounts: [{ id: "sender", generate: true, fund: false }, { id: "recipient", generate: true, fund: false }],
    assets: [{ id: "xlm", type: "native" }],
    steps: [{ id: "pay", type: "payment", from: "sender", to: "recipient", asset: "xlm", amount: "1", memo }],
    assertions: [{ type: "transactionMemoEquals", step: "pay", memo }],
  };
}

afterEach(() => vi.restoreAllMocks());

describe("text memo validation and contract", () => {
  it.each(["", "a".repeat(28), "é".repeat(14), "😀".repeat(7), "界".repeat(9) + "a"])("accepts a memo of %s", (memo) => {
    const input: ApiOperations["startDefinitionRun"]["body"] = definition(memo);
    expect(prepareScenario(input).steps[0]).toMatchObject({ memo });
  });

  it.each(["a".repeat(29), "é".repeat(14) + "a", "😀".repeat(7) + "a", "界".repeat(10), "\ud800", "\udc00"])("rejects invalid text %s in steps and assertions", (memo) => {
    const stepInput = definition();
    if (stepInput.steps[0]?.type === "payment") stepInput.steps[0].memo = memo;
    expect(() => prepareScenario(stepInput)).toThrow(ScenarioValidationError);
    const assertionInput = definition();
    assertionInput.assertions = [{ type: "transactionMemoEquals", step: "pay", memo }];
    expect(() => prepareScenario(assertionInput)).toThrow(ScenarioValidationError);
  });

  it("rejects memo objects, other memo types, unknown targets and non-payment targets", () => {
    for (const memo of [{ type: "text", value: "hello" }, 123, null]) {
      const input = definition() as any;
      input.steps[0].memo = memo;
      expect(() => prepareScenario(input)).toThrow(ScenarioValidationError);
    }
    const unknown = definition();
    unknown.assertions = [{ type: "transactionMemoEquals", step: "unknown", memo: "hello" }];
    expect(() => prepareScenario(unknown)).toThrow(ScenarioValidationError);
    const nonPayment = definition();
    nonPayment.steps = [{ id: "pay", type: "manageSellOffer", account: "sender", sellingAsset: "xlm", buyingAsset: "usd", amount: "1", price: "1" }];
    nonPayment.assets.push({ id: "usd", type: "issued", code: "USD", issuer: "sender" });
    expect(() => prepareScenario(nonPayment)).toThrow(ScenarioValidationError);
  });

  it("publishes the payment memo and assertion in OpenAPI and loads the corrected fixture", () => {
    const schema = JSON.stringify(openApiDocument().components.schemas.ScenarioV1);
    expect(schema).toContain("transactionMemoEquals");
    expect(schema).toContain("28 UTF-8 bytes");
    const fixture = createScenarioRegistry().find("payment-with-memo")!;
    expect(fixture.version).toBe(2);
    expect(fixture.steps[0]).toMatchObject({ type: "payment", memo: "Esure memo tracking" });
    expect(fixture.assertions).toContainEqual({ type: "transactionMemoEquals", step: "send-xlm-with-memo", memo: "Esure memo tracking" });
  });

  it("validates byte limits through the public API before executing", async () => {
    const execute = vi.fn();
    const app = buildApp({ config: loadConfig({}), ledger: { execute } });
    try {
      for (const url of ["/api/v1/scenarios/validate", "/api/v1/runs/definitions"]) {
        const invalid = await app.inject({ method: "POST", url, payload: definition("😀".repeat(8)) });
        expect(invalid.statusCode).toBe(400);
      }
      const valid = await app.inject({ method: "POST", url: "/api/v1/scenarios/validate", payload: definition("😀".repeat(7)) });
      expect(valid.statusCode).toBe(200);
      expect(execute).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
});

function mockNetwork(record: Record<string, unknown>) {
  vi.spyOn(Horizon.Server.prototype, "loadAccount").mockImplementation(async (key) =>
    new Account(key, "1") as unknown as Awaited<ReturnType<Horizon.Server["loadAccount"]>>);
  vi.spyOn(Horizon.Server.prototype, "fetchTimebounds").mockResolvedValue({ minTime: 0, maxTime: 2_000_000_000 });
  const submit = vi.spyOn(Horizon.Server.prototype, "submitTransaction").mockResolvedValue({ hash: "a".repeat(64), ledger: 123 } as Horizon.HorizonApi.SubmitTransactionResponse);
  const call = vi.fn().mockResolvedValue(record);
  const lookup = vi.fn().mockReturnValue({ call });
  vi.spyOn(Horizon.Server.prototype, "transactions").mockReturnValue({ transaction: lookup } as unknown as ReturnType<Horizon.Server["transactions"]>);
  const gateway = new StellarTestnetGateway("https://horizon.example", "https://friendbot.example", { sleep: async () => {}, horizonRetry: { maxRetries: 1 } });
  return { gateway, submit, lookup, call };
}

describe("submitted payment memo and confirmed evidence", () => {
  it.each(["", "Esure memo tracking", "😀".repeat(7)])("signs the actual transaction with text memo %s", async (memo) => {
    const { gateway, submit, lookup } = mockNetwork({ hash: "a".repeat(64), successful: true, memo_type: "text", memo });
    const result = await gateway.execute(prepareScenario(definition(memo)));
    const built = submit.mock.calls[0]![0] as Transaction;
    // Decode the signed envelope passed to Horizon, not the scenario definition.
    const decoded = new Transaction(built.toXDR(), Networks.TESTNET);
    expect(decoded.memo.type).toBe("text");
    expect(Buffer.from(decoded.memo.value as string | Buffer).toString("utf8")).toBe(memo);
    expect(decoded.operations[0]?.type).toBe("payment");
    expect(decoded.signatures).toHaveLength(1);
    expect(lookup).toHaveBeenCalledWith("a".repeat(64));
    expect(result.assertions[0]).toMatchObject({ type: "transactionMemoEquals", status: "passed", expected: memo, actual: memo });
  });

  it("leaves ordinary payment transactions without a memo", async () => {
    const { gateway, submit, lookup } = mockNetwork({});
    const input = definition();
    if (input.steps[0]?.type === "payment") delete input.steps[0].memo;
    input.assertions = [{ type: "stepSucceeded", step: "pay" }];
    await gateway.execute(prepareScenario(input));
    expect((submit.mock.calls[0]![0] as Transaction).memo.type).toBe("none");
    expect(lookup).not.toHaveBeenCalled();
  });

  it.each([
    { memo_type: "text", memo: "different" },
    { memo_type: "none" },
    { memo_type: "id", memo: "123" },
    { memo_type: "text", memo: `S${"A".repeat(55)}` },
    { memo_type: "text", memo: "\ud800" },
    { memo_type: "text", memo: "Esure memo tracking", successful: false },
    { memo_type: "text", memo: "Esure memo tracking", hash: "b".repeat(64) },
  ])("fails closed for mismatched or unsafe Horizon evidence: %j", async (record) => {
    const { gateway } = mockNetwork({ hash: "a".repeat(64), successful: true, ...record, envelope_xdr: "private-envelope" });
    const result = await gateway.execute(prepareScenario(definition()));
    expect(result.assertions[0]?.status).toBe("failed");
    expect(JSON.stringify(result)).not.toContain(`S${"A".repeat(55)}`);
    expect(JSON.stringify(result)).not.toContain("private-envelope");
  });

  it("retries transaction lookup without resubmitting the payment", async () => {
    const { gateway, submit, call } = mockNetwork({ hash: "a".repeat(64), successful: true, memo_type: "text", memo: "Esure memo tracking" });
    call.mockRejectedValueOnce({ response: { status: 503 } });
    expect((await gateway.execute(prepareScenario(definition()))).assertions[0]?.status).toBe("passed");
    expect(call).toHaveBeenCalledTimes(2);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("sanitizes lookup failures", async () => {
    const { gateway, call } = mockNetwork({});
    const secret = `S${"A".repeat(55)}`;
    call.mockRejectedValue(new Error(secret));
    try {
      await gateway.execute(prepareScenario(definition()));
      throw new Error("Expected failure");
    } catch (error) {
      expect(error).toHaveProperty("report.category", "network");
      expect(JSON.stringify(error)).not.toContain(secret);
    }
  });

  it("cannot verify a memo on an expected failed payment", async () => {
    const { gateway, submit, lookup } = mockNetwork({});
    submit.mockRejectedValue({ response: { data: { extras: { result_codes: { transaction: "tx_failed", operations: ["op_no_trust"] } } } } });
    const input = definition("");
    input.assertions.unshift({ type: "stepFailedWith", step: "pay", transactionCode: "tx_failed", operationCodes: ["op_no_trust"] });
    const result = await gateway.execute(prepareScenario(input));
    expect(result.assertions[1]).toMatchObject({ type: "transactionMemoEquals", status: "failed", expected: "", actual: null });
    expect(lookup).not.toHaveBeenCalled();
  });

  it("bounds a stalled transaction lookup with the normal step timeout", async () => {
    vi.useFakeTimers();
    try {
      const { gateway, call } = mockNetwork({});
      call.mockImplementation(() => new Promise(() => {}));
      const pending = gateway.execute(prepareScenario(definition()), { stepTimeoutMs: 1_000 });
      const rejected = expect(pending).rejects.toMatchObject({ report: { code: "STEP_TIMEOUT", failedStepId: "assert-transactionMemoEquals" } });
      await vi.advanceTimersByTimeAsync(1_001);
      await rejected;
    } finally { vi.useRealTimers(); }
  });
});
