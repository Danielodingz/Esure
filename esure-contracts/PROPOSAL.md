# Soroban Contract Testing Proposal

## Problem Statement

ESURE currently validates and runs classic Stellar operations. Soroban
applications need a similarly reproducible way to deploy a contract, invoke it
with generated Testnet accounts, and inspect public results. A payment-only
scenario cannot verify contract authorization, state transitions, or emitted
events. Contributors also need a clear boundary between supported contract
fixtures and arbitrary user-supplied code.

Soroban scenarios should extend ESURE only after a concrete contract-testing
need has been identified. The first fixtures should be deliberately small and
should demonstrate behavior that classic operations cannot cover.

## Proposed Scenarios

These examples illustrate intended behavior, not a finalized schema. Field
names and argument encoding are subject to schema design.

### Deploy a token fixture

Deploy a reviewed token contract from a pinned artifact, initialize it, then
verify its initialization event and public state.

```yaml
schemaVersion: 2
id: deploy-token-contract
network: testnet
accounts:
  - { id: admin, generate: true, fund: true }
contracts:
  - id: token
    artifact: esure-fixtures/token@1.0.0
steps:
  - id: deploy
    type: deployContract
    contract: token
    deployer: admin
    salt: scenario-generated
  - id: initialize
    type: invokeContract
    contract: token
    function: initialize
    source: admin
    arguments: { admin: account:admin, name: Example, symbol: EX }
assertions:
  - { type: contractDeployed, contract: token }
  - { type: eventEmitted, step: initialize, event: initialized }
  - type: contractStateEquals
    contract: token
    key: admin
    value: account:admin
```

### Invoke a token transfer

Deploy and initialize the fixture, transfer a bounded amount between generated
accounts, then inspect the invocation result, transfer event, and balances.
Invocation is represented separately here for readability; a complete scenario
would include the deployment and initialization prerequisites.

```yaml
schemaVersion: 2
id: invoke-transfer
network: testnet
accounts:
  - { id: alice, generate: true, fund: true }
  - { id: bob, generate: true, fund: true }
contracts:
  - id: token
    artifact: esure-fixtures/token@1.0.0
steps:
  - id: transfer
    type: invokeContract
    contract: token
    function: transfer
    source: alice
    arguments:
      from: account:alice
      to: account:bob
      amount: "10"
assertions:
  - { type: invocationResultEquals, step: transfer, value: true }
  - { type: eventEmitted, step: transfer, event: transfer }
  - type: contractStateEquals
    contract: token
    key: balance:account:bob
    value: "10"
```

Argument and state-value encodings must be typed and bounded by the schema.
These examples do not authorize arbitrary function names or unbounded data.

## Architecture

Keep scenario orchestration, validation, and sanitized reports in
`esure-backend`. Keep reviewed fixture contracts, their source, tests, interface
metadata, and published artifacts in `esure-contracts`. The backend should use
the Stellar SDK's Soroban RPC capabilities for simulation, transaction
submission, confirmation, and read-only state inspection. It should not embed a
general-purpose WebAssembly runtime.

A Soroban run should follow a bounded lifecycle:

1. Validate the schema version, fixture reference, typed arguments, account
   references, and resource policy before any network call.
2. Resolve the exact approved artifact and verify its digest and metadata.
3. Simulate deployment or invocation and reject transactions exceeding the
   configured resource budget.
4. Submit only to the configured Testnet, wait for bounded confirmation, and
   collect the public result, events, and requested state.
5. Evaluate assertions and store a sanitized report without account secrets or
   artifact contents.

Contract IDs and deployment results should be scoped to a run unless a later
design explicitly introduces shared deployed fixtures. Generated signers stay
in runner memory, following the existing classic-runner boundary.

## Contract Artifact Handling

Use references to immutable, versioned artifacts published by the contracts
project. A reference must resolve to an explicit version and cryptographic
digest; a floating tag such as `latest` is not acceptable for reproducible
runs. The backend should allowlist approved fixture identifiers and verify the
digest before use.

Do not accept inline WASM or arbitrary user uploads in the initial design.
Inline data increases request and storage exposure, while unrestricted uploads
turn a scenario endpoint into a vehicle for submitting unreviewed programs to
the public network. If user-authored contracts become a requirement, artifact
admission, malware/resource screening, retention, access control, and abuse
handling need a separate design.

Published artifacts should include interface metadata sufficient to validate
function names, argument types, and return types. Releases should be immutable
and traceable to reviewed source. Reports should record the artifact
identifier, version, and digest, but not duplicate the WASM binary.

## Soroban-Specific Assertions

The existing balance, account, and transaction assertions remain useful for
classic ledger effects, but are not sufficient to explain contract behavior.
Consider these bounded assertion types:

- `contractDeployed`: verifies that the deployment step succeeded and records
  the resulting contract ID.
- `invocationResultEquals`: compares a typed, sanitized invocation result with
  the expected value.
- `eventEmitted`: matches an event from a specific invocation using the
  contract, event type, and optionally bounded typed topics/data. Define whether
  matching requires exactly one event or at least one.
- `contractStateEquals`: performs a read-only query for a supported state key
  and compares its typed value. Limit keys and values; do not expose arbitrary
  RPC queries.

Assertions must distinguish a false/absent result from a failed RPC request,
simulation, or authorization check. Operational errors should fail the run
explicitly rather than being reported as a successful negative assertion.
Reports should include enough sanitized evidence to diagnose a mismatch without
including secret keys or unbounded raw XDR.

## Security & Safety

- Enforce Testnet in schema validation and runner configuration. Do not accept
  Mainnet URLs, network passphrases, or caller-selected RPC endpoints.
- Execute only allowlisted fixture artifacts with verified immutable digests;
  scenario input must never provide WASM bytes or executable code.
- Apply strict request-size, argument-size, event-count, state-read, simulation,
  submission, retry, and wall-clock limits.
- Enforce Soroban CPU and memory/instruction resource budgets before submission,
  and cap fees and transaction footprint according to a reviewed policy.
- Treat contract code, events, return values, RPC responses, and reports as
  untrusted data. Validate types and sizes and render/report them safely.
- Keep generated secret keys ephemeral and redacted from logs, errors, and
  persistent reports. Avoid logging sensitive invocation arguments.
- Rate-limit deployment and invocation endpoints. Isolate each run and avoid
  shared mutable fixture state unless explicitly designed and tested.
- Do not claim that Testnet simulation is a security audit or that an approved
  fixture is safe for production use.

Soroban contracts execute under Stellar's protocol resource metering on the
network. ESURE should constrain what it submits and what it waits for; it must
not describe Testnet as a sandbox that makes arbitrary code harmless.

## Schema Considerations

This proposal recommends a schema v2 rather than adding contract operations to
Scenario v1. V2 needs explicit contract/artifact declarations, deployment and
invocation steps, typed values, Soroban-specific assertions, and resource
limits. Keeping v1 behavior unchanged avoids weakening its strict validation
rules and gives APIs and stored reports an explicit compatibility boundary.

The backend should continue validating and running existing v1 scenarios.
Soroban v2 definitions should be accepted only by a runner that implements the
full v2 contract flow; unknown operation types must remain rejected. The API,
OpenAPI/JSON Schema documents, report version field, dashboard, CLI, and
persistence would all need coordinated version handling before execution is
enabled.

## Open Questions

- Should the first supported artifacts be limited to fixtures maintained in
  this repository, or may maintainers approve artifacts from other projects?
- Should contracts be deployed for every run, or can a run safely reuse an
  existing Testnet deployment with explicit isolation and cleanup semantics?
- What Soroban RPC provider and resource/fee ceilings should be supported, and
  how should transient provider behavior affect reproducibility?
- Which typed argument and return-value representation is easiest to validate
  across YAML, JSON, the CLI, API, and dashboard?
- Should event assertions match one exact event, any matching event, or an
  ordered event sequence?
- Which state reads are stable and useful enough for a public assertion API?
- How should authorization be represented when a contract requires multiple
  signers or custom authorization trees?
- What artifact signing and source-provenance policy is required in addition
  to digest verification?
- Which local Soroban test environment should provide deterministic tests
  without replacing required Testnet integration coverage?
- Does v2 require an explicit migration/version negotiation policy for
  clients, published scenarios, and persisted reports?

## Out of Scope

- Implementing contracts, backend execution, CLI support, or dashboard changes.
- Compiling, uploading, or executing arbitrary user-provided WASM.
- Mainnet deployment or invocation.
- Production audits, formal verification, or guarantees about third-party
  contract safety.
- General-purpose contract authoring, WASM build pipelines, or contract
  upgrade/administration scenarios.
- Defining a complete token standard or production token implementation.
