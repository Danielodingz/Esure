import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Account, Asset, Horizon } from "@stellar/stellar-sdk";
import { createScenarioRegistry } from "../src/scenarios.js";
import { StellarTestnetGateway } from "../src/stellar-gateway.js";

// Deterministic in-memory ledger: issued-asset balances keyed by account, then CODE:ISSUER.
type Ledger = Map<string, Map<string, number>>;
const assetKey = (asset: Asset) => `${asset.getCode()}:${asset.getIssuer()}`;

function accountWithBalances(ledger: Ledger, publicKey: string): Horizon.AccountResponse {
  const balances = [...(ledger.get(publicKey) ?? new Map())].map(([key, amount]) => {
    const [asset_code, asset_issuer] = key.split(":");
    return { asset_type: "credit_alphanum12", asset_code, asset_issuer, balance: amount.toFixed(7) };
  });
  return Object.assign(new Account(publicKey, "1"), { balances }) as unknown as Horizon.AccountResponse;
}

describe("issued-asset-holder-transfer scenario", () => {
  let ledger: Ledger;
  let submitted: Array<{ type: string; source: string; destination?: string; amount?: string }>;

  beforeEach(() => {
    ledger = new Map();
    submitted = [];
    vi.spyOn(Horizon.Server.prototype, "loadAccount").mockImplementation(async (publicKey) => accountWithBalances(ledger, publicKey));
    vi.spyOn(Horizon.Server.prototype, "fetchTimebounds").mockImplementation(async () => ({ minTime: 0, maxTime: Math.floor(Date.now() / 1_000) + 60 }));
    vi.spyOn(Horizon.Server.prototype, "submitTransaction").mockImplementation(async (transaction) => {
      for (const operation of transaction.operations) {
        const source = operation.source ?? transaction.source;
        if (operation.type === "changeTrust" && operation.line instanceof Asset) {
          const lines = ledger.get(source) ?? new Map<string, number>();
          lines.set(assetKey(operation.line), 0);
          ledger.set(source, lines);
          submitted.push({ type: operation.type, source });
        }
        if (operation.type === "payment") {
          const key = assetKey(operation.asset);
          const amount = Number(operation.amount);
          // The issuer mints and burns rather than holding a trustline balance.
          if (source !== operation.asset.getIssuer()) ledger.get(source)!.set(key, ledger.get(source)!.get(key)! - amount);
          if (operation.destination !== operation.asset.getIssuer()) ledger.get(operation.destination)!.set(key, ledger.get(operation.destination)!.get(key)! + amount);
          submitted.push({ type: operation.type, source, destination: operation.destination, amount: operation.amount });
        }
      }
      return { hash: "b".repeat(64), ledger: 456 } as Horizon.HorizonApi.SubmitTransactionResponse;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is bundled with both trustlines before issuance and issuance before the transfer", () => {
    const scenario = createScenarioRegistry().find("issued-asset-holder-transfer");
    expect(scenario?.accounts.map((account) => account.id)).toEqual(["issuer", "sender", "receiver"]);
    expect(scenario?.steps.map((step) => step.id)).toEqual([
      "sender-trusts-testusd",
      "receiver-trusts-testusd",
      "issue-to-sender",
      "sender-pays-receiver",
    ]);
  });

  it("confirms issuance and the peer transfer separately and leaves exact balances on both holders", async () => {
    const gateway = new StellarTestnetGateway("https://horizon.example", "https://friendbot.example", {
      fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(null, { status: 200 })),
      sleep: async () => {},
    });

    const execution = await gateway.execute(createScenarioRegistry().find("issued-asset-holder-transfer")!);

    expect(submitted.map((entry) => entry.type)).toEqual(["changeTrust", "changeTrust", "payment", "payment"]);
    const [, , issuance, transfer] = submitted;
    expect(issuance).toMatchObject({ amount: "100.0000000", destination: transfer?.source });
    expect(transfer).toMatchObject({ amount: "40.0000000" });
    expect(transfer?.destination).not.toBe(issuance?.source);

    expect(execution.steps).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "issue-to-sender", status: "passed" }),
        expect.objectContaining({ id: "sender-pays-receiver", status: "passed" }),
      ]));
    expect(execution.assertions.map((assertion) => assertion.status)).toEqual(Array(6).fill("passed"));
  });
});
