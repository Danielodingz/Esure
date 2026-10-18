# Contributor Backlog

This is the staging backlog for GitHub issues. Each item should be opened in the
named repository, assigned to one contributor, and linked to its pull request.
Maintainers should confirm scope against the current code before publishing.

## Issue-writing rules

- One independently reviewable outcome per issue
- Explicit acceptance criteria and out-of-scope section
- Tests required for behavior changes
- No issue depends on unfinished work in the same contribution sprint
- No production secrets, Mainnet operations, or arbitrary execution
- Complexity reflects the documented GrantFox or Drips campaign rules at the
  time the issue is submitted

## Frontend

### F1. Add scenario filtering by operation type

**Suggested complexity:** Medium

Add accessible filter controls for XLM, issued-asset, and expected-failure
scenarios without changing the backend API.

Acceptance criteria:

- Filters work with keyboard and pointer input.
- The available count reflects filtered results.
- Empty filtered results have a clear message.
- Component behavior is tested.

Out of scope: search, sorting, and backend changes.

### F2. Add copy controls for run and transaction identifiers

**Suggested complexity:** Trivial

Acceptance criteria:

- Run IDs and transaction hashes have accessible copy buttons.
- Success is announced to assistive technology.
- Copy failure does not crash the report.

### F3. Add report duration and timestamps

**Suggested complexity:** Medium

Acceptance criteria:

- Created, completed, and calculated duration appear in the summary.
- Dates use the browser locale while raw ISO values remain available.
- Running reports do not show misleading completion data.

### F4. Add an application-level error boundary

**Suggested complexity:** Medium

Acceptance criteria:

- Unexpected rendering errors show a recoverable branded state.
- A retry action is available.
- No internal stack trace is shown to users.

### F5. Primary journey Playwright coverage (implemented)

**Suggested complexity:** High

Acceptance criteria:

- Backend calls are deterministically mocked at the browser boundary.
- The test selects a scenario, starts a run, polls, and verifies a passed report.
- Loading and failed-run states receive separate coverage.

## Backend

### B1. Publish an OpenAPI document

**Suggested complexity:** High

Acceptance criteria:

- Every current endpoint, response, and error envelope is represented.
- Amounts are defined as decimal strings.
- OpenAPI validation runs in CI.
- The generated document contains no environment-specific server URL.

### B2. Add request rate limiting

**Suggested complexity:** Medium

Acceptance criteria:

- Run creation has a stricter limit than read endpoints.
- A rejected request uses the `RATE_LIMITED` error code.
- Limits are configurable and tested without real waiting.

### B3. Add bounded retry behavior for Friendbot

**Suggested complexity:** Medium

Acceptance criteria:

- Only retryable network and server errors are retried.
- Attempts use bounded exponential backoff with jitter.
- Tests use fake timers and no external network.
- The final error is sanitized.

### B4. Normalize Stellar transaction result codes

**Suggested complexity:** High

Acceptance criteria:

- Known transaction and operation codes map to stable Esure error codes.
- Missing-trustline reports the actual normalized ledger result.
- Raw responses and secret material never reach the client.
- Unit tests cover known and unknown error shapes.

### B5. Add run expiration and memory bounds

**Suggested complexity:** Medium

Acceptance criteria:

- Terminal in-memory runs expire after a configurable duration.
- The store has a hard maximum entry count.
- Active runs cannot be evicted.
- Time behavior is covered with fake clocks.

### B6. Add scenario JSON Schema

**Suggested complexity:** High

Acceptance criteria:

- The schema implements the documented version-one format.
- Unknown fields and unresolved references fail validation.
- Secret keys, URLs, and raw envelopes cannot be supplied.
- Valid and invalid fixtures run in CI.

## Documentation

### D1. Write the five-minute local quick start

**Suggested complexity:** Trivial

Acceptance criteria:

- Covers Windows, macOS, and Linux commands.
- Starts backend and frontend from clean clones.
- Includes expected health and scenario responses.
- Contains no real credentials.

### D2. Document the issued-asset payment lifecycle

**Suggested complexity:** Medium

Acceptance criteria:

- Explains issuer, recipient, trustline, payment, and balance assertion.
- Links to authoritative Stellar documentation.
- Includes an Esure report example with synthetic identifiers.

## Contracts

### C1. Create the Soroban fixture design proposal

**Suggested complexity:** Medium

Acceptance criteria:

- Identifies a testing need not covered by classic Stellar operations.
- Defines the smallest contract interface and emitted events.
- Documents abuse cases and storage limits.
- Does not add deployable contract code.

### C2. Scaffold Rust quality checks

**Suggested complexity:** Medium

Blocked until C1 is accepted.

Acceptance criteria:

- Rust formatting, Clippy, and tests run in CI.
- Toolchain versions are documented and pinned where appropriate.
- No placeholder contract is deployed.

## Recommended first campaign set

Start with F1, F2, F3, B2, B3, B5, D1, and D2. They are independent, useful,
and reviewable within a short contribution cycle. Keep B1, B4, B6, F5, and the
contract work for contributors with demonstrated project familiarity.

