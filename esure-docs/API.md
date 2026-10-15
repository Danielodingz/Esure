# Esure Backend API

## Conventions

- Base path: `/api/v1`
- Content type: `application/json`
- Identifiers: UUID strings
- Timestamps: UTC ISO 8601 strings
- Amounts: decimal strings, never floating-point JSON numbers
- MVP network: `testnet`

The backend publishes its machine-readable OpenAPI 3.1 document at
`GET /openapi.json`.

## Health

### `GET /health`

```json
{
  "status": "ok",
  "network": "testnet"
}
```

## Canonical scenario schema

### `GET /api/v1/schemas/scenario-v1.json`

Returns the canonical machine-readable JSON Schema for scenario definitions at schema version 1.
Served directly from the authoritative TypeScript definition with `Content-Type: application/json`.
Note that JSON Schema alone cannot express all semantic constraints (such as exactly one native asset, valid identifier references, Stellar signed 64-bit stroop limits, secret seed prohibitions, and 16 384 byte payload limit), which are enforced by the validator.

## List scenarios

### `GET /api/v1/scenarios`

Supports conditional GET via deterministic `ETag` and `Cache-Control: no-cache` headers.
When an `If-None-Match` header matches the current catalogue fingerprint, returns `304 Not Modified` with an empty body.

```json
{
  "items": [
    {
      "id": "issued-asset-payment",
      "version": 1,
      "name": "Issued asset payment",
      "description": "Issue a test asset and send it through a trustline."
    }
  ]
}
```

## Read a scenario

### `GET /api/v1/scenarios/{scenarioId}`

Returns the public scenario definition or `404` when it is unavailable.

## Read immutable published versions

- `GET /api/v1/scenarios/{scenarioId}/versions` lists bounded version history.
- `GET /api/v1/scenarios/{scenarioId}/versions/{version}` returns one exact version.
- `GET /api/v1/scenarios/{scenarioId}/versions/{version}/export?format=json|yaml`
  exports that version.

These read-only routes require explicitly enabled PostgreSQL published mode.
Public scenario create, update, archive, and delete routes remain disabled.

## Start a run

### `POST /api/v1/runs`

Request:

```json
{
  "scenarioId": "issued-asset-payment",
  "scenarioVersion": 1,
  "inputs": {}
}
```

- `scenarioVersion` (optional integer, >= 1): Selects an exact published scenario version. Omitting `scenarioVersion` executes the latest version from the active catalogue source. When run in disabled (bundled) mode, providing a version that mismatches the bundled version returns `409 SCENARIO_VERSION_MISMATCH`.
- `Idempotency-Key` (optional header, 1–128 chars): Deduplicates run creation within a 24-hour retention window. Sending the same key and identical request returns the existing run. Reusing the key with a different request returns `409 IDEMPOTENCY_CONFLICT`. If store capacity is reached, returns `503 IDEMPOTENCY_CAPACITY`.

Accepted response (`202`):

```json
{
  "id": "6e43bd3a-2278-4eaa-901e-f89d733d92e1",
  "status": "requested",
  "scenarioId": "issued-asset-payment",
  "scenarioVersion": 1,
  "createdAt": "2026-08-06T12:00:00.000Z"
}
```

Catalogued scenarios remain supported. To execute a validated client-supplied
Scenario Schema v1 definition, POST the raw JSON or YAML document to
`/api/v1/runs/definitions` using `application/json`, `application/yaml`, or
`text/yaml`. The `Idempotency-Key` header is also supported on this route. Validate without execution at `/api/v1/scenarios/validate`.

## Read a run

### `GET /api/v1/runs/{runId}`

```json
{
  "id": "6e43bd3a-2278-4eaa-901e-f89d733d92e1",
  "scenarioId": "issued-asset-payment",
  "scenarioVersion": 1,
  "scenarioSchemaVersion": 1,
  "scenarioContentHash": "sha256:...",
  "network": "testnet",
  "status": "passed",
  "createdAt": "2026-08-06T12:00:00.000Z",
  "completedAt": "2026-08-06T12:00:08.000Z",
  "steps": [],
  "assertions": [],
  "summary": {
    "stepsPassed": 4,
    "stepsFailed": 0,
    "assertionsPassed": 1,
    "assertionsFailed": 0
  }
}
```

## Download a report

### `GET /api/v1/runs/{runId}/report`

Returns the final sanitized report as a JSON attachment. An unfinished run
returns `409`.

## Error envelope

```json
{
  "error": {
    "code": "SCENARIO_NOT_FOUND",
    "message": "The requested scenario is not available.",
    "requestId": "req_01J...",
    "details": []
  }
}
```

Errors must not expose secret keys, raw internal exceptions, or configuration.

## Initial error codes

- `INVALID_REQUEST`
- `INVALID_SCENARIO`
- `SCENARIO_NOT_FOUND`
- `RUN_NOT_FOUND`
- `RUN_NOT_COMPLETE`
- `NETWORK_UNAVAILABLE`
- `FRIENDBOT_UNAVAILABLE`
- `TRANSACTION_FAILED`
- `ASSERTION_FAILED`
- `RATE_LIMITED`
- `SCENARIO_VERSION_NOT_FOUND`
- `SCENARIO_VERSION_MISMATCH`
- `IDEMPOTENCY_CONFLICT`
- `IDEMPOTENCY_CAPACITY`
- `INTERNAL_ERROR`
