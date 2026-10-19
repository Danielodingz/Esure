# Esure System Architecture

## Context

```text
Browser
   |
   | HTTPS / JSON
   v
Esure Frontend
   |
   | REST API
   v
Esure Backend --------> PostgreSQL
   |
   +-------------------> Stellar Horizon / RPC
   |
   +-------------------> Friendbot (Testnet only)

Future: Backend --------> Esure Soroban contracts
```

## Components

### Frontend

The frontend presents scenarios and execution reports. It never receives or
handles generated account secrets. It treats backend reports as untrusted input
and renders them without executing embedded content.

### Backend

The backend validates scenarios, creates ephemeral Testnet identities, submits
operations in sequence, records sanitized results, evaluates assertions, and
explains known errors.

### Database

In `published` mode, PostgreSQL durably stores the published scenario catalogue
and its versions. Run reports use an in-memory store by default; PostgreSQL report
storage is a separate opt-in. Persisted reports are sanitized, and generated
secret keys must never be stored. See the [persistence guide](PERSISTENCE.md).

### Contracts

Soroban execution is not part of the MVP runtime. The future contract-fixture
design is a proposal in the [contracts repository](../esure-contracts/PROPOSAL.md);
it describes versioned WASM artifacts and interface metadata for a possible
backend integration.

## Runtime flow

```text
Requested -> Validating -> Running -> Passed
                                 \-> Failed
```

1. The frontend requests an enabled scenario.
2. The backend validates the request and creates a run identifier.
3. A runner executes steps sequentially with a per-step timeout.
4. Each completed step appends a sanitized result.
5. Assertions inspect public ledger state and step results.
6. The final sanitized report is returned and held by the configured run store:
   in memory by default or in PostgreSQL when run-report persistence is enabled.

## Core domain types

- **Scenario:** versioned instructions and assertions.
- **Run:** one isolated execution of a scenario.
- **Step:** one supported Stellar operation.
- **Step result:** sanitized evidence produced by a step.
- **Assertion:** a deterministic check evaluated after execution.
- **Report:** the complete public result of a run.

## Security boundaries

- Scenario input is untrusted and must pass strict schema validation.
- Only allowlisted step types may execute; arbitrary commands are forbidden.
- Generated keys live only for a run and are redacted from errors and logs.
- The MVP is hard-coded to Testnet and rejects Mainnet configuration.
- External calls require timeouts and bounded retries.
- Asset codes, amounts, memo values, and references have explicit limits.
- The public API applies per-IP rate limits, with a stricter limit for run creation.

## Initial technology decisions

| Area | Choice |
| --- | --- |
| Frontend | Next.js, TypeScript, Tailwind CSS |
| Backend | Node.js, TypeScript, Fastify |
| Validation | JSON Schema through Fastify |
| Stellar | `@stellar/stellar-sdk` |
| Persistence | Optional PostgreSQL catalogue and report stores through `pg` and SQL migrations |
| Unit tests | Vitest |
| Browser tests | Playwright |
| Contracts | Not in the runtime; future integration is proposal-only |
| Documentation | Markdown first; framework deferred |

## Cross-repository contract

The backend owns the canonical OpenAPI document and scenario JSON Schema. The
frontend consumes types from tagged backend releases. Equivalent types must not
be copied and edited independently across repositories.

