import { policies } from "./policies.ts";

export function policyLaws({
  budget,
  retention,
  workers,
  fit,
  lease,
  snapshot,
  observer,
  prune,
  evidence,
}: typeof policies) {
  return [
    budget.law(
      "budget_bounded",
      () => [],
      (r, e) => r.used.atMost(e.limit),
    ),
    budget.law(
      "budget_exact_admission",
      () => [],
      (r, e) =>
        r.admit
          .implies(e.used.plus(e.amount).atMost(e.limit))
          .and(e.used.plus(e.amount).atMost(e.limit).implies(r.admit)),
    ),
    budget.law(
      "budget_refusal_preserves",
      () => [],
      (r, e) => r.admit.not().implies(r.used.eq(e.used)),
    ),
    budget.law(
      "budget_admitted_adds",
      () => [],
      (r, e) => r.admit.implies(r.used.eq(e.used.plus(e.amount))),
    ),
    retention.law(
      "retention_exact_pressure",
      () => [],
      (r, e) =>
        r.evict
          .implies(e.count.gt(e.maxCount).or(e.bytes.gt(e.maxBytes)))
          .and(
            e.count.gt(e.maxCount).or(e.bytes.gt(e.maxBytes)).implies(r.evict),
          ),
    ),
    workers.law(
      "workers_request_bound",
      () => [],
      (r, e) => r.count.atMost(e.requested),
    ),
    workers.law(
      "workers_size_bound",
      () => [],
      (r, e) => r.count.atMost(e.size),
    ),
    workers.law(
      "workers_nonempty_progress",
      () => [],
      (r, e) => e.requested.gt(0).and(e.size.gt(0)).implies(r.count.gt(0)),
    ),
    fit.law(
      "fit_admitted_cost_bounded",
      () => [],
      (r, e) => r.selected.gt(0).implies(r.cost.atMost(e.budget)),
    ),
    fit.law(
      "fit_never_rewinds",
      () => [],
      (r, e) => r.selected.atLeast(e.selected),
    ),
    fit.law(
      "fit_takes_later_fitting_prefix",
      () => [],
      (r, e) =>
        e.cost
          .atMost(e.budget)
          .and(e.index.plus(1).gt(e.selected))
          .implies(r.selected.eq(e.index.plus(1))),
    ),
    fit.law(
      "fit_refuses_over_budget",
      () => [],
      (r, e) => e.cost.gt(e.budget).implies(r.selected.eq(e.selected)),
    ),
    lease.law(
      "lease_requires_epoch",
      () => [],
      (r, e) => r.valid.implies(e.epochSame),
    ),
    lease.law(
      "lease_requires_identity",
      () => [],
      (r, e) => r.valid.implies(e.leaseSame),
    ),
    lease.law(
      "lease_requires_presence",
      () => [],
      (r, e) => r.valid.implies(e.present),
    ),
    lease.law(
      "lease_current_is_valid",
      () => [],
      (r, e) => e.epochSame.and(e.leaseSame, e.present).implies(r.valid),
    ),
    snapshot.law(
      "snapshot_requires_baseline",
      () => [],
      (r, e) => r.valid.implies(e.baselineSame),
    ),
    snapshot.law(
      "snapshot_requires_target",
      () => [],
      (r, e) => r.valid.implies(e.targetSame),
    ),
    snapshot.law(
      "snapshot_unchanged_is_valid",
      () => [],
      (r, e) => e.baselineSame.and(e.targetSame).implies(r.valid),
    ),
    observer.law(
      "observer_no_overlapping_launch",
      () => [],
      (r, e) => e.busy.implies(r.launch.not()),
    ),
    observer.law(
      "observer_stopped_is_quiet",
      () => [],
      (r, e) =>
        e.stopped.implies(
          r.launch.not().and(r.queue.not(), r.abort.not(), r.rescan.not()),
        ),
    ),
    observer.law(
      "observer_launches_idle_work",
      () => [],
      (r, e) => e.stopped.not().and(e.busy.not()).implies(r.launch),
    ),
    observer.law(
      "observer_abort_requires_preemption",
      () => [],
      (r, e) => r.abort.implies(e.preempt.and(e.busy, e.stopped.not())),
    ),
    observer.law(
      "observer_poll_does_not_abort",
      () => [],
      (r, e) => e.preempt.not().implies(r.abort.not()),
    ),
    observer.law(
      "observer_queues_busy_work",
      () => [],
      (r, e) => e.stopped.not().and(e.busy).implies(r.queue),
    ),
    observer.law(
      "observer_revisits_new_generation",
      () => [],
      (r, e) => e.stopped.not().and(e.generationSame.not()).implies(r.rescan),
    ),
    prune.law(
      "prune_protects_current",
      () => [],
      (r, e) => e.protected.implies(r.remove.not()),
    ),
    prune.law(
      "prune_requires_removable",
      () => [],
      (r, e) => r.remove.implies(e.removable),
    ),
    prune.law(
      "prune_requires_reason",
      () => [],
      (r, e) => r.remove.implies(e.pressure.or(e.expired, e.oversized)),
    ),
    prune.law(
      "prune_eligible_is_removed",
      () => [],
      (r, e) =>
        e.protected
          .not()
          .and(e.removable, e.pressure.or(e.expired, e.oversized))
          .implies(r.remove),
    ),
    evidence.law(
      "blocking_requires_explicit_policy",
      () => [],
      (r, e) => r.blocking.implies(e.explicit),
    ),
    evidence.law(
      "blocking_requires_direct_witness",
      () => [],
      (r, e) => r.blocking.implies(e.direct),
    ),
    evidence.law(
      "blocking_refuses_ambiguity",
      () => [],
      (r, e) => e.ambiguous.implies(r.blocking.not()),
    ),
    evidence.law(
      "blocking_accepts_witnessed_policy",
      () => [],
      (r, e) => e.explicit.and(e.direct, e.ambiguous.not()).implies(r.blocking),
    ),
  ];
}
export const laws = policyLaws(policies);
