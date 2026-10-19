# Contributing to Esure

Thank you for helping make Stellar development easier to test and understand.

## Before starting

1. Choose an open, unassigned issue.
2. Read its scope and acceptance criteria completely.
3. Comment with a short implementation plan.
4. Wait for a maintainer to assign the issue.

Do not begin work based only on an issue title. Assignment prevents duplicate
work during time-boxed contribution campaigns.

## Development workflow

1. Fork the relevant repository.
2. Create a branch such as `feat/scenario-filter` or `fix/report-download`.
3. Make the smallest change that fully meets the acceptance criteria.
4. Add or update automated tests.
5. Run the repository's documented check command.
6. Open a pull request that closes the assigned issue.

## Pull requests

- Keep one issue per pull request unless a maintainer approves otherwise.
- Explain the user-visible outcome and how it was verified.
- Include screenshots for visual changes.
- Do not include generated secret keys, `.env` files, credentials, or real funds.
- Respond to review feedback within the campaign window when applicable.
- Maintainers may close abandoned or out-of-scope pull requests.

## Engineering rules

- Esure's MVP is restricted to Stellar Testnet.
- Amounts are decimal strings, never floating-point values.
- API and scenario schemas reject unknown properties.
- The backend owns canonical API and scenario schemas.
- Secret keys must never appear in API responses, reports, logs, snapshots, or
  committed fixtures.
- New dependencies require a clear need and must pass the repository audit.
- Accessibility and reduced-motion behavior are required for frontend changes.

## Issue labels and sizing

Issue forms apply a type label: `bug` or `enhancement`. Maintainers add one or
more area labels: `backend`, `frontend`, `cli`, `scenarios`, `documentation`, or
`testing`.

Difficulty labels describe the expected scope, not contributor ability:

- `trivial`: documentation or a very small isolated correction
- `medium`: a focused feature or fix requiring edge-case and regression coverage
- `hard`: architecture, security, or multi-component integration

Use `good first issue` only for small, well-scoped work; do not apply it
automatically to medium or hard issues. Maintainers have the final say on issue
scope and completion.

## Conduct and security

Participation is governed by the Code of Conduct. Report vulnerabilities
privately according to `SECURITY.md`; do not open public security issues.

