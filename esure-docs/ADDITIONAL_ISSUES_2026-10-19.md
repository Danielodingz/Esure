# Additional contributor issues — 19 October 2026

Twenty follow-up tasks reviewed against commit `d411491eee69cd136f9c3355a2594c172e8a7485` and the 118 existing GitHub issues. These are proposed work, not implemented capabilities. GitHub issues contain acceptance criteria and validation requirements.

Follow the [contribution workflow](../.github/CONTRIBUTING.md) and obtain maintainer assignment before implementation. All work preserves the Testnet-only boundary and decimal-string amounts.

| Issue | Area | Difficulty |
| --- | --- | --- |
| [#151: Frontend: retry uncertain run submissions with a stable idempotency key](https://github.com/Esureorg/Esure/issues/151) | frontend | medium |
| [#152: Frontend: display the report expiration hint](https://github.com/Esureorg/Esure/issues/152) | frontend | medium |
| [#153: Frontend: preserve scenario search and sort in shareable URLs](https://github.com/Esureorg/Esure/issues/153) | frontend | medium |
| [#154: Frontend: add a browser-local list of favorite scenarios](https://github.com/Esureorg/Esure/issues/154) | frontend | medium |
| [#155: Frontend: pause polling while the browser is offline](https://github.com/Esureorg/Esure/issues/155) | frontend | medium |
| [#156: CLI: add an offline report validation command](https://github.com/Esureorg/Esure/issues/156) | cli | medium |
| [#157: CLI: export assertion results as CSV](https://github.com/Esureorg/Esure/issues/157) | cli | medium |
| [#158: CLI: generate Bash and Zsh command completions](https://github.com/Esureorg/Esure/issues/158) | cli | medium |
| [#159: CLI: add a local installation doctor command](https://github.com/Esureorg/Esure/issues/159) | cli | medium |
| [#160: Backend: prune expired PostgreSQL run reports in bounded batches](https://github.com/Esureorg/Esure/issues/160) | backend | hard |
| [#161: Backend: add optimistic concurrency checks to persisted report updates](https://github.com/Esureorg/Esure/issues/161) | backend | hard |
| [#162: Backend: keep database resources open until run draining finishes](https://github.com/Esureorg/Esure/issues/162) | backend | medium |
| [#163: Backend: support conditional GET requests for unchanged run reports](https://github.com/Esureorg/Esure/issues/163) | backend | medium |
| [#164: Scenarios: cover rejection when lowering a trustline below its balance](https://github.com/Esureorg/Esure/issues/164) | scenarios | medium |
| [#165: Scenarios: demonstrate partial redemption followed by another transfer](https://github.com/Esureorg/Esure/issues/165) | scenarios | medium |
| [#166: Scenarios: cover a one-stroop issued-asset transfer](https://github.com/Esureorg/Esure/issues/166) | scenarios | medium |
| [#167: Scenarios: cover a text memo at the 28-byte UTF-8 boundary](https://github.com/Esureorg/Esure/issues/167) | scenarios | medium |
| [#168: CI: execute the existing CLI test suite on pull requests](https://github.com/Esureorg/Esure/issues/168) | testing | trivial |
| [#169: Tooling: add a root command for all deterministic package checks](https://github.com/Esureorg/Esure/issues/169) | testing | medium |
| [#170: Docs: publish a release checklist for the three application packages](https://github.com/Esureorg/Esure/issues/170) | documentation | trivial |
