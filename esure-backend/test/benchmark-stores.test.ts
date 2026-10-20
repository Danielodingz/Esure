import { describe, it, expect } from "vitest";
import { prepare } from "../scripts/benchmark-stores.js";

describe("offline benchmark fixtures", () => {
  for (const operation of ["get", "create", "update", "consume"] as const) {
    for (const workload of ["mostly-active", "mostly-expired", "eviction-heavy"] as const) {
      for (const small of [true, false]) {
        it(`${operation}: ${workload}, ${small ? "small" : "full"}`, () => {
          const fixture = prepare(operation, workload, 50, small, 833);
          expect(fixture.size).toBe(small ? 32 : workload === "eviction-heavy" ? 50 : 49);
          expect(fixture.expired).toBe(workload === "mostly-expired" ? Math.floor(fixture.size * 0.9) : 0);
          fixture.execute();
          fixture.verify();
        });
      }
    }
  }
});
