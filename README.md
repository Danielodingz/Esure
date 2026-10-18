# Esure

[![Monorepo CI](https://github.com/Esureorg/Esure/actions/workflows/ci.yml/badge.svg)](https://github.com/Esureorg/Esure/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Stellar: Testnet](https://img.shields.io/badge/Stellar-Testnet-7C3AED)](https://developers.stellar.org/docs/networks/testnet)

**Test with confidence. Build on Stellar.**

Esure is an open-source testing and simulation toolkit that helps developers
validate Stellar payment flows before integrating them into production
applications. It turns multi-step Testnet operations into repeatable scenarios
with structured reports, transaction links, balance changes, and readable
failure explanations.

> [!IMPORTANT]
> Esure is an MVP built exclusively for Stellar Testnet. It must not be used for
> Mainnet transactions or real-value assets.

## Live services

| Service | URL |
| --- | --- |
| Web dashboard | [esure-testnet.vercel.app](https://esure-testnet.vercel.app) |
| Backend health | [esure.onrender.com/health](https://esure.onrender.com/health) |
| OpenAPI document | [esure.onrender.com/openapi.json](https://esure.onrender.com/openapi.json) |

The Render free service may sleep after inactivity, so its first response can
take longer than subsequent requests.

<!-- TODO: Add dashboard screenshot or demo GIF here -->

## Capabilities

- **13 Bundled Scenarios**: XLM payments, issued assets, trustlines, expected failures, multi-op transactions (Testnet only)
- **Developer-Friendly Errors**: Plain-English explanations for 30+ Stellar error codes with causes and fix suggestions
- **Command-Line Interface**: Run scenarios from terminal or CI pipelines (run from source; not yet published to npm)
- **CI/CD Integration**: First-class GitHub Actions, GitLab CI, and CircleCI support
- **Declarative Testing**: Bounded JSON/YAML scenario definitions with schema validation
- **Isolated Execution**: Fresh Testnet accounts per run, no cross-run contamination
- **Comprehensive Reports**: Steps, assertions, transaction hashes, balance changes, and readable failures
- **Security by Design**: Testnet-only, rejects secrets/Mainnet, ephemeral keys, sanitized outputs
- **Optional Persistence**: PostgreSQL-backed scenario catalogue and version history

See the [MVP specification](esure-docs/MVP.md) for the complete product scope.

## Why Esure

A realistic Stellar payment test spans account creation, Friendbot funding,
trustline configuration, transaction submission, ledger confirmation, and
balance verification. Rebuilding that flow manually makes failures difficult to
reproduce and easy to misdiagnose. Esure packages the full process into
versioned scenarios that can be executed repeatedly and inspected through one
consistent report format.

Esure is useful for:

- payment and remittance teams validating integration assumptions;
- wallet developers testing asset and trustline behavior;
- educators demonstrating common Stellar transaction flows;
- contributors reproducing protocol-level failures safely on Testnet; and
- CI workflows that need deterministic validation without storing secret keys.

## How Esure differs

Unlike Stellar Lab, which requires manual step-through and copy/paste workflow, Esure executes multi-step flows declaratively and generates structured reports. Unlike the Stellar Quickstart Docker image, Esure focuses on scenario-driven testing rather than node operation. Unlike hand-written SDK tests, Esure provides repeatable scenario definitions with expected-failure assertions and CI-friendly JSON output.

## Bundled scenarios

Esure includes 13 bundled scenarios for Testnet integration testing:

| Scenario | Purpose | Expected result |
| --- | --- | --- |
| `xlm-payment` | Fund two accounts, transfer 5 XLM, verify balance change | Pass |
| `issued-asset-payment` | Create TESTUSD trustline, issue 100 TESTUSD, verify balance | Pass |
| `missing-trustline` | Attempt issued-asset payment without recipient trustline | Controlled `op_no_trust` failure |
| `insufficient-xlm-balance` | Attempt to send more XLM than available in account | Controlled `op_underfunded` failure |
| `unfunded-destination` | Pay a generated destination that has not been funded or created on the ledger | Controlled `tx_failed/op_no_destination` failure |
| `payment-with-memo` | Send XLM with a text memo and verify it on the confirmed transaction | Pass |
| `multi-operation-transaction` | Execute trustline + payment atomically in single tx | Pass |
| `trustline-limit-exceeded` | Attempt payment exceeding trustline limit | Controlled `op_line_full` failure |
| `trustline-limit-exact` | Pay exactly the fractional trustline limit and verify the final balance | Pass |
| `trustline-already-exists` | Multiple payments using existing trustline | Pass |
| `basic-payment-with-checks` | Send XLM and verify both accounts exist after transaction | Pass |
| `minimum-xlm-payment` | Send minimum viable XLM amount (1 stroop = 0.0000001 XLM) | Pass |

Each run generates fresh Testnet accounts, so repeated executions remain
isolated from previous runs. See [SCENARIOS.md](esure-docs/SCENARIOS.md) for
complete scenario documentation.

## How a run works

1. The dashboard requests the published scenario catalogue from the backend.
2. The user selects a scenario and starts a run through the same-origin proxy.
3. The backend validates the bounded scenario definition before generating any
   accounts or making network requests.
4. The runner creates isolated accounts, obtains Testnet funds, and executes
   each declared operation in order.
5. Assertions compare the observed transaction result or balance with the
   scenario expectation.
6. The frontend polls the run endpoint and renders progress, transaction links,
   assertions, and sanitized failures.
7. The final structured report is available from the report endpoint.

## Architecture

```text
Browser
   |
   v
Next.js dashboard and same-origin proxy
   |
   v
Fastify API and scenario runner
   |----------------------|
   v                      v
Stellar Testnet      PostgreSQL (optional)
```

| Directory | Responsibility |
| --- | --- |
| [`esure-frontend`](esure-frontend) | Next.js dashboard and browser-facing API proxy |
| [`esure-backend`](esure-backend) | Fastify API, validation, reporting, and Testnet execution |
| [`esure-cli`](esure-cli) | Command-line interface for terminal and CI usage |
| [`esure-docs`](esure-docs) | Product, API, architecture, scenario, CI, and persistence documentation |
| [`esure-contracts`](esure-contracts) | Design space for post-MVP Soroban fixtures |
| [`.github`](.github) | CI, issue templates, contribution guidance, and security policy |

For deeper technical context, read the
[architecture documentation](esure-docs/ARCHITECTURE.md).

## Quick start

### Prerequisites

- Git
- Node.js 20 or newer
- npm
- Network access to Stellar Testnet for live runs

### 1. Clone and install

```bash
git clone https://github.com/Esureorg/Esure.git
cd Esure

cd esure-backend
npm ci
cd ../esure-frontend
npm ci
cd ..
```

### 2. Configure the applications

macOS and Linux:

```bash
cp esure-backend/.env.example esure-backend/.env
cp esure-frontend/.env.example esure-frontend/.env.local
```

Windows PowerShell:

```powershell
Copy-Item esure-backend/.env.example esure-backend/.env
Copy-Item esure-frontend/.env.example esure-frontend/.env.local
```

The frontend defaults to a backend at `http://127.0.0.1:3001`. To use another
backend, set `ESURE_BACKEND_URL` in `esure-frontend/.env.local`.

### 3. Start the backend

In the first terminal:

```bash
cd esure-backend
npm run dev
```

Verify the API:

```bash
curl http://127.0.0.1:3001/health
curl http://127.0.0.1:3001/api/v1/scenarios
```

### 4. Start the frontend

In a second terminal:

```bash
cd esure-frontend
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

### 5. Run a scenario from the API

```bash
curl -X POST http://127.0.0.1:3001/api/v1/runs \
  -H "content-type: application/json" \
  -d '{"scenarioId":"issued-asset-payment","inputs":{}}'
```

The response contains a run ID. Use it to retrieve progress and the final
report:

```bash
curl http://127.0.0.1:3001/api/v1/runs/RUN_ID
curl http://127.0.0.1:3001/api/v1/runs/RUN_ID/report
```

## CLI usage

> [!NOTE]
> The CLI is not yet published to npm. Run it from source as shown below.

Esure includes a command-line interface for terminal and CI pipeline usage:

```bash
# Clone and build the CLI (one time)
git clone https://github.com/Esureorg/Esure.git
cd Esure/esure-cli
npm ci
npm run build

# List bundled scenarios
node dist/cli.js list

# Validate a scenario file
node dist/cli.js validate ./my-scenario.yaml

# Run a bundled scenario
node dist/cli.js run xlm-payment

# Run a custom scenario with JSON output
node dist/cli.js run ./my-scenario.yaml --output json
```

### CI integration

Add Esure to your CI pipeline:

```yaml
# .github/workflows/stellar-tests.yml
- name: Install Esure CLI
  run: |
    cd esure-cli
    npm ci
    npm run build
    
- name: Run Stellar tests
  run: |
    cd esure-cli
    node dist/cli.js run ./tests/payment-flow.yaml --output json
```

See [CI_INTEGRATION.md](esure-docs/CI_INTEGRATION.md) for complete CI/CD integration
guide with GitHub Actions, GitLab CI, and CircleCI examples.

## API overview

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Confirm the API process is available |
| `GET` | `/ready` | Confirm dependencies are ready |
| `GET` | `/api/v1/scenarios` | List available scenarios |
| `POST` | `/api/v1/scenarios/validate` | Validate a scenario definition |
| `POST` | `/api/v1/runs` | Start a bundled scenario |
| `GET` | `/api/v1/runs/:runId` | Read current run state |
| `GET` | `/api/v1/runs/:runId/report` | Download a structured report |

The complete contract is available from the deployed
[OpenAPI document](https://esure.onrender.com/openapi.json) and the
[API documentation](esure-docs/API.md).

## Configuration reference

### Frontend

| Variable | Default | Description |
| --- | --- | --- |
| `ESURE_BACKEND_URL` | `http://127.0.0.1:3001` | Server-only backend origin used by the Next.js proxy |

### Backend

| Variable | Default | Description |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Bind address; use `0.0.0.0` on Render |
| `PORT` | `3001` | HTTP port; Render supplies this automatically |
| `LOG_LEVEL` | `info` | Fastify application log level |
| `RUN_TIMEOUT_MS` | `120000` | Maximum duration of a complete run |
| `STEP_TIMEOUT_MS` | `30000` | Maximum duration of one scenario step |
| `MAX_CONCURRENT_RUNS` | `2` | Maximum simultaneous executions |
| `MAX_STORED_RUNS` | `500` | Hard limit for retained in-memory runs |
| `RUN_RETENTION_MS` | `3600000` | Retention time for terminal in-memory runs |
| `RATE_LIMIT_MAX` | `120` | General request limit per rate-limit window |
| `RUN_RATE_LIMIT_MAX` | `10` | Stricter run-creation limit per window |
| `PERSISTENCE_MODE` | `disabled` | Use `published` only after configuring PostgreSQL |
| `DATABASE_URL` | unset | Runtime application connection for published persistence |

Review [`esure-backend/.env.example`](esure-backend/.env.example) for every
supported setting and its safe default.

## Development and testing

Run the same deterministic checks used by CI:

```bash
cd esure-backend
npm run check
npm run build

cd ../esure-frontend
npm run check
```

Normal automated tests do not submit real transactions. The opt-in Testnet
smoke test is documented in the [backend README](esure-backend/README.md).

## Persistence

The default `PERSISTENCE_MODE=disabled` configuration keeps runtime state in
memory. Published scenario catalogue persistence can be enabled with PostgreSQL
after applying the checked migrations and configuring the required database
roles. See the [persistence guide](esure-docs/PERSISTENCE.md) before enabling it.

## Deployment

| Component | Platform | Root directory |
| --- | --- | --- |
| Frontend | Vercel | `esure-frontend` |
| Backend | Render | `esure-backend` |
| Database | PostgreSQL provider | Not applicable |

Set `ESURE_BACKEND_URL` in Vercel to the public Render backend origin. Keep
secrets and migration credentials in the hosting provider environment settings;
never commit them to the repository.

### Keeping the backend awake

The Render free tier sleeps after 15 minutes of inactivity. To keep the backend responsive, use a free uptime monitoring service (UptimeRobot, Cron-job.org, or similar) to ping `/health` every 10-14 minutes. This prevents cold starts for dashboard users. See the troubleshooting section for cold-start delay behavior.

## Current MVP status

| Area | Status |
| --- | --- |
| Declarative scenario validation | Implemented |
| XLM and issued-asset Testnet execution | Implemented |
| Expected-failure reporting | Implemented |
| Dashboard and report rendering | Implemented |
| Unit and API test suite | Implemented |
| Monorepo CI | Implemented |
| Published scenario PostgreSQL catalogue | Optional foundation implemented |
| Persistent run execution and evidence | Planned |
| Automated primary browser journey | Planned |

Active work is tracked in [GitHub Issues](https://github.com/Esureorg/Esure/issues).

## Troubleshooting

### The deployed dashboard takes a long time to load

The free Render backend can sleep after inactivity. Wait for the first request
to wake the service, then retry. Check the
[health endpoint](https://esure.onrender.com/health) if the delay continues.

### The frontend cannot reach the backend

Confirm that `ESURE_BACKEND_URL` contains the backend origin without a trailing
API path, for example `https://esure.onrender.com`, and redeploy the frontend
after changing a Vercel environment variable.

### The backend fails readiness in published mode

Published mode fails closed when `DATABASE_URL` is missing or migrations are
stale. Apply the role bootstrap, migrations, and fixture reconciliation from the
[persistence guide](esure-docs/PERSISTENCE.md), or return to
`PERSISTENCE_MODE=disabled` while developing without PostgreSQL.

### A live Testnet run fails during funding

Friendbot and Horizon are external Testnet services and can be temporarily
unavailable or rate limited. Inspect the sanitized run error, wait briefly, and
retry with a new isolated run.

## Security

Esure rejects secret seeds, raw XDR, scripts, arbitrary URLs, unresolved
references, unknown scenario properties, and Mainnet configuration. Generated
Testnet secrets remain only in process memory during execution and are excluded
from API responses, logs, and reports.

Please report vulnerabilities according to the
[security policy](.github/SECURITY.md). Do not disclose sensitive findings in a
public issue.

## Contributing

Contributions are welcome. Before opening a pull request:

1. Read the [contribution guide](.github/CONTRIBUTING.md).
2. Choose or open a focused GitHub issue.
3. Keep changes within the documented Testnet-only safety boundary.
4. Run the relevant checks locally.
5. Link the pull request to its issue.

## License

Esure is released under the [MIT License](LICENSE).
