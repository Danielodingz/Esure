import { Account, Asset, Horizon, Transaction } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createScenarioRegistry } from "../src/scenarios.js";
import { StellarTestnetGateway } from "../src/stellar-gateway.js";

afterEach(() => vi.restoreAllMocks());

describe("trustline balance reduction fixture", () => {
  it("matches op_invalid_limit and preserves the issued-asset balance", async () => {
    const scenario = createScenarioRegistry().find("trustline-balance-reduction")!;
    let holder: string | undefined;
    let issuer: string | undefined;
    const funding = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.spyOn(Horizon.Server.prototype, "loadAccount").mockImplementation(async (key) => {
      const balances = key === holder && issuer
        ? [{ asset_type: "credit_alphanum12", asset_code: "LIMITED", asset_issuer: issuer, balance: "10.0000000" }]
        : [];
      return Object.assign(new Account(key, "1"), { balances }) as unknown as Awaited<ReturnType<Horizon.Server["loadAccount"]>>;
    });
    vi.spyOn(Horizon.Server.prototype, "fetchTimebounds").mockResolvedValue({ minTime: 0, maxTime: 2_000_000_000 });
    const submittedTypes: string[] = [];
    vi.spyOn(Horizon.Server.prototype, "submitTransaction").mockImplementation(async (transaction) => {
      const built = transaction as Transaction;
      const operation = built.operations[0]!;
      submittedTypes.push(operation.type);
      if (operation.type === "changeTrust") {
        if (!(operation.line instanceof Asset)) throw new Error("Expected a classic issued asset");
        holder = built.source;
        issuer = operation.line.getIssuer();
        if (submittedTypes.length === 3) {
          throw {
            response: { data: { extras: { result_codes: { transaction: "tx_failed", operations: ["op_invalid_limit"] } } } },
          };
        }
      }
      return { hash: "a".repeat(64), ledger: 123 } as Horizon.HorizonApi.SubmitTransactionResponse;
    });

    const execution = await new StellarTestnetGateway("https://horizon.example", "https://friendbot.example", { fetch: funding }).execute(scenario);

    expect(submittedTypes).toEqual(["changeTrust", "payment", "changeTrust"]);
    expect(execution.assertions).toEqual([
      expect.objectContaining({ type: "stepSucceeded", status: "passed", actual: true }),
      expect.objectContaining({ type: "stepSucceeded", status: "passed", actual: true }),
      expect.objectContaining({ type: "stepFailedWith", status: "passed", expected: "tx_failed/op_invalid_limit", actual: "tx_failed/op_invalid_limit" }),
      expect.objectContaining({ type: "balanceEquals", status: "passed", expected: "10", actual: "10" }),
    ]);
  });
});