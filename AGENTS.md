# pi-contour

Evidence-first structural review, not a universal quality score.

## Verification

Routine changes use the change-scoped check; a release uses the full suite.

```sh
bun run check:fast                           # typecheck + affected tests
bun run test:changed                         # dirty src/tests files vs HEAD
bun run test:affected                        # CI mode: $PI_TEST_BASE vs HEAD
bun run test:smoke                           # curated entrypoint floor, seconds
bun run test:related -- src/cli.ts           # tests importing given files
bunx vitest run                              # the whole suite, deliberately
```

`scripts/test-affected.mjs` backs the first three. It feeds changed source
files to `vitest related`, runs changed `tests/**/*.test.ts` directly, and drops
deleted paths. That selection avoids the vitest `--changed` pitfall where a
dirty `package.json` forces the entire suite to run, and nothing falls back to
the full suite: there is no `bun run check` or `bun run test` script any more.
CI selects by range, passing the pull-request base or the replaced push tip as
`PI_TEST_BASE`, and the curated `test:smoke` floor carries a push the selection
did not cover. `bun run lint:dead` costs under a second and stays in CI.

Then `bun run build`, `bun run smoke`, and `bun run verify:package` when entrypoints/packaging change. No build alone counts as completion. Commit regenerated `dist/` alongside source: production-only Git installs require it. `bun run cover` regenerates the standalone SVG.

## Startup: external is not necessarily host-shared

Warm jiti caches avoid transpilation, not V8 compilation. Native ESM can bypass
jiti's virtual host modules: an external TypeBox import previously compiled a
second schema-library graph and dominated the tiny Contour entrypoint. Register
plain, typed JSON Schema here; Pi still validates it normally. Use `import type`
for host types. Keep analysis and report rendering behind actual review calls.

Guard the **entire transitive static bundle**, including shared chunks and
external package edges, not just `dist/index.mjs`. The build enforces a 20KiB
ceiling and zero non-builtin static imports. Do not raise these budgets to make
a regression pass. Never relocate heavy initialization into `session_start`,
an idle poll, an immediately invoked async function, or a zero-delay timer.

Validate idle startup and real first-use/cleanup behavior, then rebuild and run
`smoke` and `verify:package`. Source-only tests cannot catch bundle hoisting or
native-loader alias bypasses. From the sibling Fabric checkout, run
`bun run benchmark:startup ../pi-contour` for fresh-process import/registration
medians with warm filesystem caches. A repeated import in one process measures
cache hits, not boot; use structural checks rather than CI timing thresholds.

## Executed policy proofs

`proofs/policies.ts` and independent `proofs/laws.ts` define the generated runtime
policies. After changing proof inputs or their generator, run
`bun run proofs:generate`, review `src/verified/`, then `bun run check:fast`.
Never hand-edit generated policies or weaken a law. `docs/proofs.md` states the
checked guarantees and host obligations. Builds require fresh proof receipts.

## Invariants

- Commit reviews use HEAD versus the Git index, never live worktree bytes.
- Immutable, content-addressed snapshots own findings and heat fields.
- Incremental background discovery is silent; only checkpoints disclose findings.
- Heat is conserved exposure, not defect probability. Categories retain separate units.
- Reuse `pi-fovea/substrate`; do not fork graph resolution or numerical solvers.
- Unsupported, capped, unreadable, and unresolved inputs are visible coverage gaps.
- Advisory by default; no automatic edits, commits, hook installation, or agent continuation.
- Version extraction semantics and cache keys together.
- Heavy analysis dependencies are registry-pinned dev dependencies bundled into distribution artifacts. Never ship a sibling path. Pi supplies typebox.
- Startup must not import the analysis engine or perform Git I/O. Keep the full static bundle graph small; honor `CONTOUR_BACKGROUND=0`.
- Conventional commits. Plain comments, no decorative separators.
