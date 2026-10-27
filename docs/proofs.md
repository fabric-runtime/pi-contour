# Executed gdp-wired policies

Contour uses pinned gdp-wired 0.30.1 as its sole required proof toolchain. There
is no Lean/Bend compiler, runtime prover, or proof-service dependency. Nine
policies in `proofs/policies.ts` are compiled into standalone JavaScript and
executed by the extension and CLI. The 34 independent laws and their required
inventory live in `proofs/laws.ts` and `proofs/ledger.json`.

| Policy | Runtime use | Checked guarantee |
| --- | --- | --- |
| Budget | Snapshot files/bytes, subprocess output, selected findings | Exact admission, no cap overspend, refusal preserves usage |
| Retention | Memory LRU and storage pressure | Evict exactly when count or bytes exceed a cap |
| Workers | Parallel snapshot readers | Worker count bounded by requests and available items |
| Prefix fit | Rendered findings and coverage extras | Selected cost fits; later fitting prefixes are not skipped |
| Lease | Explicit and background reviews | Acceptance requires current epoch, lease and root presence |
| Snapshot | Completed report cache | Accept only matching baseline and target identities |
| Observer | Background launch/queue/preemption/rescan | No busy launch, no work after stop, no poll-only abort |
| Prune | Temporary storage | Never select protected/non-removable files; require a cleanup reason |
| Evidence | Blocking findings | Require an explicit policy and direct, unambiguous witness |

## Commands

- `bun run proofs:generate`: prove and independently cross-check each law, then
  regenerate all policy modules and the hash receipt.
- `bun run check:proofs`: prove, cross-check, and compare generated output.
- `bun run proofs:artifact`: check source/output hashes and the complete ABI inventory.
- `bun run check:fast`: proofs, typecheck and affected tests.

Boolean-only policies are emitted as complete finite truth tables evaluated
from the checked functions, with exhaustive independent tests for every Boolean
input combination. This keeps startup small without deferring work to idle
lifecycle hooks. Numeric policies retain the general generated machines.

The build requires a current proof artifact receipt. Both CI and publication run
proof checks. Distribution bundles record their own hashes in
`dist/proof-receipt.json`. Source, generated modules, the law inventory and MIT
attribution are included for auditing. Production installs require none of the
development dependencies. Startup still has a 20KiB static-graph ceiling.

## Scope and assumptions

These are universal decision laws, not a claim that the whole program is proved.
The JavaScript host supplies the actual costs, identity comparisons, file facts
and scheduling events. Filesystem races, OS permissions, Git behavior, hashing,
AST extraction, graph algorithms, JavaScript scheduling and floating-point heat
remain host obligations. Contour continues to use Fovea's substrate rather than
forking or claiming to re-prove it. Heat is exposure, never a defect probability.

Budget inputs are exact nonnegative integers at most 2^40; retention totals can
reach 2^41. Runtime guards enforce budget/prefix premises. Invalid cache/worker
limits are rejected instead of allowing hangs or silently skipped work. Storage
may remain over cap if only protected or unsafe-to-remove files remain: the
proof establishes safe eligibility, not a false unconditional disk-size bound.

Broken versions of every policy are retained in `tests/proofs.test.ts`. Existing
integration, snapshot, filesystem-race, lifecycle and package tests remain: they
cover the host boundaries that decision proofs do not establish.
