import { createHash } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
export type AppInstance = FastifyInstance & { runs: RunService };
import type { AppConfig } from "./config.js";
import type { LedgerGateway, RunReport, ValidatedScenario } from "./domain.js";
import { RunCapacityError } from "./errors.js";
import { DatabaseUnavailableError } from "./database.js";
import { openApiDocument } from "./openapi.js";
import { FixedWindowRateLimiter } from "./rate-limiter.js";
import { RunService } from "./run-service.js";
import { InMemoryRunStore } from "./run-store.js";
import { parseScenario, prepareScenario, canonicalJson } from "./scenario-loader.js";
import { scenarioSchemaV1, ScenarioValidationError } from "./scenario-schema.js";
import { createScenarioRegistry } from "./scenarios.js";
import { StellarTestnetGateway } from "./stellar-gateway.js";
import { PersistenceCoordinator } from "./persistence.js";
import { ScenarioIntegrityError } from "./published-scenarios.js";
import { IdempotencyStore } from "./idempotency-store.js";

interface BuildAppOptions { config: AppConfig; ledger?: LedgerGateway; logger?: boolean; }

const runBodySchema = {
  type: "object", additionalProperties: false, required: ["scenarioId"],
  properties: {
    scenarioId: { type: "string", minLength: 1, maxLength: 64, pattern: "^[a-z0-9-]+$" },
    scenarioVersion: { type: "integer", minimum: 1, maximum: 2_147_483_647 },
    inputs: { type: "object", additionalProperties: false, default: {} },
  },
} as const;

/** Maximum Idempotency-Key length accepted (issue #72). */
const IDEMPOTENCY_KEY_MAX_LENGTH = 128;

/** Maximum number of in-flight idempotency entries (issue #72). */
const IDEMPOTENCY_MAX_ENTRIES = 1_000;

/**
 * Retention window for idempotency entries: 24 h (issue #72).
 * Entries older than this are pruned lazily on the next lookup.
 */
const IDEMPOTENCY_RETENTION_MS = 86_400_000;

export function buildApp(options: BuildAppOptions): AppInstance {
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: options.config.bodyLimitBytes, ajv: { customOptions: { removeAdditional: false } } });
  app.addContentTypeParser(["application/yaml", "application/x-yaml", "text/yaml"], { parseAs: "string" }, (_request, body, done) => done(null, body));
  const registry = createScenarioRegistry(options.config.scenarioDirectory);
  const persistence = new PersistenceCoordinator(options.config, registry);
  app.addHook("onReady", async () => persistence.initialize());
  app.addHook("onClose", async () => persistence.close());
  const limiter = new FixedWindowRateLimiter(options.config.rateLimitWindowMs);

  // Idempotency store shared across both run-creation endpoints (issue #72).
  // RunService.start returns Promise<RunReport>, so T = RunReport.
  const idempotency = new IdempotencyStore<RunReport>(
    IDEMPOTENCY_MAX_ENTRIES,
    IDEMPOTENCY_RETENTION_MS,
  );

  app.addHook("onRequest", async (request, reply) => {
    const path = request.url.split("?")[0];
    const isRunCreation = request.method === "POST" && (path === "/api/v1/runs" || path === "/api/v1/runs/definitions");
    const limit = isRunCreation ? options.config.runRateLimitMax : options.config.rateLimitMax;
    const result = limiter.consume(`${isRunCreation ? "run" : "global"}:${request.ip}`, limit);
    reply.header("x-ratelimit-limit", limit).header("x-ratelimit-remaining", result.remaining);
    if (!result.allowed) { reply.header("retry-after", result.retryAfterSeconds); return reply.code(429).send(apiError("RATE_LIMITED", "Request limit exceeded. Try again later.", request.id)); }
  });
  const ledger = options.ledger ?? new StellarTestnetGateway(options.config.horizonUrl, options.config.friendbotUrl, {
    fundingConcurrency: options.config.maxConcurrentFriendbotRequests,
  });
  const runs = new RunService(persistence.runStore ?? new InMemoryRunStore(options.config.maxStoredRuns, options.config.runRetentionMs), ledger, {
    maxConcurrentRuns: options.config.maxConcurrentRuns, runTimeoutMs: options.config.runTimeoutMs, stepTimeoutMs: options.config.stepTimeoutMs,
  });

  app.get("/health", async () => ({ status: "ok", network: "testnet" }));
  app.get("/ready", async (_request, reply) => {
    const ready = await persistence.check();
    if (!ready) return reply.code(503).send({ status: "unavailable", network: "testnet", database: "unavailable" });
    return { status: "ready", network: "testnet", database: persistence.state === "disabled" ? "disabled" : "ready" };
  });
  app.get("/openapi.json", async () => openApiDocument());

  // ── Issue #70: canonical schema endpoint ──────────────────────────────────
  app.get("/api/v1/schemas/scenario-v1.json", async (_request, reply) => {
    return reply.type("application/json").send(scenarioSchemaV1);
  });

  // ── Issue #69: conditional GET for scenario catalogue ─────────────────────
  app.get("/api/v1/scenarios", async (request, reply) => {
    const items = persistence.repository ? await persistence.repository.list() : registry.list();
    const etag = catalogueETag(items);
    // Always include explicit revalidation directives so both browsers and
    // reverse proxies know the resource must be revalidated before reuse.
    reply.header("ETag", etag).header("Cache-Control", "no-cache");
    const ifNoneMatch = (request.headers["if-none-match"] as string | undefined)?.trim();
    if (ifNoneMatch && (ifNoneMatch === etag || ifNoneMatch === `W/${etag}`)) {
      return reply.code(304).send();
    }
    return { items };
  });

  app.get<{ Params: { scenarioId: string } }>("/api/v1/scenarios/:scenarioId", async (request, reply) => {
    const scenario = persistence.repository ? await persistence.repository.latest(request.params.scenarioId) : registry.find(request.params.scenarioId);
    if (!scenario) return reply.code(404).send(apiError("SCENARIO_NOT_FOUND", "The requested scenario is not available.", request.id));
    return scenario;
  });
  app.get<{ Params: { scenarioId: string }; Querystring: { limit?: string; cursor?: string } }>("/api/v1/scenarios/:scenarioId/versions", async (request, reply) => {
    if (!persistence.repository) return reply.code(503).send(apiError("PERSISTENCE_REQUIRED", "Scenario version history requires published persistence mode.", request.id));
    const limit = boundedInteger(request.query.limit, 20, 1, 100);
    const cursor = request.query.cursor === undefined ? undefined : boundedInteger(request.query.cursor, 0, 1, 2_147_483_647);
    const history = await persistence.repository.history(request.params.scenarioId, limit, cursor);
    if (!history.items.length && cursor === undefined) return reply.code(404).send(apiError("SCENARIO_NOT_FOUND", "The requested scenario is not available.", request.id));
    return history;
  });
  app.get<{ Params: { scenarioId: string; version: string } }>("/api/v1/scenarios/:scenarioId/versions/:version", async (request, reply) => {
    if (!persistence.repository) return reply.code(503).send(apiError("PERSISTENCE_REQUIRED", "Exact scenario versions require published persistence mode.", request.id));
    const version = boundedInteger(request.params.version, 0, 1, 2_147_483_647);
    const scenario = await persistence.repository.version(request.params.scenarioId, version);
    if (!scenario) return reply.code(404).send(apiError("SCENARIO_VERSION_NOT_FOUND", "The requested scenario version is not available.", request.id));
    return scenario;
  });
  app.get<{ Params: { scenarioId: string; version: string }; Querystring: { format?: string } }>("/api/v1/scenarios/:scenarioId/versions/:version/export", async (request, reply) => {
    if (!persistence.repository) return reply.code(503).send(apiError("PERSISTENCE_REQUIRED", "Scenario export requires published persistence mode.", request.id));
    const version = boundedInteger(request.params.version, 0, 1, 2_147_483_647);
    const format = request.query.format ?? "json";
    if (format !== "json" && format !== "yaml") return reply.code(400).send(apiError("INVALID_REQUEST", "Export format must be json or yaml.", request.id));
    const exported = await persistence.repository.export(request.params.scenarioId, version, format);
    if (!exported) return reply.code(404).send(apiError("SCENARIO_VERSION_NOT_FOUND", "The requested scenario version is not available.", request.id));
    return reply.type(format === "json" ? "application/json" : "application/yaml").header("content-disposition", `attachment; filename=${request.params.scenarioId}-v${version}.${format}`).send(exported);
  });
  app.post("/api/v1/scenarios/validate", async (request) => {
    const scenario = submittedScenario(request.body, request.headers["content-type"]);
    return { valid: true, scenarioId: scenario.id, scenarioVersion: scenario.version, schemaVersion: scenario.schemaVersion, contentHash: scenario.contentHash };
  });

  // ── Issue #71: exact version run creation + Issue #72: idempotency ────────
  app.post<{ Body: { scenarioId: string; scenarioVersion?: number; inputs?: Record<string, never> } }>("/api/v1/runs", { schema: { body: runBodySchema } }, async (request, reply) => {
    const { scenarioId, scenarioVersion } = request.body;

    // Resolve the scenario from the active catalogue source (issue #71).
    let scenario: ValidatedScenario | undefined;
    if (persistence.repository) {
      // Published mode: resolve from the persistent catalogue.
      if (scenarioVersion !== undefined) {
        scenario = await persistence.repository.version(scenarioId, scenarioVersion);
        if (!scenario) return reply.code(404).send(apiError("SCENARIO_VERSION_NOT_FOUND", `Scenario ${scenarioId} version ${scenarioVersion} is not available in the published catalogue.`, request.id));
      } else {
        scenario = await persistence.repository.latest(scenarioId);
        if (!scenario) return reply.code(404).send(apiError("SCENARIO_NOT_FOUND", "The requested scenario is not available.", request.id));
      }
    } else {
      // Disabled (bundled) mode: bundled registry holds exactly one version.
      scenario = registry.find(scenarioId);
      if (!scenario) return reply.code(404).send(apiError("SCENARIO_NOT_FOUND", "The requested scenario is not available.", request.id));
      if (scenarioVersion !== undefined && scenario.version !== scenarioVersion) {
        // The bundled definition's version does not match the caller's
        // expectation. Reject explicitly so the caller is not silently
        // executing a different definition than the one they saw.
        return reply.code(409).send(apiError(
          "SCENARIO_VERSION_MISMATCH",
          `Bundled scenario ${scenarioId} is at version ${scenario.version}, not version ${scenarioVersion}. Omit scenarioVersion to always execute the current bundled definition.`,
          request.id,
        ));
      }
    }

    // Idempotency (issue #72).
    const idempotencyKey = extractIdempotencyKey(request.headers["idempotency-key"]);
    if (idempotencyKey) {
      const fingerprint = requestFingerprint({ scenarioId, scenarioVersion });
      const outcome = idempotency.insert(idempotencyKey, fingerprint, () => runs.start(scenario));
      if (outcome.status === "conflict") {
        return reply.code(409).send(apiError("IDEMPOTENCY_CONFLICT", "The Idempotency-Key was already used with a different request body.", request.id));
      }
      if (outcome.status === "capacity") {
        return reply.code(503).send(apiError("IDEMPOTENCY_CAPACITY", "The idempotency store is at capacity. Retry without an Idempotency-Key or try again later.", request.id));
      }
      // Both "created" and "existing" return the settled result of the original
      // promise, which may be from a concurrent or prior request.
      return reply.code(202).send(await outcome.entry.result);
    }

    return reply.code(202).send(await runs.start(scenario));
  });

  app.post("/api/v1/runs/definitions", async (request, reply) => {
    const scenario = submittedScenario(request.body, request.headers["content-type"]);

    // Idempotency (issue #72).
    const idempotencyKey = extractIdempotencyKey(request.headers["idempotency-key"]);
    if (idempotencyKey) {
      // The canonical fingerprint covers the entire definition so any field
      // change produces a different fingerprint.
      const fingerprint = requestFingerprint(scenario);
      const outcome = idempotency.insert(idempotencyKey, fingerprint, () => runs.start(scenario));
      if (outcome.status === "conflict") {
        return reply.code(409).send(apiError("IDEMPOTENCY_CONFLICT", "The Idempotency-Key was already used with a different request body.", request.id));
      }
      if (outcome.status === "capacity") {
        return reply.code(503).send(apiError("IDEMPOTENCY_CAPACITY", "The idempotency store is at capacity. Retry without an Idempotency-Key or try again later.", request.id));
      }
      return reply.code(202).send(await outcome.entry.result);
    }

    return reply.code(202).send(await runs.start(scenario));
  });

  app.get<{ Params: { runId: string } }>("/api/v1/runs/:runId", async (request, reply) => {
    const run = await runs.get(request.params.runId);
    if (!run) return reply.code(404).send(apiError("RUN_NOT_FOUND", "The requested run does not exist.", request.id));
    return run;
  });
  app.get<{ Params: { runId: string } }>("/api/v1/runs/:runId/report", async (request, reply) => {
    const run = await runs.get(request.params.runId);
    if (!run) return reply.code(404).send(apiError("RUN_NOT_FOUND", "The requested run does not exist.", request.id));
    if (run.status !== "passed" && run.status !== "failed") return reply.code(409).send(apiError("RUN_NOT_COMPLETE", "The requested run is not complete.", request.id));
    return reply.header("content-disposition", `attachment; filename=esure-run-${run.id}.json`).send(run);
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof RunCapacityError) return reply.code(503).send({ error: { ...error.report, requestId: request.id, details: [] } });
    if (error instanceof DatabaseUnavailableError) return reply.code(503).send(apiError("DATABASE_UNAVAILABLE", "The persistent scenario catalogue is temporarily unavailable.", request.id));
    // Issue #81: a persisted scenario row failed its integrity re-check. Respond with a
    // sanitized availability error — never the underlying ScenarioIntegrityError detail.
    if (error instanceof ScenarioIntegrityError) return reply.code(503).send(apiError("CATALOGUE_INTEGRITY_ERROR", "The published scenario catalogue is temporarily unavailable.", request.id));
    if (error instanceof ScenarioValidationError) return reply.code(400).send(apiError("INVALID_SCENARIO", error.message, request.id, error.issues));
    if (isInvalidJsonBodyError(error)) {
      if (isScenarioDefinitionPath(request.url)) {
        return reply.code(400).send(apiError("INVALID_SCENARIO", "Scenario definition is invalid.", request.id, ["definition is not valid JSON"]));
      }
      return reply.code(400).send(apiError("INVALID_REQUEST", "The request body is invalid.", request.id, ["request body is not valid JSON"]));
    }
    if (hasStatus(error, 429)) return reply.code(429).send(apiError("RATE_LIMITED", "Request limit exceeded. Try again later.", request.id));
    if (hasStatus(error, 413)) return reply.code(413).send(apiError("INVALID_REQUEST", "The request body exceeded the allowed size.", request.id));
    if (isValidationError(error)) return reply.code(400).send(apiError("INVALID_REQUEST", "The request did not match the API schema.", request.id));
    request.log.error({ err: error }, "Unhandled request error");
    return reply.code(500).send(apiError("INTERNAL_ERROR", "The request could not be completed.", request.id));
  });
  const instance = app as unknown as AppInstance;
  instance.runs = runs;
  return instance;
}

// ── Issue #69: deterministic ETag for catalogue responses ─────────────────
/**
 * Produce a deterministic ETag for the given catalogue items.
 * The hash covers the sorted canonical JSON of every summary so that any
 * change to a version number or content hash produces a different ETag,
 * regardless of the order in which items are returned from the database.
 */
function catalogueETag(items: { id: string; version: number; contentHash: string }[]): string {
  const sorted = [...items].sort((a, b) => a.id.localeCompare(b.id));
  const digest = createHash("sha256")
    .update(canonicalJson(sorted.map(({ id, version, contentHash }) => ({ id, version, contentHash }))))
    .digest("hex");
  return `"${digest}"`;
}

// ── Issue #72: idempotency helpers ─────────────────────────────────────────
function extractIdempotencyKey(header: unknown): string | undefined {
  if (typeof header !== "string") return undefined;
  const trimmed = header.trim();
  if (!trimmed || trimmed.length > IDEMPOTENCY_KEY_MAX_LENGTH) return undefined;
  return trimmed;
}

/**
 * Canonical JSON fingerprint of the run-creation request body.
 * Used to detect conflicts when the same key is reused with a different body.
 */
function requestFingerprint(body: unknown): string {
  return createHash("sha256").update(canonicalJson(body)).digest("hex");
}

function boundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) throw new ScenarioValidationError([`value must be an integer between ${minimum} and ${maximum}`]);
  return parsed;
}

function submittedScenario(body: unknown, contentType: string | undefined): ValidatedScenario {
  const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType === "application/yaml" || mediaType === "application/x-yaml" || mediaType === "text/yaml") {
    if (typeof body !== "string") throw new ScenarioValidationError(["YAML request body must be text"]);
    return parseScenario(body, "yaml");
  }
  return prepareScenario(body);
}
function apiError(code: string, message: string, requestId: string, details: string[] = []) { return { error: { code, message, requestId, details: details.slice(0, 50) } }; }
function isValidationError(error: unknown): error is { validation: unknown } { return typeof error === "object" && error !== null && "validation" in error; }
function hasStatus(error: unknown, status: number): boolean { return typeof error === "object" && error !== null && "statusCode" in error && error.statusCode === status; }
function isInvalidJsonBodyError(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    "name" in error && error.name === "FastifyError" &&
    "code" in error && error.code === "FST_ERR_CTP_INVALID_JSON_BODY" &&
    "statusCode" in error && error.statusCode === 400;
}
function isScenarioDefinitionPath(url: string): boolean {
  const path = url.split("?", 1)[0];
  return path === "/api/v1/scenarios/validate" || path === "/api/v1/runs/definitions";
}
