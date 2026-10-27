import { bool, fun, min, upTo, when } from "gdp-wired";
const count = upTo(2 ** 40);
const total = upTo(2 ** 41);

export const budget = fun("budget")
  .inputs({ used: count, amount: count, limit: count })
  .assume((e) => e.used.atMost(e.limit))
  .returns((e) => ({
    admit: e.used.plus(e.amount).atMost(e.limit),
    used: when(
      e.used.plus(e.amount).atMost(e.limit),
      e.used.plus(e.amount),
      e.used,
    ),
  }));
export const retention = fun("retention")
  .inputs({ count: total, bytes: total, maxCount: count, maxBytes: count })
  .returns((e) => ({
    evict: e.count.gt(e.maxCount).or(e.bytes.gt(e.maxBytes)),
  }));
export const workers = fun("workers")
  .inputs({ requested: count, size: count })
  .returns((e) => ({ count: min(e.requested, e.size) }));
export const fit = fun("fit")
  .inputs({
    index: count,
    cost: count,
    budget: count,
    selected: count,
    selectedCost: count,
  })
  .assume((e) => e.selected.gt(0).implies(e.selectedCost.atMost(e.budget)))
  .returns((e) => ({
    selected: when(
      e.cost.atMost(e.budget).and(e.index.plus(1).gt(e.selected)),
      e.index.plus(1),
      e.selected,
    ),
    cost: when(
      e.cost.atMost(e.budget).and(e.index.plus(1).gt(e.selected)),
      e.cost,
      e.selectedCost,
    ),
  }));
export const lease = fun("lease")
  .inputs({ epochSame: bool, leaseSame: bool, present: bool })
  .returns((e) => ({ valid: e.epochSame.and(e.leaseSame, e.present) }));
export const snapshot = fun("snapshot")
  .inputs({ baselineSame: bool, targetSame: bool })
  .returns((e) => ({ valid: e.baselineSame.and(e.targetSame) }));
export const observer = fun("observer")
  .inputs({
    stopped: bool,
    busy: bool,
    pending: bool,
    preempt: bool,
    generationSame: bool,
  })
  .returns((e) => ({
    launch: e.stopped.not().and(e.busy.not()),
    queue: e.stopped.not().and(e.busy),
    abort: e.stopped.not().and(e.busy, e.preempt),
    rescan: e.stopped.not().and(e.pending.or(e.generationSame.not())),
  }));
export const prune = fun("prune")
  .inputs({
    protected: bool,
    removable: bool,
    pressure: bool,
    expired: bool,
    oversized: bool,
  })
  .returns((e) => ({
    remove: e.protected
      .not()
      .and(e.removable, e.pressure.or(e.expired, e.oversized)),
  }));
export const evidence = fun("evidence")
  .inputs({ explicit: bool, direct: bool, ambiguous: bool })
  .returns((e) => ({ blocking: e.explicit.and(e.direct, e.ambiguous.not()) }));
export const policies = {
  budget,
  retention,
  workers,
  fit,
  lease,
  snapshot,
  observer,
  prune,
  evidence,
};
