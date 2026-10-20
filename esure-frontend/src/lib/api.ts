export interface ScenarioSummary {
  id: string;
  version: number;
  name: string;
  description: string;
  contentHash: string;
}

export type RunStatus = "requested" | "validating" | "running" | "passed" | "failed";

export interface StepResult {
  id: string;
  type: string;
  status: "passed" | "failed";
  transactionHash?: string;
  ledger?: number;
  stellarTransactionCode?: string;
  stellarOperationCodes?: string[];
  message: string;
}

export interface AssertionResult {
  type: string;
  status: "passed" | "failed";
  expected: JsonValue;
  actual: JsonValue;
  message: string;
}

export interface RunReport {
  id: string;
  scenarioId: string;
  scenarioVersion: number;
  scenarioSchemaVersion: 1;
  scenarioContentHash: string;
  network: "testnet";
  status: RunStatus;
  createdAt: string;
  completedAt?: string;
  steps: StepResult[];
  assertions: AssertionResult[];
  summary: {
    stepsPassed: number;
    stepsFailed: number;
    assertionsPassed: number;
    assertionsFailed: number;
  };
  error?: {
    code: string;
    message: string;
    category: "stellar" | "network" | "timeout" | "capacity" | "validation" | "internal";
    retryable: boolean;
    failedStepId?: string;
    stellarTransactionCode?: string;
    stellarOperationCodes?: string[];
  };
}

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function listScenarios(signal?: AbortSignal): Promise<ScenarioSummary[]> {
  const data = await request("/api/backend/api/v1/scenarios", { signal }, isScenarioList);
  return data.items;
}

export function startRun(scenarioId: string): Promise<RunReport> {
  return request("/api/backend/api/v1/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scenarioId, inputs: {} }),
  }, isRunReport);
}

export function getRun(runId: string, signal?: AbortSignal): Promise<RunReport> {
  return request(`/api/backend/api/v1/runs/${encodeURIComponent(runId)}`, { signal }, isRunReport);
}

const invalidResponseMessage = "The server returned an invalid response. Please try again.";

async function request<T>(url: string, init: RequestInit | undefined, validate: (data: unknown) => data is T): Promise<T> {
  const response = await fetch(url, { ...init, headers: { accept: "application/json", ...init?.headers } });
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    if (response.ok) throw new ApiError(invalidResponseMessage, "INVALID_RESPONSE", response.status);
    data = null;
  }

  if (!response.ok) {
    if (response.status === 429) {
      const retryAfterSeconds = parseRetryAfter(response.headers.get("retry-after"));
      const error = isRecord(data) && isRecord(data.error) ? data.error : null;
      throw new RateLimitError(
        error && typeof error.message === "string" ? error.message : "Too many requests. Please wait before trying again.",
        response.status,
        retryAfterSeconds,
      );
    }
    const error = isRecord(data) && isRecord(data.error) ? data.error : null;
    throw new ApiError(
      error && typeof error.message === "string" ? error.message : "The request failed.",
      error && typeof error.code === "string" ? error.code : "UNKNOWN_ERROR",
      response.status,
    );
  }
  if (!validate(data)) throw new ApiError(invalidResponseMessage, "INVALID_RESPONSE", response.status);
  return data;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isScenarioSummary(value: unknown): value is ScenarioSummary {
  return isRecord(value)
    && isString(value.id)
    && isNonNegativeInteger(value.version)
    && value.version > 0
    && isString(value.name)
    && isString(value.description)
    && isString(value.contentHash);
}

function isScenarioList(value: unknown): value is { items: ScenarioSummary[] } {
  return isRecord(value) && Array.isArray(value.items) && value.items.every(isScenarioSummary);
}

function isStepResult(value: unknown): value is StepResult {
  if (!isRecord(value)
    || !isString(value.id)
    || !isString(value.type)
    || (value.status !== "passed" && value.status !== "failed")
    || !isString(value.message)) return false;

  return (value.transactionHash === undefined || isString(value.transactionHash))
    && (value.ledger === undefined || isNonNegativeInteger(value.ledger))
    && (value.stellarTransactionCode === undefined || isString(value.stellarTransactionCode))
    && (value.stellarOperationCodes === undefined
      || (Array.isArray(value.stellarOperationCodes) && value.stellarOperationCodes.every(isString)));
}

function isAssertionResult(value: unknown): value is AssertionResult {
  return isRecord(value)
    && isString(value.type)
    && (value.status === "passed" || value.status === "failed")
    && "expected" in value
    && "actual" in value
    && isString(value.message);
}

function isRunError(value: unknown): value is NonNullable<RunReport["error"]> {
  if (!isRecord(value)
    || !isString(value.code)
    || !isString(value.message)
    || !["stellar", "network", "timeout", "capacity", "validation", "internal"].includes(String(value.category))
    || typeof value.retryable !== "boolean") return false;

  return (value.failedStepId === undefined || isString(value.failedStepId))
    && (value.stellarTransactionCode === undefined || isString(value.stellarTransactionCode))
    && (value.stellarOperationCodes === undefined
      || (Array.isArray(value.stellarOperationCodes) && value.stellarOperationCodes.every(isString)));
}

export function isRunReport(value: unknown): value is RunReport {
  if (!isRecord(value)
    || !isString(value.id)
    || !isString(value.scenarioId)
    || !isNonNegativeInteger(value.scenarioVersion)
    || value.scenarioVersion < 1
    || value.scenarioSchemaVersion !== 1
    || !isString(value.scenarioContentHash)
    || value.network !== "testnet"
    || !["requested", "validating", "running", "passed", "failed"].includes(String(value.status))
    || !isString(value.createdAt)
    || (value.completedAt !== undefined && !isString(value.completedAt))
    || !Array.isArray(value.steps)
    || !value.steps.every(isStepResult)
    || !Array.isArray(value.assertions)
    || !value.assertions.every(isAssertionResult)
    || !isRecord(value.summary)
    || !isNonNegativeInteger(value.summary.stepsPassed)
    || !isNonNegativeInteger(value.summary.stepsFailed)
    || !isNonNegativeInteger(value.summary.assertionsPassed)
    || !isNonNegativeInteger(value.summary.assertionsFailed)) return false;

  return value.error === undefined || isRunError(value.error);
}

export const MAX_REPORT_FILE_BYTES = 5 * 1024 * 1024; // 5 MB

export function parseReportJson(jsonText: string, maxBytes = MAX_REPORT_FILE_BYTES): RunReport {
  if (typeof jsonText !== "string") {
    throw new Error("Invalid report input: expected text content.");
  }
  const byteLength = new TextEncoder().encode(jsonText).length;
  if (byteLength > maxBytes) {
    throw new Error(`File is too large (${(byteLength / (1024 * 1024)).toFixed(1)}MB). Maximum allowed size is ${(maxBytes / (1024 * 1024)).toFixed(0)}MB.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new Error("Invalid file format: file must be a valid JSON document.");
  }
  if (!isRunReport(parsed)) {
    throw new Error("Invalid report schema: the file is missing required report fields or contains invalid values.");
  }
  return parsed;
}

export const ERROR_CATEGORY_LABELS: Record<NonNullable<RunReport["error"]>["category"], string> = {
  stellar: "Stellar network failure",
  network: "Network connectivity issue",
  timeout: "Execution timed out",
  capacity: "Rate limit / capacity exceeded",
  validation: "Scenario validation error",
  internal: "Internal system error",
};

export function getRetryabilityLabel(retryable: boolean): string {
  return retryable ? "Retryable failure" : "Non-retryable failure";
}

export function sanitizeErrorMessage(message: string, category: string): string {
  if (category === "internal") {
    const stackIdx = message.search(/\r?\n\s+at\s/);
    if (stackIdx !== -1) {
      return message.substring(0, stackIdx).trim();
    }
    if (message.startsWith("{") && message.endsWith("}")) {
      return "An unexpected internal error occurred.";
    }
  }
  return message;
}

export interface StepComparison {
  id: string;
  type: string;
  statusA?: "passed" | "failed";
  statusB?: "passed" | "failed";
  statusChange: "unchanged" | "added" | "removed" | "changed";
}

export interface AssertionComparison {
  key: string;
  type: string;
  statusA?: "passed" | "failed";
  statusB?: "passed" | "failed";
  statusChange: "unchanged" | "added" | "removed" | "changed";
}

export interface ReportComparison {
  scenariosMatch: boolean;
  scenarioIdMatch: boolean;
  versionMatch: boolean;
  contentHashMatch: boolean;
  statusA: RunStatus;
  statusB: RunStatus;
  statusChanged: boolean;
  durationMsA: number | null;
  durationMsB: number | null;
  durationDiffMs: number | null;
  steps: StepComparison[];
  assertions: AssertionComparison[];
  summary: {
    stepsAdded: number;
    stepsRemoved: number;
    stepsChanged: number;
    stepsUnchanged: number;
    assertionsAdded: number;
    assertionsRemoved: number;
    assertionsChanged: number;
    assertionsUnchanged: number;
  };
}

function parseDurationMs(startIso?: string, endIso?: string): number | null {
  if (!startIso || !endIso) return null;
  const start = new Date(startIso).getTime();
  const end = new Date(endIso).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, end - start);
}

export function compareReports(a: RunReport, b: RunReport): ReportComparison {
  const scenarioIdMatch = a.scenarioId === b.scenarioId;
  const versionMatch = a.scenarioVersion === b.scenarioVersion;
  const contentHashMatch = a.scenarioContentHash === b.scenarioContentHash;
  const scenariosMatch = scenarioIdMatch && versionMatch && contentHashMatch;

  const statusA = a.status;
  const statusB = b.status;
  const statusChanged = statusA !== statusB;

  const durationMsA = parseDurationMs(a.createdAt, a.completedAt);
  const durationMsB = parseDurationMs(b.createdAt, b.completedAt);
  const durationDiffMs = (durationMsA !== null && durationMsB !== null)
    ? durationMsB - durationMsA
    : null;

  // Step comparison
  const mapA = new Map<string, StepResult>();
  for (const step of a.steps) {
    mapA.set(step.id, step);
  }
  const mapB = new Map<string, StepResult>();
  for (const step of b.steps) {
    mapB.set(step.id, step);
  }

  const allStepIds = new Set<string>([
    ...a.steps.map((s) => s.id),
    ...b.steps.map((s) => s.id),
  ]);

  const stepComparisons: StepComparison[] = [];
  let stepsAdded = 0;
  let stepsRemoved = 0;
  let stepsChanged = 0;
  let stepsUnchanged = 0;

  for (const id of allStepIds) {
    const stepA = mapA.get(id);
    const stepB = mapB.get(id);

    if (stepA && stepB) {
      const type = stepB.type || stepA.type;
      const change = stepA.status === stepB.status ? "unchanged" : "changed";
      if (change === "unchanged") stepsUnchanged++;
      else stepsChanged++;
      stepComparisons.push({
        id,
        type,
        statusA: stepA.status,
        statusB: stepB.status,
        statusChange: change,
      });
    } else if (stepA && !stepB) {
      stepsRemoved++;
      stepComparisons.push({
        id,
        type: stepA.type,
        statusA: stepA.status,
        statusChange: "removed",
      });
    } else if (!stepA && stepB) {
      stepsAdded++;
      stepComparisons.push({
        id,
        type: stepB.type,
        statusB: stepB.status,
        statusChange: "added",
      });
    }
  }

  // Assertion comparison using documented stable occurrence keys: `${type}#${index}`
  // index is occurrence count of this assertion type in the report
  function getAssertionKeyMap(assertions: AssertionResult[]) {
    const keyMap = new Map<string, AssertionResult>();
    const counts = new Map<string, number>();
    for (const assertion of assertions) {
      const count = counts.get(assertion.type) ?? 0;
      counts.set(assertion.type, count + 1);
      const key = `${assertion.type}#${count}`;
      keyMap.set(key, assertion);
    }
    return keyMap;
  }

  const assertMapA = getAssertionKeyMap(a.assertions);
  const assertMapB = getAssertionKeyMap(b.assertions);

  const allAssertKeys = new Set<string>([
    ...assertMapA.keys(),
    ...assertMapB.keys(),
  ]);

  const assertionComparisons: AssertionComparison[] = [];
  let assertionsAdded = 0;
  let assertionsRemoved = 0;
  let assertionsChanged = 0;
  let assertionsUnchanged = 0;

  for (const key of allAssertKeys) {
    const assertA = assertMapA.get(key);
    const assertB = assertMapB.get(key);
    const type = key.split("#")[0];

    if (assertA && assertB) {
      const change = assertA.status === assertB.status ? "unchanged" : "changed";
      if (change === "unchanged") assertionsUnchanged++;
      else assertionsChanged++;
      assertionComparisons.push({
        key,
        type,
        statusA: assertA.status,
        statusB: assertB.status,
        statusChange: change,
      });
    } else if (assertA && !assertB) {
      assertionsRemoved++;
      assertionComparisons.push({
        key,
        type,
        statusA: assertA.status,
        statusChange: "removed",
      });
    } else if (!assertA && assertB) {
      assertionsAdded++;
      assertionComparisons.push({
        key,
        type,
        statusB: assertB.status,
        statusChange: "added",
      });
    }
  }

  return {
    scenariosMatch,
    scenarioIdMatch,
    versionMatch,
    contentHashMatch,
    statusA,
    statusB,
    statusChanged,
    durationMsA,
    durationMsB,
    durationDiffMs,
    steps: stepComparisons,
    assertions: assertionComparisons,
    summary: {
      stepsAdded,
      stepsRemoved,
      stepsChanged,
      stepsUnchanged,
      assertionsAdded,
      assertionsRemoved,
      assertionsChanged,
      assertionsUnchanged,
    },
  };
}

export interface ScenarioDetail {
  id: string;
  version: number;
  name: string;
  description: string;
  contentHash: string;
  network: "testnet";
  schemaVersion: number;
  accounts: { id: string; label?: string }[];
  assets: { id: string; type: string; code?: string; issuer?: string }[];
  steps: { id: string; type: string; [key: string]: unknown }[];
  assertions: { type: string; [key: string]: unknown }[];
}

function isScenarioDetail(value: unknown): value is ScenarioDetail {
  return isRecord(value)
    && isString(value.id)
    && isNonNegativeInteger(value.version)
    && value.version > 0
    && isString(value.name)
    && isString(value.description)
    && isString(value.contentHash)
    && value.network === "testnet"
    && Array.isArray(value.accounts)
    && Array.isArray(value.assets)
    && Array.isArray(value.steps)
    && Array.isArray(value.assertions);
}

export function getScenario(scenarioId: string, signal?: AbortSignal): Promise<ScenarioDetail> {
  return request(`/api/backend/api/v1/scenarios/${encodeURIComponent(scenarioId)}`, { signal }, isScenarioDetail);
}

export function parseRetryAfter(value: string | null, maxSeconds = 60): number | null {
  if (!value) return null;
  const numeric = Number(value.trim());
  if (!Number.isNaN(numeric) && numeric >= 0) return Math.min(numeric, maxSeconds);
  const httpDate = Date.parse(value);
  if (!Number.isNaN(httpDate)) {
    const seconds = Math.ceil((httpDate - Date.now()) / 1000);
    return Math.min(Math.max(seconds, 0), maxSeconds);
  }
  return null;
}

export class RateLimitError extends ApiError {
  readonly retryAfterSeconds: number | null;
  constructor(message: string, status: number, retryAfterSeconds: number | null) {
    super(message, "RATE_LIMITED", status);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}
