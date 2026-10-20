import { describe, it, expect } from "vitest";
import Ajv from "ajv";
import { app } from "../src/app";
import { openApi } from "../src/openapi";

const ajv = new Ajv({ strict: false });

describe("OpenAPI Contract Validation", () => {
  const spec = openApi.spec();
  const responses = spec.components?.schemas || {};

  describe("GET /api/v1/scenarios", () => {
    it("should return catalogue matching OpenAPI contract", async () => {
      const result = await app.inject({
        method: "GET",
        url: "/api/v1/scenarios",
      });

      expect(result.statusCode).toBe(200);
      const data = JSON.parse(result.body);

      // Validate against schema
      const schema = responses.ScenarioList || { type: "object" };
      const valid = ajv.validate(schema, data);
      expect(valid).toBe(true);

      // Check required fields
      expect(data).toHaveProperty("items");
      expect(Array.isArray(data.items)).toBe(true);

      if (data.items.length > 0) {
        expect(data.items[0]).toHaveProperty("id");
        expect(data.items[0]).toHaveProperty("version");
        expect(typeof data.items[0].version).toBe("number");
      }
    });
  });

  describe("POST /api/v1/scenarios/validate", () => {
    it("should validate scenario and return matching contract", async () => {
      const scenario = {
        schemaVersion: 1,
        id: "test",
        version: 1,
        name: "Test",
        description: "Test scenario",
        network: "testnet",
        accounts: [{ id: "a1", generate: true, fund: true }],
        assets: [{ id: "xlm", type: "native" }],
        steps: [],
        assertions: [],
      };

      const result = await app.inject({
        method: "POST",
        url: "/api/v1/scenarios/validate",
        payload: scenario,
      });

      expect(result.statusCode).toBe(200);
      const data = JSON.parse(result.body);

      expect(data.valid).toBe(true);
      expect(data.scenarioId).toBe("test");
      expect(typeof data.contentHash).toBe("string");
    });

    it("should reject invalid scenario with 400", async () => {
      const invalid = {
        schemaVersion: 1,
        id: "test",
        // Missing required fields
      };

      const result = await app.inject({
        method: "POST",
        url: "/api/v1/scenarios/validate",
        payload: invalid,
      });

      expect(result.statusCode).toBe(400);
      const data = JSON.parse(result.body);
      expect(data.error).toBeTruthy();
    });
  });

  describe("POST /api/v1/runs", () => {
    it("should create run and return matching contract", async () => {
      const result = await app.inject({
        method: "POST",
        url: "/api/v1/runs",
        payload: { scenarioId: "xlm-payment", inputs: {} },
      });

      expect([200, 201, 202]).toContain(result.statusCode);
      const data = JSON.parse(result.body);

      expect(data).toHaveProperty("id");
      expect(data).toHaveProperty("status");
      expect(data).toHaveProperty("createdAt");
      expect(typeof data.createdAt).toBe("string");
    });
  });

  describe("GET /api/v1/runs/:runId", () => {
    it("should return run state matching contract", async () => {
      const createResult = await app.inject({
        method: "POST",
        url: "/api/v1/runs",
        payload: { scenarioId: "xlm-payment", inputs: {} },
      });

      const runId = JSON.parse(createResult.body).id;

      const result = await app.inject({
        method: "GET",
        url: `/api/v1/runs/${runId}`,
      });

      expect(result.statusCode).toBe(200);
      const data = JSON.parse(result.body);

      expect(data.id).toBe(runId);
      expect(["requested", "validating", "running", "passed", "failed"]).toContain(data.status);
    });

    it("should return 404 for missing run", async () => {
      const result = await app.inject({
        method: "GET",
        url: "/api/v1/runs/nonexistent",
      });

      expect(result.statusCode).toBe(404);
    });
  });

  describe("GET /api/v1/runs/:runId/report", () => {
    it("should return report matching contract schema", async () => {
      const createResult = await app.inject({
        method: "POST",
        url: "/api/v1/runs",
        payload: { scenarioId: "xlm-payment", inputs: {} },
      });

      const runId = JSON.parse(createResult.body).id;

      const result = await app.inject({
        method: "GET",
        url: `/api/v1/runs/${runId}/report`,
      });

      expect([200, 202]).toContain(result.statusCode);
      const data = JSON.parse(result.body);

      expect(data).toHaveProperty("scenarioId");
      expect(data).toHaveProperty("status");
      expect(data).toHaveProperty("steps");
      expect(Array.isArray(data.steps)).toBe(true);
      expect(data).toHaveProperty("assertions");
      expect(Array.isArray(data.assertions)).toBe(true);
    });
  });

  describe("Error Responses", () => {
    it("should return 409 for duplicate scenario ID", async () => {
      const scenario = {
        schemaVersion: 1,
        id: "duplicate-test",
        version: 1,
        name: "Test",
        description: "Test",
        network: "testnet",
        accounts: [{ id: "a", generate: true, fund: true }],
        assets: [{ id: "xlm", type: "native" }],
        steps: [],
        assertions: [],
      };

      await app.inject({
        method: "POST",
        url: "/api/v1/scenarios/validate",
        payload: scenario,
      });

      const result = await app.inject({
        method: "POST",
        url: "/api/v1/scenarios/validate",
        payload: scenario,
      });

      expect([409, 400]).toContain(result.statusCode);
    });

    it("should validate decimal fields as strings", async () => {
      const scenario = {
        schemaVersion: 1,
        id: "decimal-test",
        version: 1,
        name: "Decimal Test",
        description: "Test",
        network: "testnet",
        accounts: [{ id: "a", generate: true, fund: true }],
        assets: [{ id: "xlm", type: "native" }],
        steps: [
          {
            id: "pay",
            type: "payment",
            from: "a",
            to: "a",
            asset: "xlm",
            amount: "123.4567890", // 7 decimals max
          },
        ],
        assertions: [],
      };

      const result = await app.inject({
        method: "POST",
        url: "/api/v1/scenarios/validate",
        payload: scenario,
      });

      expect(result.statusCode).toBe(200);
    });
  });
});
