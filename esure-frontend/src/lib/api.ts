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

function isRunReport(value: unknown): value is RunReport {
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
