import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Database } from "../src/database.js";
import type { ValidatedScenario } from "../src/domain.js";
import { validateScenarioDefinition } from "../src/scenario-schema.js";
import { YAML } from "js-yaml";

describe("Export Round-Trip Tests (Issue #116)", () => {
  let db: Database;

  beforeEach(async () => {
    db = new Database(":memory:");
    await db.init();
  });

  afterEach(async () => {
    await db.close();
  });

  it("JSON export should re-validate to same definition and content hash", async () => {
    const scenario: ValidatedScenario = {
      schemaVersion: 1,
      id: "test-json-round-trip",
      version: 1,
      name: "JSON Round Trip Test",
      description: "Verify JSON export validates back to same content hash",
      network: "testnet",
      accounts: [{ id: "issuer", generate: true, fund: true }],
      assets: [{ id: "xlm", type: "native" }],
      steps: [],
      assertions: [{ type: "accountExists", account: "issuer" }],
      contentHash: "abc123",
    };

    await db.saveScenario(scenario);
    const exported = await db.exportScenario("test-json-round-trip", 1, "json");
    const parsed = JSON.parse(exported);
    const revalidated = validateScenarioDefinition(parsed);

    expect(revalidated.contentHash).toBe(scenario.contentHash);
    expect(JSON.stringify(revalidated)).toBe(JSON.stringify(scenario));
  });

  it("YAML export should re-validate to same definition and content hash", async () => {
    const scenario: ValidatedScenario = {
      schemaVersion: 1,
      id: "test-yaml-round-trip",
      version: 1,
      name: "YAML Round Trip Test",
      description: "Verify YAML export validates back to same content hash",
      network: "testnet",
      accounts: [{ id: "issuer", generate: true, fund: true }],
      assets: [{ id: "xlm", type: "native" }],
      steps: [],
      assertions: [{ type: "accountExists", account: "issuer" }],
      contentHash: "def456",
    };

    await db.saveScenario(scenario);
    const exported = await db.exportScenario("test-yaml-round-trip", 1, "yaml");
    const parsed = YAML.parse(exported) as Record<string, unknown>;
    const revalidated = validateScenarioDefinition(parsed);

    expect(revalidated.contentHash).toBe(scenario.contentHash);
  });

  it("Pagination should return each version once in descending order", async () => {
    const baseId = "test-pagination";
    for (let v = 1; v <= 5; v++) {
      const scenario: ValidatedScenario = {
        schemaVersion: 1,
        id: baseId,
        version: v,
        name: `Version ${v}`,
        description: `Test version ${v}`,
        network: "testnet",
        accounts: [{ id: "issuer", generate: true, fund: true }],
        assets: [{ id: "xlm", type: "native" }],
        steps: [],
        assertions: [{ type: "accountExists", account: "issuer" }],
        contentHash: `hash-v${v}`,
      };
      await db.saveScenario(scenario);
    }

    const page1 = await db.listScenarioVersions(baseId, { limit: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.items[0].version).toBe(5);
    expect(page1.items[1].version).toBe(4);
    expect(page1.nextCursor).toBeDefined();

    const page2 = await db.listScenarioVersions(baseId, { limit: 2, cursor: page1.nextCursor });
    expect(page2.items).toHaveLength(2);
    expect(page2.items[0].version).toBe(3);
    expect(page2.items[1].version).toBe(2);
    expect(page2.nextCursor).toBeDefined();

    const page3 = await db.listScenarioVersions(baseId, { limit: 2, cursor: page2.nextCursor });
    expect(page3.items).toHaveLength(1);
    expect(page3.items[0].version).toBe(1);
    expect(page3.nextCursor).toBeUndefined();
  });

  it("Pagination with limit of one should work correctly", async () => {
    const baseId = "test-pagination-limit-one";
    for (let v = 1; v <= 3; v++) {
      const scenario: ValidatedScenario = {
        schemaVersion: 1,
        id: baseId,
        version: v,
        name: `Version ${v}`,
        description: `Test version ${v}`,
        network: "testnet",
        accounts: [{ id: "issuer", generate: true, fund: true }],
        assets: [{ id: "xlm", type: "native" }],
        steps: [],
        assertions: [{ type: "accountExists", account: "issuer" }],
        contentHash: `hash-v${v}`,
      };
      await db.saveScenario(scenario);
    }

    const page1 = await db.listScenarioVersions(baseId, { limit: 1 });
    expect(page1.items).toHaveLength(1);
    expect(page1.items[0].version).toBe(3);

    const page2 = await db.listScenarioVersions(baseId, { limit: 1, cursor: page1.nextCursor });
    expect(page2.items).toHaveLength(1);
    expect(page2.items[0].version).toBe(2);

    const page3 = await db.listScenarioVersions(baseId, { limit: 1, cursor: page2.nextCursor });
    expect(page3.items).toHaveLength(1);
    expect(page3.items[0].version).toBe(1);
    expect(page3.nextCursor).toBeUndefined();
  });

  it("Final empty page should not produce spurious continuation cursor", async () => {
    const baseId = "test-no-spurious-cursor";
    for (let v = 1; v <= 2; v++) {
      const scenario: ValidatedScenario = {
        schemaVersion: 1,
        id: baseId,
        version: v,
        name: `Version ${v}`,
        description: `Test version ${v}`,
        network: "testnet",
        accounts: [{ id: "issuer", generate: true, fund: true }],
        assets: [{ id: "xlm", type: "native" }],
        steps: [],
        assertions: [{ type: "accountExists", account: "issuer" }],
        contentHash: `hash-v${v}`,
      };
      await db.saveScenario(scenario);
    }

    const page1 = await db.listScenarioVersions(baseId, { limit: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).toBeUndefined();
  });

  it("Multiple format exports should produce consistent results", async () => {
    const scenario: ValidatedScenario = {
      schemaVersion: 1,
      id: "test-format-consistency",
      version: 1,
      name: "Format Consistency Test",
      description: "Verify JSON and YAML export the same data",
      network: "testnet",
      accounts: [
        { id: "issuer", generate: true, fund: true },
        { id: "recipient", generate: true, fund: true },
      ],
      assets: [
        { id: "xlm", type: "native" },
        { id: "test", type: "issued", code: "TEST", issuer: "issuer" },
      ],
      steps: [
        {
          id: "create-trustline",
          type: "changeTrust",
          account: "recipient",
          asset: "test",
          limit: "1000",
        },
      ],
      assertions: [
        { type: "trustlineExists", account: "recipient", asset: "test" },
      ],
      contentHash: "consistency-test",
    };

    await db.saveScenario(scenario);

    const jsonExport = await db.exportScenario("test-format-consistency", 1, "json");
    const yamlExport = await db.exportScenario("test-format-consistency", 1, "yaml");

    const jsonParsed = validateScenarioDefinition(JSON.parse(jsonExport));
    const yamlParsed = validateScenarioDefinition(YAML.parse(yamlExport) as Record<string, unknown>);

    expect(jsonParsed.id).toBe(yamlParsed.id);
    expect(jsonParsed.version).toBe(yamlParsed.version);
    expect(jsonParsed.contentHash).toBe(yamlParsed.contentHash);
    expect(jsonParsed.accounts.length).toBe(yamlParsed.accounts.length);
  });
});
