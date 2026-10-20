# Esure Glossary

Key terms for Stellar developers new to Esure and scenario-based testing.

## Account concepts

**Keypair**  
A public-key cryptography pair: a private key (secret seed) for signing transactions and a public key (account ID) for identification. Esure generates fresh keypairs per run; the public key is used to create accounts on the ledger.

**Account**  
A Stellar ledger entry identified by a public key, created when an issuer or payer funds it through a transaction. Account creation is not automatic; the account must be explicitly funded or receive a payment operation before it exists on the ledger.

**Generated account**  
An account whose keypair is created by Esure at run time and funded through official Testnet Friendbot. Generated accounts exist only during that run and are isolated from previous or future runs.

**Testnet Friendbot**  
A Testnet-only service that funds newly generated accounts with 10,000 XLM. Esure uses Friendbot to bootstrap test accounts; production Mainnet has no equivalent.

## Asset concepts

**Native asset (XLM)**  
Stellar's native currency, identified as `{type: "native"}` in scenarios. No trustline is required to hold XLM.

**Issued asset**  
A custom token created by an issuer account, identified by a 1–12 character alphanumeric code (e.g. TESTUSD, COFFEE) and the issuer's account ID. Each issued asset is distinct even if codes match; USDC issued by account A is different from USDC issued by account B.

**Trustline**  
A ledger entry that allows an account to hold a balance in an issued asset. The account must explicitly create a trustline to an asset before receiving or holding any balance in that asset. Trustlines have an optional limit that caps the maximum balance.

**Asset code**  
The 1–12 character identifier for an issued asset (e.g. TESTUSD, EUR, COFFEE). The code alone does not uniquely identify the asset; both the code and the issuer account are required.

## Transaction and operation concepts

**Transaction**  
A signed message to the Stellar network containing one or more operations and optional metadata (memo, base fee, source account). Stellar executes all operations atomically: either all succeed or all fail.

**Operation**  
A single action within a transaction: a payment, trustline creation, offer placement, or similar. Operations are ordered and executed sequentially within their transaction.

**Memo**  
Optional metadata attached to a transaction, limited to 28 UTF-8 bytes. Text memos are human-readable; Esure validates memo content and inclusion as part of scenario assertions.

**Payment**  
An operation that transfers an amount of an asset (native or issued) from a sender to a recipient. The recipient must hold a trustline to the asset (unless it is XLM).

**Change trust**  
An operation that creates or modifies a trustline to an issued asset, optionally setting a limit on the maximum balance the account can hold.

**Multi-operation transaction**  
A single transaction containing multiple operations, executed atomically. Common in Stellar: create a trustline and receive a payment in one transaction, or place an offer and send payment in one transaction.

## Scenario and execution concepts

**Scenario**  
A bounded, declarative JSON/YAML definition of a multi-step Stellar test. Scenarios describe accounts, assets, operations, and assertions without executable code or credentials. Esure validates scenarios before execution.

**Scenario schema version**  
The version of the scenario definition format (currently schema v1). Schema changes are breaking; different versions are not mixed in one scenario.

**Scenario version**  
An incrementing version number for a particular scenario definition. When a scenario is saved to the catalog, it receives a version number; multiple versions of the same scenario can coexist.

**Run**  
An execution of a scenario, created by submitting a scenario definition to the API. Each run generates fresh accounts, executes steps against the Testnet, and produces a report.

**Run ID**  
A unique identifier for a single scenario execution, used to query progress and retrieve the final report.

**Content hash**  
A canonical SHA-256 hash of the scenario definition, included in all reports. Content hashes remain identical across reproductions of the same scenario and change only when the scenario definition changes.

## Step and assertion concepts

**Step**  
A single operation or group of operations declared in a scenario (e.g. "fund account", "send payment", "create trustline"). Steps are executed sequentially; later steps can depend on earlier results.

**Step result**  
The outcome of a step after execution, including success/failure status, transaction hash (if confirmed), Stellar transaction code, operation codes, and a human-readable message.

**Assertion**  
A check that validates an expected outcome after one or more steps have executed. Assertions verify balances, transaction confirmations, expected failures, or memo content.

**Assertion result**  
The pass/fail status of an assertion, including both the expected and actual values. Failed assertions include a message explaining the mismatch.

## Expected failure concepts

**Expected failure**  
A deliberate scenario outcome where a transaction is expected to fail (e.g. "send without a trustline"). Scenarios declare expected failures using `stepFailedWith` assertions; a matched failure counts as a passing assertion and the scenario continues.

**Transaction code**  
A Stellar response code indicating the outcome of a transaction submission: success (`tx_success`) or a failure reason (e.g. `tx_failed`, `tx_too_late`).

**Operation code**  
A Stellar response code for a specific operation within a transaction. Common operation codes include `op_no_trust` (missing trustline), `op_underfunded` (insufficient balance), `op_line_full` (trustline limit exceeded).

**Step failed with**  
An assertion that expects a step to fail with a specific sequence of transaction and operation codes. Both the transaction code and the complete operation-code sequence must match exactly; a mismatch fails the assertion even if some codes are correct.

**Matched expected failure**  
When a `stepFailedWith` assertion succeeds, confirming that the transaction failed with the exact codes specified. The run continues to the next step; the scenario does not abort.

**Unmatched failure**  
When a step fails but the failure codes do not match the expected values. This causes the scenario to fail and halt execution.

## Report concepts

**Report**  
A structured JSON/YAML document containing the complete outcome of a run: scenario metadata, all step results, all assertion results, and any error details.

**Summary**  
A count within a report of steps passed, steps failed, assertions passed, and assertions failed.

**Sanitized output**  
Report content with secrets (private keys, seed phrases) and sensitive debugging information removed. Generated secret keys never appear in API responses, logs, or reports.

## Running and validation concepts

**Offline validation**  
Schema and syntactic checks performed on a scenario definition before any Testnet execution, ensuring the scenario is well-formed and references are resolved.

**Live Testnet execution**  
The phase where Esure submits transactions to the actual Stellar Testnet, creates accounts through Friendbot, and retrieves transaction results from Horizon.

**Scenario catalogue**  
An optional persistent store of published scenarios with version history, enabled when `PERSISTENCE_MODE=published` and PostgreSQL is configured.

**Published scenario**  
A scenario stored in the catalogue with a version number, available for repeated execution by ID and query.

**Horizon**  
Stellar's REST API for querying ledger state, transaction history, and account balances. Esure polls Horizon to confirm transactions and verify balances.

**Ledger** or **Ledger sequence number**  
The sequential number of a ledger close (block) on the Stellar network. Transaction confirmations include the ledger number in which they were applied.

## Glossary links

For deeper dives:
- See [SCENARIOS.md](./SCENARIOS.md) for scenario format details and examples.
- See [ARCHITECTURE.md](./ARCHITECTURE.md) for system design and component responsibilities.
- See [Stellar Developers](https://developers.stellar.org) for protocol-level documentation on keypairs, accounts, assets, and transactions.
