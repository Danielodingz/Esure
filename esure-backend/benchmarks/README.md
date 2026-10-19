# Bounded in-memory stores benchmark

From `esure-backend`, after `npm ci`:

```sh
npm run bench:stores -- 833 20
npm run bench:stores -- 834 20
# Machine-readable output without npm's command banner:
npm run --silent bench:stores -- 833 20 > benchmarks/local-833.json
```

Arguments are a positive uint32 seed and 1–1000 measured samples per row.
Defaults are seed 833 and 20 samples; each row also has five discarded warmups.
Allow a few minutes: rebuilding 10,000-key fixtures through the public API
itself performs repeated scans. That setup cost is intentionally not timed.
No services, database, network requests, environment files, keys, or accounts
are used. Dependencies must already be installed. Output metadata uses an
explicit allowlist and does not read or dump environment variables.

The harness imports the current production classes, uses their public methods,
and injects a fixed synthetic clock. Each sample gets a fresh fixture outside
the timed interval; only one get/create/update/consume call is timed with
`hrtime.bigint`. Correctness assertions run afterward, without latency thresholds.
`npm run check` tests the fixture matrix but does not run performance measurements.

## Matrix and interpretation

The default run-store bound is 500 and limiter bound is 10,000. Small fixtures
contain 32 entries. Large fixtures contain capacity minus one entries except
the eviction workload, which starts exactly full. These are default bounds,
not every allowed `MAX_STORED_RUNS` configuration (which can reach 10,000).

- Mostly active: run reports are approximately 90% active (every tenth report is terminal);
  all limiter buckets are unexpired. Existing-key reads/updates/consumes hit.
  Create adds a new active run without eviction.
- Mostly expired: floor(90% of initial size) entries expire exactly at the
  retention/window boundary. Run reports in that prefix are terminal; the rest
  are active. Limiter survivors were inserted half a window later. A clock
  advance happens only after population, so setup does not remove the expired
  entries. Every measured call pays for the initial sweep. Reads/updates and
  consumes target a survivor; create inserts a new report.
- Eviction heavy: no entries are expired. The first terminal run lies after
  floor(90% of initial size) active runs. Large create evicts that terminal run;
  large consume inserts a new key and evicts the oldest bucket. Small rows are
  the same input mix with spare capacity, providing a no-eviction baseline.
  Get/update on this mix measure scans/clones only, since they cannot evict.

The seed selects live target positions deterministically for each sample.
Insertion order, payloads, and expiration counts are fixed. Reports contain
one synthetic step and one assertion with decimal-string amounts. Results do
not extrapolate to large reports, misses, denied consumes, active-only capacity
errors, concurrent requests, PostgreSQL, GC pauses under sustained traffic,
or end-to-end request latency. Setup allocates and scans too, so its allocations
can affect GC during a timed call despite setup time being excluded.

Output gives median, nearest-rank p95, and minimum microseconds per operation,
plus Node/V8, OS, architecture, CPU, seed, sample count, and warmups. Single-call
timings include timer/dispatch overhead, and 20 samples give only a rough tail
estimate. Repeat on an idle machine; compare distributions and repeated seeds,
not a single outlier. Never use wall-clock pass/fail thresholds in normal CI.

## Recorded results

Measured on 2026-10-18 against checkout `a3c2b0623f6d769efcfde4f285acf8689a42f02b`.
Compared with the issue's `833d9e6` baseline, the current run-store module adds
PostgreSQL persistence; the in-memory implementation and rate limiter are
unchanged. This benchmark measures only those in-memory classes.

Raw results: [seed 833](local-833.json), [seed 834](local-834.json).
These are local development measurements on a shared Windows host, with some
validation activity during the first run; they are not an isolated performance
baseline. The second run had no concurrent checks launched by this task.
Production eviction and expiration semantics are unchanged.

Node 24.11.1 / V8 13.6.233.10-node.28, Windows 10.0.22631 x64,
Intel Core i7-6820HQ at 2.70 GHz, 8 logical CPUs. Each run used 20 samples
and five warmups per row. Times below are microseconds; small means 32 entries,
large means 499 runs / 9,999 keys, or 500 / 10,000 for eviction inputs.

| Operation | Input | Small median (834) | Large median (833) | Large median (834) | Large p95 (834) |
| --- | --- | ---: | ---: | ---: | ---: |
| get | mostly active | 33.5 | 92.2 | 77.2 | 156.2 |
| get | mostly expired | 45.2 | 325.9 | 303.3 | 537.4 |
| get | eviction mix | 21.9 | 102.3 | 77.7 | 93.5 |
| create | mostly active | 19.3 | 68.8 | 64.5 | 97.6 |
| create | mostly expired | 31.6 | 376.6 | 266.7 | 405.0 |
| create | eviction mix | 19.2 | 223.7 | 136.1 | 177.4 |
| update | mostly active | 26.6 | 97.6 | 84.3 | 90.7 |
| update | mostly expired | 36.4 | 396.9 | 291.2 | 336.4 |
| update | eviction mix | 27.4 | 151.7 | 93.3 | 163.1 |
| consume | mostly active | 5.6 | 250.1 | 192.1 | 248.0 |
| consume | mostly expired | 5.0 | 1339.4 | 1778.2 | 2330.9 |
| consume | eviction mix | 2.1 | 166.8 | 226.3 | 364.3 |

In both runs, near-capacity mostly-expired calls cost more than mostly-active
calls for every operation. In seed 834, the large-to-small median ratio is
about 2.3–3.3 for mostly-active run operations and 34 for limiter consume.
Large mostly-expired consume costs about 1.78 ms versus 0.19 ms for mostly
active consume. Full run creation with eviction costs about 2.1 times the
mostly-active creation median, though the input mixes also differ.

These observations justify profiling expiry sweeps at capacity first. They do
not isolate map iteration, timestamp parsing, deletion, or report cloning;
nor do they establish that a different expiration structure is faster. No
production optimization is recommended on these two short runs alone. Any
candidate should preserve expiry boundaries and eviction order and be measured
with this matrix before adoption. Small limiter timings vary substantially
between runs, illustrating why these numbers should not become CI thresholds.

Validation: all 24 fixture cases passed as part of the backend unit/API run
(156 passed, 4 skipped; database suites excluded). Both `npm run check` and
`npm run build` were attempted and failed on existing `FastifyInstance.runs`
typing errors in `src/server.ts` (lines 37 and 49); check also reports
`test/app.test.ts:44`. No production, database, or migration files were changed.
