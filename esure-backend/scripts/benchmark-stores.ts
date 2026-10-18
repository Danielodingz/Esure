import assert from "node:assert/strict";
import { cpus, platform, release, arch } from "node:os";
import { pathToFileURL } from "node:url";
import type { RunReport } from "../src/domain.js";
import { InMemoryRunStore } from "../src/run-store.js";
import { FixedWindowRateLimiter } from "../src/rate-limiter.js";

export type Workload = "mostly-active" | "mostly-expired" | "eviction-heavy";
export type Operation = "get" | "create" | "update" | "consume";
const epoch = Date.parse("2026-01-01T00:00:00.000Z");
const windowMs = 60_000;

function report(id: string, terminal: boolean): RunReport {
  return {
    id, scenarioId: "synthetic-payment", scenarioVersion: 1, scenarioSchemaVersion: 1,
    scenarioContentHash: `sha256:${"a".repeat(64)}`, network: "testnet",
    status: terminal ? "passed" : "running", createdAt: new Date(epoch).toISOString(),
    ...(terminal ? { completedAt: new Date(epoch).toISOString() } : {}),
    steps: [{ id: "payment", type: "payment", status: "passed", message: "synthetic" }],
    assertions: [{ type: "balanceEquals", status: "passed", expected: "1.0000000", actual: "1.0000000", message: "synthetic" }],
    summary: { stepsPassed: 1, stepsFailed: 0, assertionsPassed: 1, assertionsFailed: 0 },
  };
}

// Public APIs only. Setup and verification must stay outside the timed interval.
export function prepare(operation: Operation, workload: Workload, capacity: number, small: boolean, seed: number) {
  const size = small ? Math.min(32, capacity - 1) : workload === "eviction-heavy" ? capacity : capacity - 1;
  const expired = workload === "mostly-expired" ? Math.floor(size * 0.9) : 0;
  let now = epoch;
  // Seeded position keeps the live target out of the expired prefix.
  const target = expired + (seed >>> 0) % (size - expired);
  if (operation === "consume") {
    const limiter = new FixedWindowRateLimiter(windowMs, capacity, () => now);
    for (let i = 0; i < size; i++) {
      if (i === expired && expired > 0) now += windowMs / 2;
      limiter.consume(`key-${i}`, 100);
    }
    if (expired > 0) now = epoch + windowMs;
    const key = workload === "eviction-heavy" ? "new-key" : `key-${target}`;
    let result: ReturnType<FixedWindowRateLimiter["consume"]>;
    return { size, expired, execute: () => { result = limiter.consume(key, 100); }, verify: () => {
      assert.equal(result.allowed, true);
      assert.equal(result.remaining, workload === "eviction-heavy" ? 99 : 98);
      if (expired > 0) assert.equal(limiter.consume("key-0", 100).remaining, 99);
      if (workload === "eviction-heavy" && !small) assert.equal(limiter.consume("key-0", 100).remaining, 99);
    } };
  }
  const store = new InMemoryRunStore(capacity, windowMs, () => now);
  for (let i = 0; i < size; i++) {
    // Full eviction fixtures put the first terminal candidate after 90% active runs.
    const terminal = i < expired || (workload === "eviction-heavy" && i >= Math.floor(size * 0.9))
      || (workload === "mostly-active" && i % 10 === 0);
    store.create(report(`run-${i}`, terminal));
  }
  if (expired > 0) now += windowMs;
  const incoming = report("new-run", false);
  const patch = { status: "running" as const };
  let result: RunReport | undefined;
  return { size, expired, execute: () => {
    if (operation === "get") result = store.get(`run-${target}`);
    else if (operation === "update") result = store.update(`run-${target}`, patch);
    else store.create(incoming);
  }, verify: () => {
    if (operation !== "create") assert.equal(result?.id, `run-${target}`);
    else assert.equal(store.get("new-run")?.network, "testnet");
    if (operation === "update") assert.equal(result?.status, "running");
    assert.equal(store.size, Math.min(capacity, size - expired + (operation === "create" ? 1 : 0)));
    if (expired > 0) assert.equal(store.get("run-0"), undefined);
    if (operation === "create" && workload === "eviction-heavy" && !small) {
      assert.equal(store.get(`run-${Math.floor(size * 0.9)}`), undefined);
      assert.equal(store.get("run-0")?.status, "running");
    }
  } };
}

function integer(value: string | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1 || Number(value) > max) {
    throw new Error(`Expected an integer from 1 to ${max}`);
  }
  return Number(value);
}

function main() {
  const [seedArg, samplesArg, ...extra] = process.argv.slice(2);
  assert.equal(extra.length, 0, "Usage: npm run bench:stores -- [seed] [samples]");
  const seed = integer(seedArg, 833, 0xffffffff);
  const samples = integer(samplesArg, 20, 1_000);
  const warmup = 5;
  const rows = [];
  for (const operation of ["get", "create", "update", "consume"] as const) {
    for (const workload of ["mostly-active", "mostly-expired", "eviction-heavy"] as const) {
      for (const small of [true, false]) {
        const capacity = operation === "consume" ? 10_000 : 500;
        const times: number[] = [];
        for (let sample = -warmup; sample < samples; sample++) {
          const fixture = prepare(operation, workload, capacity, small, (seed + sample + warmup) >>> 0);
          const start = process.hrtime.bigint();
          fixture.execute();
          const elapsed = Number(process.hrtime.bigint() - start) / 1_000;
          fixture.verify();
          if (sample >= 0) times.push(elapsed);
        }
        times.sort((a, b) => a - b);
        const fixtureSize = small ? 32 : workload === "eviction-heavy" ? capacity : capacity - 1;
        const percentile = (p: number) => times[Math.ceil(p * times.length) - 1]!;
        rows.push({ operation, workload, capacity, initialSize: fixtureSize,
          expiredEntries: workload === "mostly-expired" ? Math.floor(fixtureSize * 0.9) : 0,
          medianUs: percentile(0.5), p95Us: percentile(0.95), minUs: times[0] });
      }
    }
  }
  // Explicit allowlist: never serialize environment variables or application config.
  console.log(JSON.stringify({ metadata: { measuredAt: new Date().toISOString(), node: process.version, v8: process.versions.v8,
    os: platform(), release: release(), arch: arch(), cpu: cpus()[0]?.model,
    logicalCpus: cpus().length, seed, samples, warmup, clock: "hrtime.bigint", unit: "microseconds" }, rows }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
