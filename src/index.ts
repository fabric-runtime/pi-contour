import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ExecutionRoots, ProjectDiscovery, accessedPaths, WORKSPACE_ACCESS_EVENT, peerWorkspaceRoot, latestWorkspaceEntry, envInt } from "pi-fovea/workspace";
import type { ContourEngine } from "./core/engine.js";
import type { AnalysisOptions, Target } from "./core/types.js";
import { SilentObserver } from "./core/background.js";

export default function contour(pi: ExtensionAPI): void {
  const roots = new ExecutionRoots(envInt("CONTOUR_MAX_ROOTS", 32, 1, 32));
  const discovery = new ProjectDiscovery();
  const dirty = new Set<string>(), errors = new Map<string, string>();
  const checkpoints = new Set<{ root: string; controller: AbortController }>();
  let epoch = 0, savedRevision = -1, cursor = 0, preferDirty = true;
  let activeScan: string | undefined, unsubscribe: (() => void) | undefined;
  let selection: Promise<unknown> = Promise.resolve();
  let engine: Promise<ContourEngine> | undefined;
  const getEngine = (): Promise<ContourEngine> => {
    if (!engine) {
      const pending = import("./core/engine.js").then(({ ContourEngine }) => new ContourEngine());
      engine = pending;
      void pending.catch(() => { if (engine === pending) engine = undefined; });
    }
    return engine;
  };
  let observer: SilentObserver | undefined;
  const persistRoots = (force = false): void => {
    if (!force && savedRevision === roots.revision) return;
    pi.appendEntry?.("pi-contour-workspace", roots.snapshot()); savedRevision = roots.revision;
  };
  // A manual call means "the project I am in": the session cwd's own project
  // wins over the recency ring. The ring stays the fallback for a coordinator
  // cwd, where a review needs a Git worktree and the most recently accessed
  // project is the only available subject.
  const selectRoot = (input: string | undefined, ctx: ExtensionContext, peer = false, requireGit = false): Promise<string> => {
    const generation = epoch;
    const task = selection.catch(() => {}).then(async () => {
      if (epoch !== generation) throw new Error("Contour session changed during root selection");
      const requested = input === undefined
        ? (await discovery.discover(ctx.cwd, "."))?.root ?? roots.target(ctx.cwd)
        : roots.target(ctx.cwd, input);
      const project = await discovery.discover(ctx.cwd, requested);
      if (epoch !== generation) throw new Error("Contour session changed during root discovery");
      if (requireGit && !project?.git) throw new Error(`Contour needs a Git worktree: ${requested}. Access a project file or pass root explicitly.`);
      const root = project?.root ?? requested;
      const change = roots.bind(root);
      if (change.evicted) {
        dirty.delete(change.evicted); errors.delete(change.evicted);
        for (const checkpoint of checkpoints) if (checkpoint.root === change.evicted) checkpoint.controller.abort(new Error("Contour root retired during review"));
      }
      dirty.add(root); persistRoots();
      if (!peer) pi.events?.emit(WORKSPACE_ACCESS_EVENT, { version: 1, source: "contour", root, sessionId: ctx.sessionManager?.getSessionId() });
      return root;
    });
    selection = task; return task;
  };
  const startObserver = (): void => { if (process.env.CONTOUR_BACKGROUND !== "0") observer?.start(false); };
  const restore = async (ctx: ExtensionContext, empty = false): Promise<void> => {
    epoch++; selection = Promise.resolve();
    for (const checkpoint of checkpoints) checkpoint.controller.abort(new Error("Contour session changed"));
    checkpoints.clear();
    await observer?.stop(); engine = undefined;
    discovery.clear(); dirty.clear(); errors.clear(); activeScan = undefined; cursor = 0; preferDirty = true;
    roots.restore(empty ? undefined : latestWorkspaceEntry(ctx.sessionManager?.getBranch?.() ?? [], "pi-contour-workspace"));
    savedRevision = roots.revision;
    observer = new SilentObserver(async signal => {
      const targets = roots.list();
      if (!targets.length) return;
      const { lease: validLease } = await import("./verified/lease.js");
      // Alternate recent activity with a round-robin backstop: a busy root
      // cannot starve quieter projects indefinitely. One root per pass.
      const root = (preferDirty ? dirty.values().next().value : undefined) ?? targets[cursor++ % targets.length]!;
      preferDirty = !preferDirty;
      dirty.delete(root);
      const generation = epoch, lease = roots.lease(root);
      const current = () => validLease({ epochSame: generation === epoch, leaseSame: roots.lease(root) === lease, present: roots.list().includes(root) }).valid;
      activeScan = root;
      try {
        const project = await discovery.discover(root, root, true);
        if (!project || project.root !== root) { if (current()) errors.set(root, "No Git worktree: structural patch review unavailable"); return; }
        signal.throwIfAborted();
        if (!current()) return;
        const report = await (await getEngine()).review(root, "working-tree", {}, signal);
        if (report.root !== root) throw new Error("Git resolved outside the selected worktree");
        if (current()) errors.delete(root);
      } catch (error) {
        if (current() && !signal.aborted) errors.set(root, error instanceof Error ? error.message : String(error));
      } finally { if (current() && activeScan === root) activeScan = undefined; }
    });
    startObserver();
  };
  const subscribe = (ctx: ExtensionContext): void => {
    unsubscribe = pi.events?.on(WORKSPACE_ACCESS_EVENT, data => {
      const root = peerWorkspaceRoot(data, ctx.sessionManager?.getSessionId(), "contour");
      if (root) void selectRoot(root, ctx, true).then(() => observer?.wake(false), () => {});
    });
  };
  pi.on("session_start", async (_event, ctx) => {
    unsubscribe?.(); unsubscribe = undefined; await restore(ctx); subscribe(ctx);
  });
  pi.on("session_tree", async (_event, ctx) => {
    unsubscribe?.(); unsubscribe = undefined; await restore(ctx); subscribe(ctx);
  });
  pi.on("session_compact", () => persistRoots(true));
  pi.on("session_shutdown", async () => {
    epoch++; unsubscribe?.(); unsubscribe = undefined;
    for (const checkpoint of checkpoints) checkpoint.controller.abort(new Error("Contour session shut down"));
    checkpoints.clear();
    await observer?.stop(); observer = undefined; engine = undefined;
    roots.clear(); dirty.clear(); errors.clear(); discovery.clear();
  });
  pi.on("tool_result", async (event, ctx) => {
    if (event.isError) return;
    const generation = epoch;
    for (const path of accessedPaths(event.toolName, event.input, ctx.cwd)) {
      const project = await discovery.discover(ctx.cwd, path);
      if (!project || generation !== epoch) continue;
      try {
        const root = await selectRoot(project.root, ctx);
        observer?.wake((event.toolName === "edit" || event.toolName === "write") && activeScan === root);
      } catch { /* Completed native tools must not fail because analysis is unavailable. */ }
    }
  });

  const review = async (ctx: ExtensionContext, root: string | undefined, target: Target, options: Partial<AnalysisOptions> = {}, signal?: AbortSignal) => {
    const generation = epoch;
    const selected = await selectRoot(root, ctx, false, true);
    const { lease: validLease } = await import("./verified/lease.js");
    const lease = roots.lease(selected), heldObserver = observer;
    const checkpoint = { root: selected, controller: new AbortController() };
    checkpoints.add(checkpoint);
    const abort = () => checkpoint.controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const current = () => validLease({ epochSame: epoch === generation, leaseSame: roots.lease(selected) === lease, present: roots.list().includes(selected) }).valid;
    try {
      // An explicit checkpoint takes priority over speculative background work.
      await heldObserver?.stop();
      checkpoint.controller.signal.throwIfAborted();
      if (!current()) throw new Error("Contour workspace changed during review");
      const project = await discovery.discover(selected, selected, true);
      if (!project || project.root !== selected) throw new Error(`Contour needs a Git worktree: ${selected}. Access a project file or pass root explicitly.`);
      checkpoint.controller.signal.throwIfAborted();
      if (!current()) throw new Error("Contour workspace changed during review");
      const report = await (await getEngine()).review(selected, target, options, checkpoint.controller.signal);
      if (!current()) throw new Error("Contour workspace changed during review; retry with an explicit root");
      if (report.root !== selected) throw new Error("Git resolved outside the selected worktree");
      dirty.delete(selected); errors.delete(selected);
      return report;
    } finally {
      checkpoints.delete(checkpoint); signal?.removeEventListener("abort", abort);
      if (epoch === generation && observer === heldObserver && !checkpoints.size) startObserver();
    }
  };

  pi.registerTool({
    name: "contour_review", label: "Contour review",
    description: "Review HEAD against the staged patch (default) or working tree. Uses the session cwd's own Git project, falling back to the most recently accessed project outside one; root explicitly selects a Git project anywhere. Root and agent origin are reported separately. Bounded structural evidence and multiscale exposure, not a quality score or correctness approval. Read-only; JS/TS metrics, explicit coverage gaps. Budget estimate: 4 characters/token.",
    promptSnippet: "Evidence-first structural review of a coherent patch",
    promptGuidelines: ["contour_review defaults to the session cwd's own project and falls back to successful project access in a coordinator cwd; pass root explicitly for parallel or ambiguous multi-project checkpoints."],
    // Pi accepts JSON Schema directly. A runtime TypeBox import from an ESM
    // bundle can bypass jiti's host aliases and compile a second schema library.
    parameters: {
      type: "object",
      properties: {
        root: { type: "string", description: "Project path, absolute or relative to the invoking tool context. Omitted uses the session cwd's own project, falling back to the most recently accessed project." },
        target: { type: "string", enum: ["staged", "working-tree"], description: "staged compares HEAD to the index, never live worktree content" },
        maxTokens: { type: "integer", minimum: 256, maximum: 16000 },
        maxFindings: { type: "integer", minimum: 1, maximum: 32 },
      },
      additionalProperties: false,
    } as const,
    async execute(_id, params, signal, _update, ctx) {
      const target = params.target ?? "staged";
      if (target !== "staged" && target !== "working-tree") throw new Error("Unknown review target");
      const options = { ...(params.maxTokens === undefined ? {} : { maxTokens: params.maxTokens }), ...(params.maxFindings === undefined ? {} : { maxFindings: params.maxFindings }) };
      const report = await review(ctx, params.root, target, options, signal);
      const { renderReport } = await import("./core/render.js");
      const rendered = renderReport(report, params.maxTokens);
      return { content: [{ type: "text", text: rendered.text }], details: {
        schemaVersion: report.schemaVersion, id: report.id, root: report.root, agentOrigin: ctx.cwd, workspace: roots.details(),
        target: report.target, baseline: report.baseline, snapshot: report.snapshot, configHash: report.configHash, before: report.before, after: report.after,
        totalFindings: report.totalFindings, displayed: rendered.displayed, tokens: rendered.tokens,
        coverage: { beforeCount: report.coverage.before.length, afterCount: report.coverage.after.length,
          examples: report.coverage.after.slice(0, 8), notes: report.coverage.notes }, findings: report.findings.slice(0, rendered.displayed),
      } };
    },
  });
  pi.registerCommand("contour", {
    description: "Review [staged|working-tree] [--root path], or status/reset",
    async handler(args, ctx) {
      const trimmed = args.trim();
      if (trimmed === "status") {
        await selection.catch(() => {});
        if (ctx.hasUI) ctx.ui.notify(`Contour · ${roots.list().length}/${roots.capacity} roots · active ${roots.list().length ? roots.target(ctx.cwd) : "none (coordinator idle)"}\nObserved: ${roots.list().join(", ")}\n${roots.details().continuity}${errors.size ? "\nUnavailable: " + [...errors].map(([root,error]) => `${root}: ${error}`).join("; ") : ""}`, "info");
        return;
      }
      if (trimmed === "reset") {
        await restore(ctx, true);
        persistRoots(true); return;
      }
      const match = /^review(?:\s+(staged|working-tree))?(?:\s+--root\s+(.+))?$/u.exec(trimmed);
      if (!match) { if (ctx.hasUI) ctx.ui.notify("Usage: /contour review [staged|working-tree] [--root path] | status | reset", "info"); return; }
      let root = match[2]?.trim();
      if (root && ((root.startsWith('"') && root.endsWith('"')) || (root.startsWith("'") && root.endsWith("'")))) root = root.slice(1, -1);
      if (root !== undefined && !root) throw new Error("Root must not be empty");
      const report = await review(ctx, root, match[1] === "working-tree" ? "working-tree" : "staged");
      const { renderReport } = await import("./core/render.js");
      pi.sendMessage({ customType: "contour-review", content: renderReport(report).text, details: { root: report.root, agentOrigin: ctx.cwd, workspace: roots.details() }, display: true }, { triggerTurn: false });
    },
  });
}
