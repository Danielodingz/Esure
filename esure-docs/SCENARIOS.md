# Esure Scenario Schema v1

Scenario Schema v1 is a bounded, declarative JSON/YAML format for classic
Stellar payment tests. Document order is execution order. Definitions contain
no executable code or credentials and are validated before Testnet access.

## Bundled Scenarios

ESURE includes 12 bundled scenarios for Testnet integration testing:

| Scenario ID | Purpose | Expected Result |
| --- | --- | --- |
| `xlm-payment` | Fund two accounts, transfer 5 XLM, verify balance change | Pass |
| `issued-asset-payment` | Create TESTUSD trustline, issue 100 TESTUSD, verify balance | Pass |
| `issued-asset-holder-transfer` | Issue 100 TESTUSD to a sender, who transfers 40 to a second holder | Pass |
| `missing-trustline` | Attempt issued-asset payment without recipient trustline | Controlled `op_no_trust` failure |
| `sender-missing-trustline` | Attempt issued-asset payment from a funded, non-issuer sender without a trustline | Controlled `op_src_no_trust` failure |
| `insufficient-xlm-balance` | Attempt to send more XLM than available in account | Controlled `op_underfunded` failure |
| `unfunded-destination` | Fund only the sender and pay a generated destination absent from the ledger | Controlled `tx_failed/op_no_destination` failure |
| `payment-with-memo` | Send XLM with a text memo and verify it on the confirmed transaction | Pass |
| `multi-operation-transaction` | Execute trustline + payment atomically in single tx | Pass |
| `trustline-limit-exceeded` | Attempt payment exceeding trustline limit | Controlled `op_line_full` failure |
| `trustline-limit-exact` | Pay exactly the fractional trustline limit and verify the final balance | Pass |
| `trustline-already-exists` | Multiple payments using existing trustline | Pass |
| `basic-payment-with-checks` | Send XLM and verify both accounts exist | Pass |
| `minimum-xlm-payment` | Send minimum viable XLM (1 stroop) | Pass |
| `path-payment` | Create EUR/XLM and USDC/EUR offers and send XLM through EUR to deliver USDC | Pass on Testnet |

These scenarios demonstrate XLM transfers, issued assets, trustline management,
expected failure handling, and multi-step transaction flows that Stellar developers
commonly need to test.

`missing-trustline` and `sender-missing-trustline` fail on opposite sides of
the same payment. In `missing-trustline` the recipient cannot hold the asset, so
Stellar reports `op_no_trust`. In `sender-missing-trustline` the recipient has a
trustline and an issued balance of 50 TESTUSD, while the XLM-funded sender has
never trusted the asset, so Stellar reports `op_src_no_trust` and the
recipient's balance stays at exactly 50. The sender is deliberately not the
issuer: an issuer can always send its own asset without a trustline.

`path-payment` provisions its own Testnet liquidity. It creates generated sender,
market-maker, recipient, and issuer accounts, then submits trustlines, issues
test-issued EUR/USDC assets to the market maker, and places EUR/XLM and USDC/EUR
sell offers. The USDC in this isolated scenario is not Circle-issued USDC. A
strict-receive path payment converts sender XLM through EUR to deliver exactly
5 USDC to the recipient (with a 10 XLM maximum). It does not depend on
pre-existing public order-book liquidity.

```yaml
schemaVersion: 1
id: coffee-token-payment
version: 1
name: Coffee token payment
description: Issue COFFEE and transfer it through a trustline.
network: testnet
accounts:
  - { id: issuer, generate: true, fund: true }
  - { id: customer, generate: true, fund: true }
assets:
  - { id: xlm, type: native }
  - { id: coffee, type: issued, code: COFFEE, issuer: issuer }
steps:
  - id: customer-trusts-coffee
    type: changeTrust
    account: customer
    asset: coffee
  - id: issuer-pays-customer
    type: payment
    from: issuer
    to: customer
    asset: coffee
    amount: "25"
assertions:
  - { type: balanceEquals, account: customer, asset: coffee, amount: "25" }
  - { type: trustlineExists, account: customer, asset: coffee }
  - { type: stepSucceeded, step: issuer-pays-customer }
  - { type: transactionConfirmed, step: issuer-pays-customer }
  - { type: accountExists, account: customer }
```

## Accounts and assets

- Accounts must use `{ generate: true }`; secret seeds and imported accounts are
  not accepted. `fund: true` funds the generated account through official
  Testnet Friendbot.
- Every scenario declares exactly one native asset.
- Issued assets reference an account in the same definition as issuer and use a
  1–12 character uppercase alphanumeric classic asset code.

## Operations

- `changeTrust`: `id`, `account`, `asset`, and optional positive `limit`.
- `payment`: `id`, `from`, `to`, `asset`, positive decimal `amount`, and optional
  `memo` text. The memo is attached to the transaction containing this payment.
- `manageSellOffer`: `id`, `account`, `sellingAsset`, `buyingAsset`, positive
  `amount`, and positive `price`.
- `pathPaymentStrictReceive`: `id`, `from`, `to`, `sendAsset`, `sendMax`,
  `destAsset`, `destAmount`, and up to five intermediate `path` asset IDs.
- `pathPaymentStrictSend`: `id`, `from`, `to`, `sendAsset`, `sendAmount`,
  `destAsset`, `destMin`, and up to five intermediate `path` asset IDs.

Amounts are strings with at most seven fractional digits and must fit Stellar's
signed 64-bit stroop range.

## Assertions

- `balanceEquals(account, asset, amount)`
- `balanceChangedBy(account, asset, amount)`; signed deltas are supported
- `stepSucceeded(step)`
- `stepFailedWith(step, transactionCode, operationCodes)`; the complete
  normalized transaction and operation-code sequence must match exactly
- `trustlineExists(account, asset)`
- `trustlineMissing(account, asset)`
- `transactionConfirmed(step)`
- `transactionMemoEquals(step, memo)`: targets a payment step and reads its
  successful transaction from Horizon by the submitted transaction hash. Reports
  contain the expected and actual bounded text; absent, non-text, malformed, or
  oversized memo evidence produces `actual: null` and fails the assertion.
  Lookup failures use the normal bounded, sanitized network-error path.
- `accountExists(account)`

Reports include explicit `expected` and `actual` values for every assertion,
plus `scenarioVersion`, `scenarioSchemaVersion`, and a canonical SHA-256
`scenarioContentHash`.

## Expected-failure matching and continuation semantics

Negative scenarios are easy to misread as ordinary failures unless exact matching and continuation behavior are explained. This section clarifies the mechanics of `stepFailedWith` assertions.

### What is an expected failure?

An expected failure is a deliberate scenario outcome where a transaction is expected to fail with specific Stellar error codes. Unlike an unexpected crash or assertion failure, an expected failure that matches the specification counts as a **passing** assertion and allows the scenario to continue.

### Using `stepFailedWith`

The `stepFailedWith` assertion expects a step to fail with an exact sequence of transaction and operation codes:

```yaml
assertions:
  - type: stepFailedWith
    step: send-without-trustline
    transactionCode: tx_failed
    operationCodes: [op_no_trust]
```

This assertion passes only if:
1. The step `send-without-trustline` submitted a transaction.
2. The transaction was rejected by Stellar with code `tx_failed`.
3. The first (and only) operation failed with code `op_no_trust`.

### Code matching rules

**Transaction code** is the top-level response from Stellar (e.g. `tx_success`, `tx_failed`, `tx_too_late`). Only one transaction code per submission.

**Operation codes** are per-operation results within a transaction, listed in order. If a transaction contains three operations and the second fails, the array is `[op_no_trust]` (Stellar stops processing at the first failure; codes after the failure are not reported).

**Exact matching is required**: both the transaction code and the complete operation-code sequence must match exactly. For example:
- Expecting `[op_no_trust]` but receiving `[op_no_trust, op_src_no_trust]` fails the assertion.
- Expecting `[op_no_trust]` but receiving `[op_underfunded]` fails the assertion.
- Expecting `tx_failed` but receiving `tx_success` fails the assertion.

### Worked example: missing-trustline scenario

The bundled `missing-trustline` scenario demonstrates expected-failure matching:

```yaml
accounts:
  - { id: issuer, generate: true, fund: true }
  - { id: recipient, generate: true, fund: true }
assets:
  - { id: xlm, type: native }
  - { id: test, type: issued, code: TESTUSD, issuer: issuer }
steps:
  - id: issue-asset
    type: payment
    from: issuer
    to: recipient
    asset: xlm
    amount: "10"
  - id: send-without-trustline
    type: payment
    from: issuer
    to: recipient
    asset: test
    amount: "1"
assertions:
  - type: stepSucceeded
    step: issue-asset
  - type: stepFailedWith
    step: send-without-trustline
    transactionCode: tx_failed
    operationCodes: [op_no_trust]
```

**Why it fails**: The recipient has not created a trustline to TESTUSD, so it cannot hold the asset. Stellar rejects the payment with:
- Transaction code: `tx_failed` (the transaction was submitted but failed)
- Operation code: `op_no_trust` (the operation failed because no trustline exists)

**Why the assertion passes**: Both codes match the expectation; the scenario continues to the next assertion.

### What happens if the transaction unexpectedly succeeds?

If a step expected to fail instead succeeds:

```yaml
assertions:
  - type: stepFailedWith
    step: send-without-trustline
    transactionCode: tx_failed
    operationCodes: [op_no_trust]
```

Result: **Assertion fails**. The scenario halts and reports:
- Expected: `tx_failed` / `[op_no_trust]`
- Actual: `tx_success` (or the actual codes received)

This is a test failure, not a passing run. The scenario does not continue.

### What happens if the transaction fails with a different code?

If the transaction fails but with different codes than expected:

```yaml
assertions:
  - type: stepFailedWith
    step: send-payment
    transactionCode: tx_failed
    operationCodes: [op_no_trust]
```

But the actual result is: `tx_failed` / `[op_underfunded]`

Result: **Assertion fails**. The scenario halts and reports:
- Expected: `op_no_trust`
- Actual: `op_underfunded`

The scenario does not continue. Even though the transaction failed (expected), the specific failure reason was wrong.

### Multi-operation transaction failures

If a transaction contains multiple operations and the second fails:

```yaml
steps:
  - id: trustline-and-payment
    type: transaction
    operations:
      - { type: changeTrust, account: recipient, asset: test }
      - { type: payment, from: issuer, to: recipient, asset: test, amount: "1" }
assertions:
  - type: stepFailedWith
    step: trustline-and-payment
    transactionCode: tx_failed
    operationCodes: [op_no_trust]
```

**If the first operation succeeds and the second fails**:
- Actual codes: `[op_no_trust]` (Stellar reports only the first failure)

**If the first operation fails**:
- Actual codes: `[op_something]` (Stellar stops at the first failure)

Exact matching applies: the assertion passes only if the operation-code sequence matches exactly.

### Continuation after a matched expected failure

If a `stepFailedWith` assertion passes, the scenario continues to the next step:

```yaml
steps:
  - id: step-1
    ...
  - id: step-2
    ...
assertions:
  - type: stepFailedWith
    step: step-1
    transactionCode: tx_failed
    operationCodes: [op_no_trust]
  - type: stepSucceeded
    step: step-2
```

If the assertion on `step-1` passes (the expected failure matched), `step-2` executes normally. If the assertion fails, the scenario halts and `step-2` does not run.

### Combining expected success and expected failure

A scenario can have both successful and failing steps in the same run:

```yaml
assertions:
  - type: stepSucceeded
    step: create-trustline
  - type: stepSucceeded
    step: issue-asset
  - type: stepFailedWith
    step: invalid-payment
    transactionCode: tx_failed
    operationCodes: [op_underfunded]
```

All assertions are evaluated once execution completes. If any assertion fails, the run fails. If all pass, the run passes.

### Debugging unmatched failures

When a step fails but the codes do not match:

1. Check the report's `actual` codes.
2. Compare against the expected codes in the assertion.
3. Consult the [Stellar error code reference](https://developers.stellar.org/docs/learn/errors) for the meaning of each code.
4. Verify the scenario definition matches the intended test. For example, if expecting `op_underfunded` but seeing `op_no_trust`, check whether the issue is balance or trustline.

## Validation and limits

Text memos (both payment `memo` and assertion `memo`) must be well-formed Unicode
of at most **28 UTF-8 bytes**, not 28 characters. For example, 14 `é` or seven
`😀` characters fit; adding one ASCII character exceeds the limit. Empty text
is permitted and is distinct from omitting the memo. No trimming, truncation,
or Unicode normalization occurs. The JSON Schema advertises a 28-character
upper bound; server semantic validation additionally enforces UTF-8 byte length
and rejects lone surrogate code units. Other memo types and memo fields on
other operations are rejected. See the [Stellar memo protocol documentation](https://developers.stellar.org/docs/learn/fundamentals/transactions/operations-and-transactions).

```yaml
steps:
  - { id: pay, type: payment, from: sender, to: recipient, asset: xlm, amount: "10", memo: "Esure memo tracking" }
assertions:
  - { type: transactionMemoEquals, step: pay, memo: "Esure memo tracking" }
```

The bundled `payment-with-memo` fixture is version 2. Existing version 1
definitions and payments that omit `memo` retain their behavior. Published
catalogues should publish/reconcile version 2 using the existing workflow;
immutable version 1 records are not rewritten. OpenAPI embeds the canonical
schema, and generated API types import the updated domain types directly.

- Only `network: testnet` and `schemaVersion: 1` are accepted.
- Unknown properties, duplicate IDs, unresolved references, native trustlines,
  invalid amounts/limits, malformed asset codes, and unsupported operations or
  assertions are rejected before execution.
- Maximums: 10 accounts, 10 assets, 20 steps, 20 assertions, 16 KiB per
  submitted/file definition, and 100 files per configured directory.
- YAML duplicate keys and aliases are rejected.
- Stellar secret seeds, URLs, script fields, transaction envelopes, and raw XDR
  are rejected. Generated secret keys exist only in runner memory during a run.

## Loading and running

- Bundled definitions live in the backend `scenarios/` directory.
- A server operator can set `SCENARIO_DIRECTORY` to load additional JSON/YAML
  files without editing application source.
- `POST /api/v1/scenarios/validate` validates raw JSON or YAML without execution.
- `POST /api/v1/runs/definitions` validates and executes raw JSON or YAML.
- `POST /api/v1/runs` continues to execute a catalogued definition by ID.

The OpenAPI 3.1 contract and embedded Scenario v1 JSON Schema are available at
`GET /openapi.json`.
