import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { proveDecision } from "gdp-wired";
import { policies } from "../proofs/policies.ts";
import { policyLaws, laws } from "../proofs/laws.ts";
import { budget } from "../src/verified/budget.js";
import { fit } from "../src/verified/fit.js";
import { Lru, mapLimit } from "../src/core/util.js";

const broken = [
  policyLaws({
    ...policies,
    budget: policies.budget.returns((e) => ({
      admit: e.used.eq(e.used),
      used: e.used.plus(e.amount),
    })),
  }).find((l) => l.name === "budget_bounded")!,
  policyLaws({
    ...policies,
    retention: policies.retention.returns((e) => ({ evict: e.count.lt(0) })),
  }).find((l) => l.name === "retention_exact_pressure")!,
  policyLaws({
    ...policies,
    workers: policies.workers.returns((e) => ({ count: e.requested.plus(1) })),
  }).find((l) => l.name === "workers_request_bound")!,
  policyLaws({
    ...policies,
    fit: policies.fit.returns((e) => ({
      selected: e.index.plus(1),
      cost: e.cost,
    })),
  }).find((l) => l.name === "fit_admitted_cost_bounded")!,
  policyLaws({
    ...policies,
    lease: policies.lease.returns((e) => ({
      valid: e.epochSame.or(e.epochSame.not()),
    })),
  }).find((l) => l.name === "lease_requires_epoch")!,
  policyLaws({
    ...policies,
    snapshot: policies.snapshot.returns((e) => ({
      valid: e.targetSame.or(e.targetSame.not()),
    })),
  }).find((l) => l.name === "snapshot_requires_baseline")!,
  policyLaws({
    ...policies,
    observer: policies.observer.returns((e) => ({
      launch: e.stopped.or(e.stopped.not()),
      queue: e.busy,
      abort: e.preempt,
      rescan: e.pending,
    })),
  }).find((l) => l.name === "observer_no_overlapping_launch")!,
  policyLaws({
    ...policies,
    prune: policies.prune.returns((e) => ({
      remove: e.protected.or(e.protected.not()),
    })),
  }).find((l) => l.name === "prune_protects_current")!,
  policyLaws({
    ...policies,
    evidence: policies.evidence.returns((e) => ({
      blocking: e.explicit.or(e.explicit.not()),
    })),
  }).find((l) => l.name === "blocking_requires_explicit_policy")!,
];

describe("executed proof policies", () => {
  it("registers every required independent law exactly once", () => {
    const ledger = JSON.parse(
      readFileSync(new URL("../proofs/ledger.json", import.meta.url), "utf8"),
    );
    expect(laws.map((l) => l.name).sort()).toEqual([...ledger].sort());
    expect(new Set(ledger).size).toBe(34);
  });
  it.each(broken.map((l) => [l.name, l] as const))(
    "refuses the broken %s implementation",
    (_name, law) => {
      const verdict = proveDecision(law);
      expect(verdict.proven && verdict.checked).toBe(false);
    },
  );
  it("matches exact admission for an independent finite grid", () => {
    for (let limit = 0; limit < 12; limit++)
      for (let used = 0; used <= limit; used++)
        for (let amount = 0; amount < 15; amount++) {
          const admit = used + amount <= limit;
          expect(budget({ used, amount, limit })).toEqual({
            admit,
            used: admit ? used + amount : used,
          });
        }
  });
  it("rejects invalid inputs and proof premises", () => {
    for (const used of [-1, 0.5, NaN, Infinity, 2 ** 40 + 1])
      expect(() => budget({ used, amount: 0, limit: 4 })).toThrow();
    expect(() => budget({ used: 5, amount: 0, limit: 4 })).toThrow();
    expect(() =>
      fit({ index: 0, cost: 1, budget: 4, selected: 1, selectedCost: 5 }),
    ).toThrow();
  });
  it("selects a later fitting prefix after an over-budget prefix", () => {
    let state = { selected: 0, cost: 0 };
    [0, 8, 4].forEach((cost, index) => {
      state = fit({
        index,
        cost,
        budget: 5,
        selected: state.selected,
        selectedCost: state.cost,
      });
    });
    expect(state).toEqual({ selected: 3, cost: 4 });
  });
  it("rejects cache and worker limits that previously could hang or silently skip work", async () => {
    expect(() => new Lru(-1)).toThrow();
    expect(() => new Lru(2, NaN)).toThrow();
    const cache = new Lru<string>(0);
    cache.set("a", "a");
    expect(cache.snapshot()).toEqual([]);
    expect(() => cache.set("b", "b", -1)).toThrow();
    await expect(mapLimit([1], 0, async (x) => x)).rejects.toThrow();
  });
});
