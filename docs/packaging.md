# Standalone packaging and startup

## Installation paths

- `pi install npm:pi-contour` registers the npm package with Pi.
- `pi install git:github.com/monotykamary/pi-contour` registers a Git checkout with Pi.
- `bun install -g pi-contour` (or npm's equivalent) installs the independent CLI on PATH. It does not register a Pi extension.

Both extension sources use `pi.extensions = ["./dist/index.mjs"]`. The CLI uses `bin.contour = "dist/cli.mjs"`; the skill directory and identity image are declared in the Pi manifest. Distribution files are committed so Pi's production-only Git installation does not need developer tools. No `prepare`, install, or postinstall lifecycle is required. `prepack` is a maintainer operation that regenerates the npm distribution.

## Ownership and dependencies

`pi-fovea` is pinned from the npm registry as a **development dependency**. Its `pi-fovea/substrate` API owns relationship assembly and numerical diffusion; `pi-fovea/workspace` supplies lightweight root discovery and continuity. Contour owns immutable source snapshots, syntax-backed measurements, findings, and disclosure. No sibling-path dependency is shipped.

The extension and CLI bundles include the consumed substrate and TypeScript parser. They do not activate Fovea's extension, its observers, session state, CLI, or optional external parser. Installing Contour alone needs no Fovea registration, TypeScript install, or tsx runtime. Fovea and Contour can coexist: they share an algorithmic substrate and session-qualified target hints, not mutable analysis state. Their caches have different namespaces.

Tool parameters are plain, typed JSON Schema: startup does not import a schema builder. Pi APIs and `typebox` are wildcard peers, with Pi 1.0.0 and TypeBox 1.3.27 pinned for development. The Pi API import is type-only. Pi-managed installs suppress host peers (`npm --legacy-peer-deps`, `bun --omit=peer`); use those flags for a host-free standalone CLI installation too. The package probe checks the actual Pi 1.0 install contract and rejects physical host packages.

The registry-pinned `pi-fovea@0.27.0` development dependency is intentionally retained: its substrate and version-1 workspace protocol are compatible with the newer Fovea checkout. Updating it is a separate substrate release, not required for the Pi host migration. Cross-package probes exercise both extensions together; no sibling path or unpublished Fovea version is shipped. Bundled third-party license notices ship in `dist/THIRD_PARTY_LICENSES.txt`.

## Startup contract

The extension's full static bundle graph is small; the build rejects transitive imports of TypeScript, Fovea graph/parser modules, or the analysis engine, allowing only the lightweight workspace API, and enforces a 20KiB static-artifact ceiling with no external package imports. Native ESM can bypass jiti's virtual host modules; even an external TypeBox import can compile another library copy. `dist/startup.json` records the measured static bytes, files, and external imports; loader overhead is separate.

The factory registers one tool, one command, and lifecycle handlers. It does no analysis or I/O. `session_start` replaces the observer and installs a single unref'ed poll timer; it does not await an initial scan or import the analysis engine. An empty coordinator never scans its launch directory. Successful path access enrolls a project; only enrolled roots are eligible for a deferred scan. Each pass selects one root, alternating recent activity with a round-robin backstop. Explicit reviews load analysis on demand. `CONTOUR_BACKGROUND=0` disables all background timers/scans, including tool-result wakeups.

There are no automatic messages, UI notifications, test runs, hook installs, repository mutations, or agent continuations. Shutdown/reload aborts obsolete scans/checkpoints and releases timers. Branch-local root snapshots restore target metadata, not stale reports or semantic baselines. Dynamic import is shared within an engine generation and failed imports can be retried.

This removes the heavy startup dependency—not all overhead. Pi still reads the small interface bundle and registers the tool/skill. First-use module loading and per-file parsing run in-process; cooperative yields do not preempt one synchronous parse. Background discovery still performs bounded Git/stat work. Performance measurements are observations, not a promise of zero latency on every repository.

## Release verification

1. `bunx vitest run`, `bun run typecheck`, and `bun run lint:dead`: the full behavioral suite and dead-code gate at release time. Routine changes use the change-scoped `bun run check:fast` and `bun run test:smoke` instead.
2. `bun run build`: bundled dependency closure and static-startup gate.
3. `bun run smoke`: copied, dependency-free CLI; reported version; staged/worktree isolation; advisory and policy-enforced real commits.
4. `bun run verify:package`: archive contents, production-only npm and Git-layout installations, matching CLI version reporting, actual Pi resource loading, SDK session persistence, disjoint enrollment, cwd-default precedence, explicit-root selection, and lazy review from the installed package.
5. CI regenerates both `dist/` and `media/cover.svg` and rejects uncommitted drift.

Publish a new shared API in Fovea before updating Contour's pinned registry dependency. Reinstall/update the lock, rerun these checks, and commit source and distribution together. `bun publish` then runs the same prepack build. Runtime users never invoke the maintainer build chain.
