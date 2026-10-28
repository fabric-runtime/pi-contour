# Incremental performance

Run `bun run bench`. The corpus contains 120 files / 1,440 callables. It measures cold discovery, a no-change poll, one changed working-tree file, and staging those same bytes. It also starts a separate engine to check persistent-fact reuse.

A local development run measured:

| Path | Elapsed | Reparsed files | Source rereads | Graph models rebuilt |
|---|---:|---:|---:|---:|
| Cold | 276ms | 120 | 120 worktree + 120 Git blobs | 1 |
| No change | 49ms | 0 | 0 | 0 |
| One-file change | 113ms | 1 | 1 | 1 |
| Stage the same bytes | 79ms | 0 | 1 new Git blob | 0 |

An independent engine reused persisted facts with zero parses. Event-loop delay p99 was 13.6ms in this run. These timings exclude loading the TypeScript module and are observations, not CI thresholds or universal guarantees. The benchmark uses Git subprocesses and results depend on OS, storage, and competing work.

The executable acceptance criteria are work counts, not brittle timing assertions: a no-change pass must perform zero parses, source/blob rereads, model rebuilds, and review/heat recomputations. A one-file edit must parse/read only that file. Staging already analyzed bytes must reuse the model. Content and configuration changes must never reuse stale reports.

## Rotating roots and disk hydration

Run `bunx tsx scripts/bench-hydration.ts` for a bounded, real-Git workload with four roots, 60 files / 720 callables per root, and three warm round-robin passes. It uses isolated temporary storage and verifies that returned reports remain equal with no parses, model rebuilds, or review recomputations.

The profiled `hydrate` in `dist/chunk-3WCYVLDL.mjs` maps to `MetricsCache.hydrate` in `src/core/metrics.ts`. Previously, `ContourEngine.review` invoked it before looking up completed reports. Background observation rotates roots on its 5s polling schedule, but the hydration tracker retains only two roots. Three or more rotating roots could therefore repeatedly read, parse, checksum, and reinsert persisted facts just to return an already-completed report.

The report lookup now precedes hydration, but still follows a fresh snapshot capture with the same content/configuration key. A hit still runs throttled storage housekeeping, checks cancellation, and returns a clone. A miss still hydrates normally. No snapshot freshness checks, diagnostic handling, or policy laws were relaxed.

One serial local before/after run measured the twelve warm reviews:

| Measurement | Before | After |
|---|---:|---:|
| Wall time | 1,430ms | 1,239ms |
| Process CPU time | 380ms | 301ms |
| Fact-file reads | 12 | 0 |
| Disk fact reinsertions | 720 | 0 |
| Parses / model rebuilds | 0 / 0 | 0 / 0 |
| Completed-report hits | 12 | 12 |

That is about 13% less wall time and 21% less process CPU in this run, not a prediction for every Pi session. An earlier run concurrent with checks had noisy wall time (4,202ms before / 4,862ms after) despite eliminating the same work. The regression tests enforce eliminated hydration and retained freshness/immutability, not timing thresholds. The original live session was not replayed.

## Startup is a separate budget

The v0.2.0 interface's complete static bundle graph measured **18,932 bytes**, including Fovea's lightweight workspace API but excluding Pi's supplied TypeBox and loader. Build metadata allowlists only the workspace entry, root coordination, and scheduling primitives; static parsers, graph modules, and the analysis engine remain forbidden. The current build enforces a 20KiB ceiling and zero non-builtin static imports across the complete static graph (20,436 bytes in the hydration optimization build).

An isolated package probe with Pi 0.85.1 and Node 26.5.0 measured `session_start` at **0.153–0.186ms**. The full `DefaultResourceLoader.reload()` path, including package/resource discovery and Jiti loading, took **79–125ms**. These are local observations, not a latency guarantee or a measurement of Contour alone versus a baseline Pi startup.

No scan occurs in either the factory or `session_start`. Analysis loads at the first deferred scan or explicit review; first-use loading remains synchronous in-process. `CONTOUR_BACKGROUND=0` disables background analysis, not successful-access selection. An empty coordinator never scans cwd. The observer alternates recent activity with a round-robin backstop, one root per pass; a busy root cannot permanently starve quieter projects. A 5s tick is not a 5s per-root guarantee across 32 projects. Explicit checkpoints abort speculative work. `bun run verify:package` reports fresh measurements and proves that a standalone production install does not pull in a compiler, Fovea, tsx, or another Pi host.

## Patterns transferred from Fovea

- Content-addressed facts with explicit parser/semantic versions.
- Stat manifests as a read-avoidance proof, not an mtime-only guess.
- Bounded batch I/O and shared in-flight directory metadata requests.
- Immutable generation ownership and separate source-model/report identities.
- Byte/entry LRUs; two retained graph generations, separate bounded report retention across roots.
- Default 32-root recency ring; lightweight selection/leases stay independent of heavy models.
- Coalesced bounded ancestor discovery; no sibling scans, startup Git, or project-config trust inheritance.
- Local Git analysis disables fsmonitor and remote/lazy fetching.
- Cooperative event-loop yields during file and finding sweeps.
- Shared Chebyshev recurrence vectors across diffusion scales.
- Quiet, debounced background work with cancellation and a periodic correctness backstop.

Limits are intentionally visible. An oversized or unmodeled region becomes a coverage gap, never an apparently small or clean repository. The parser is synchronous within one bounded file; very large/deep source can still consume a noticeable timeslice. Heavy batch deployments should benchmark representative repositories before increasing limits.
