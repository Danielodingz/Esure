import { describe, it, expect } from "vitest";
import { validateScenarioDefinition, ScenarioValidationError } from "../src/scenario-schema.js";

describe("Amount Boundary Tests (Issue #115)", () => {
  const validScenarioBase = {
    schemaVersion: 1 as const,
    id: "test",
    version: 1,
    name: "Test",
    description: "Test",
    network: "testnet" as const,
    accounts: [{ id: "a", generate: true as const, fund: true }],
    assets: [{ id: "xlm", type: "native" as const }],
    steps: [] as any[],
    assertions: [{ type: "accountExists" as const, account: "a" }],
  };

  describe("Valid decimal representations", () => {
    it("should accept zero amount", () => {
      const scenario = {
        ...validScenarioBase,
        assertions: [{ type: "balanceEquals" as const, account: "a", asset: "xlm", amount: "0" }],
      };
      expect(() => validateScenarioDefinition(scenario)).not.toThrow();
    });

    it("should accept integer amounts", () => {
      const amounts = ["1", "10", "100", "1000000"];
      for (const amount of amounts) {
        const scenario = {
          ...validScenarioBase,
          assertions: [{ type: "balanceEquals" as const, account: "a", asset: "xlm", amount }],
        };
        expect(() => validateScenarioDefinition(scenario)).not.toThrow();
      }
    });

    it("should accept fractional amounts with up to 7 decimal places", () => {
      const amounts = [
        "0.1",
        "0.01",
        "0.001",
        "0.0001",
        "0.00001",
        "0.000001",
        "0.0000001",
        "123.4567890123", // int.frac
      ];
      for (const amount of amounts.slice(0, 7)) {
        const scenario = {
          ...validScenarioBase,
          assertions: [{ type: "balanceEquals" as const, account: "a", asset: "xlm", amount }],
        };
        expect(() => validateScenarioDefinition(scenario)).not.toThrow();
      }
    });

    it("should accept canonical zero representations", () => {
      const amounts = ["0", "0.0", "0.00", "0.000000"];
      for (const amount of amounts) {
        const scenario = {
          ...validScenarioBase,
          assertions: [{ type: "balanceEquals" as const, account: "a", asset: "xlm", amount }],
        };
        expect(() => validateScenarioDefinition(scenario)).not.toThrow();
      }
    });

    it("should handle Stellar max value (9223372036854.7807)", () => {
      const scenario = {
        ...validScenarioBase,
        assertions: [{ type: "balanceEquals" as const, account: "a", asset: "xlm", amount: "9223372036854.7807" }],
      };
      expect(() => validateScenarioDefinition(scenario)).not.toThrow();
    });
  });

  describe("Invalid amounts should be rejected", () => {
    it("should reject amounts exceeding signed 64-bit limit", () => {
      const amounts = [
        "9223372036854.7808", // 1 stroop over max
        "9223372036855",
        "99999999999999.9999",
      ];
      for (const amount of amounts) {
        const scenario = {
          ...validScenarioBase,
          assertions: [{ type: "balanceEquals" as const, account: "a", asset: "xlm", amount }],
        };
        expect(() => validateScenarioDefinition(scenario)).toThrow(ScenarioValidationError);
      }
    });

    it("should reject amounts with more than 7 decimal places", () => {
      const amounts = ["0.00000001", "1.123456789", "100.1234567890"];
      for (const amount of amounts) {
        const scenario = {
          ...validScenarioBase,
          assertions: [{ type: "balanceEquals" as const, account: "a", asset: "xlm", amount }],
        };
        expect(() => validateScenarioDefinition(scenario)).toThrow(ScenarioValidationError);
      }
    });

    it("should reject negative amounts in balance assertions", () => {
      const amount = "-100";
      const scenario = {
        ...validScenarioBase,
        assertions: [{ type: "balanceEquals" as const, account: "a", asset: "xlm", amount }],
      };
      expect(() => validateScenarioDefinition(scenario)).toThrow();
    });

    it("should reject amounts with leading zeros except for 0", () => {
      const amounts = ["01", "001", "00.5"];
      for (const amount of amounts) {
        const scenario = {
          ...validScenarioBase,
          assertions: [{ type: "balanceEquals" as const, account: "a", asset: "xlm", amount }],
        };
        expect(() => validateScenarioDefinition(scenario)).toThrow();
      }
    });

    it("should reject amounts with missing digits", () => {
      const amounts = [".5", "1.", "1..5"];
      for (const amount of amounts) {
        const scenario = {
          ...validScenarioBase,
          assertions: [{ type: "balanceEquals" as const, account: "a", asset: "xlm", amount }],
        };
        expect(() => validateScenarioDefinition(scenario)).toThrow();
      }
    });
  });

  describe("Boundary precision edge cases", () => {
    it("should handle minimal fractional amounts (stroops)", () => {
      const amount = "0.0000001"; // 1 stroop
      const scenario = {
        ...validScenarioBase,
        assertions: [{ type: "balanceEquals" as const, account: "a", asset: "xlm", amount }],
      };
      expect(() => validateScenarioDefinition(scenario)).not.toThrow();
    });

    it("should handle fractional precision at max integer boundary", () => {
      const amount = "9223372036854.0000001"; // near max with fraction
      const scenario = {
        ...validScenarioBase,
        assertions: [{ type: "balanceEquals" as const, account: "a", asset: "xlm", amount }],
      };
      expect(() => validateScenarioDefinition(scenario)).toThrow(); // exceeds max
    });

    it("should preserve equivalent representations", () => {
      const equivalents = [
        ["0", "0.0", "0.0000000"],
        ["100", "100.0", "100.0000000"],
      ];

      for (const group of equivalents) {
        const scenarios = group.map((amount) => ({
          ...validScenarioBase,
          assertions: [{ type: "balanceEquals" as const, account: "a", asset: "xlm", amount }],
        }));

        scenarios.forEach((scenario) => {
          expect(() => validateScenarioDefinition(scenario)).not.toThrow();
        });
      }
    });
  });

  describe("Payment amounts (positive only)", () => {
    it("should accept positive payment amounts", () => {
      const scenario = {
        ...validScenarioBase,
        accounts: [
          { id: "a", generate: true as const, fund: true },
          { id: "b", generate: true as const, fund: true },
        ],
        steps: [
          {
            id: "pay",
            type: "payment" as const,
            from: "a",
            to: "b",
            asset: "xlm",
            amount: "100.5",
          },
        ],
        assertions: [{ type: "accountExists" as const, account: "a" }],
      };
      expect(() => validateScenarioDefinition(scenario)).not.toThrow();
    });

    it("should reject zero payment amount", () => {
      const scenario = {
        ...validScenarioBase,
        accounts: [
          { id: "a", generate: true as const, fund: true },
          { id: "b", generate: true as const, fund: true },
        ],
        steps: [
          {
            id: "pay",
            type: "payment" as const,
            from: "a",
            to: "b",
            asset: "xlm",
            amount: "0",
          },
        ],
        assertions: [{ type: "accountExists" as const, account: "a" }],
      };
      expect(() => validateScenarioDefinition(scenario)).toThrow();
    });
  });

  describe("Arithmetic invariants", () => {
    it("balance changed by should accept negative signed amounts", () => {
      const scenario = {
        ...validScenarioBase,
        assertions: [{ type: "balanceChangedBy" as const, account: "a", asset: "xlm", amount: "-100" }],
      };
      expect(() => validateScenarioDefinition(scenario)).not.toThrow();
    });

    it("balance changed by should accept positive amounts", () => {
      const scenario = {
        ...validScenarioBase,
        assertions: [{ type: "balanceChangedBy" as const, account: "a", asset: "xlm", amount: "100" }],
      };
      expect(() => validateScenarioDefinition(scenario)).not.toThrow();
    });

    it("balance changed by should reject amounts exceeding limits", () => {
      const scenario = {
        ...validScenarioBase,
        assertions: [{ type: "balanceChangedBy" as const, account: "a", asset: "xlm", amount: "99999999999999" }],
      };
      expect(() => validateScenarioDefinition(scenario)).toThrow();
    });
  });
});
