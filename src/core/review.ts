import { budget } from "../verified/budget.js";
import { evidence } from "../verified/evidence.js";
import { diffuseMass, SUBSTRATE_VERSION, type Edge, type Graph } from "pi-fovea/substrate";
import { METRICS_VERSION } from "./metrics.js";
import { emptyTotals } from "./model.js";
import { digest, yieldLoop } from "./util.js";
import { regionOf, type AnalysisOptions, type Comparison, type Evidence, type Finding, type Model, type ReviewReport } from "./types.js";

export const optionsFor = (input: Partial<AnalysisOptions> = {}): AnalysisOptions => {
  const out = { scales: [0.5, 2, 8], maxFindings: 8, maxTokens: 2500, boundaries: [], ...input };
  if (!Array.isArray(out.scales) || !out.scales.length || out.scales.length > 5 || out.scales.some(t => !Number.isFinite(t) || t < 0 || t > 64)) throw new Error("Use 1..5 diffusion scales in [0,64]");
  if (!Number.isInteger(out.maxFindings) || out.maxFindings < 1 || out.maxFindings > 32) throw new Error("maxFindings must be 1..32");
  if (!Number.isInteger(out.maxTokens) || out.maxTokens < 256 || out.maxTokens > 16000) throw new Error("maxTokens must be 256..16000");
  if (!Array.isArray(out.boundaries) || out.boundaries.length > 64) throw new Error("At most 64 boundary policies are supported");
  for (const policy of out.boundaries) {
    if (!policy || typeof policy.reason !== "string" || !policy.reason.trim()) throw new Error("Boundary policies require a rationale");
    for (const path of [policy.from, policy.to]) if (typeof path !== "string" || !path || path.startsWith("/") || path.includes("\\") || path.split("/").some(p => !p || p === "." || p === "..")) throw new Error("Boundary prefixes must be repository-relative paths without trailing slashes");
  }
  return structuredClone(out);
};
export const configId = (options: AnalysisOptions): string => digest(JSON.stringify({ metrics: METRICS_VERSION, substrate: SUBSTRATE_VERSION, projection: "contour-v1", options }));
const inPrefix = (file: string, prefix: string): boolean => file === prefix || file.startsWith(prefix + "/");

interface ImportEdge { from: string; to: string; evidence: Evidence }
function exactImports(model: Model): ImportEdge[] {
  const out = new Map<string, ImportEdge>();
  for (const edge of model.graph.edges) {
    // Policies/cycle claims require a direct, unambiguous relative-import witness.
    if (edge.kind !== "imports" || edge.evidence?.strategy !== "relative-import" || edge.evidence.possible || edge.evidence.candidates !== 1) continue;
    const from = model.graph.nodes[edge.a]!.file, to = model.graph.nodes[edge.b]!.file;
    const site = model.files.get(from)?.facts.imports.find(site => site.spec === edge.evidence?.source);
    out.set(`${from}\0${to}`, { from, to, evidence: { file: from, line: site?.line ?? 1, relation: "relative import", witness: `${edge.evidence.source} -> ${to}` } });
  }
  return [...out.values()];
}

/** Iterative Kosaraju: directed import SCCs, linear in files plus edges, no recursion limit. */
function components(edges: ImportEdge[]): string[][] {
  const forward = new Map<string, string[]>(), reverse = new Map<string, string[]>();
  for (const { from, to } of edges) {
    if (!forward.has(from)) forward.set(from, []); if (!forward.has(to)) forward.set(to, []);
    if (!reverse.has(from)) reverse.set(from, []); if (!reverse.has(to)) reverse.set(to, []);
    forward.get(from)!.push(to); reverse.get(to)!.push(from);
  }
  const visited = new Set<string>(), order: string[] = [];
  for (const start of forward.keys()) {
    if (visited.has(start)) continue;
    const stack: Array<[string, boolean]> = [[start, false]];
    while (stack.length) {
      const [node, done] = stack.pop()!;
      if (done) { order.push(node); continue; }
      if (visited.has(node)) continue;
      visited.add(node); stack.push([node, true]);
      for (const next of forward.get(node)!) if (!visited.has(next)) stack.push([next, false]);
    }
  }
  visited.clear(); const groups: string[][] = [];
  for (const start of order.reverse()) {
    if (visited.has(start)) continue;
    const group: string[] = [], stack = [start]; visited.add(start);
    while (stack.length) { const node = stack.pop()!; group.push(node); for (const next of reverse.get(node)!) if (!visited.has(next)) { visited.add(next); stack.push(next); } }
    if (group.length > 1) groups.push(group.sort());
  }
  return groups;
}

function collect(before: Model, after: Model, changed: Set<string>, options: AnalysisOptions): Finding[] {
  const findings: Finding[] = [];
  const push = (finding: Omit<Finding, "id">): void => {
    findings.push({ ...finding, blocking: finding.blocking && evidence({ explicit: finding.category === "policy", direct: finding.evidence.some(site => site.relation === "relative import"), ambiguous: finding.evidence.some(site => site.relation === "possible import") }).blocking, id: digest(JSON.stringify([finding.category, finding.title, finding.evidence, finding.before, finding.after])).slice(0, 20) });
  };
  for (const file of changed) {
    const current = after.files.get(file), previous = before.files.get(file);
    if (!current) continue;
    // Missing baseline extraction must not be interpreted as zero complexity.
    if ((before.snapshot.files.has(file) && !previous) || before.omissions.some(gap => gap.file === file)) continue;
    for (const callable of current.callables) {
      const old = previous?.callables.find(f => f.id === callable.id);
      if (callable.cc > 10 && callable.decisions > (old?.decisions ?? 0)) push({ category: "complexity", title: `${callable.name}: decision load increased`, evidence: [{ file, line: callable.line, endLine: callable.endLine }], before: old?.decisions ?? 0, after: callable.decisions, unit: "decisions (CC = decisions + 1)", question: "Is this additional branching required, or can responsibilities be separated without merely distributing the same decisions?", blocking: false });
    }
    const counts = (patterns: FileAnalysisPatterns): Map<string, number> => {
      const out = new Map<string, number>(); for (const p of patterns) out.set(p.rule, (out.get(p.rule) ?? 0) + 1); return out;
    };
    const oldCounts = counts(previous?.patterns ?? []), newCounts = counts(current.patterns);
    for (const [rule, count] of newCounts) if (count > (oldCounts.get(rule) ?? 0)) {
      const matches = current.patterns.filter(p => p.rule === rule);
      push({ category: "verbosity", title: `${rule}: additional syntax patterns`, evidence: matches.slice(0, 8).map(p => ({ file, line: p.line, endLine: p.endLine, witness: rule })), before: oldCounts.get(rule) ?? 0, after: count, unit: "pattern occurrences", question: matches[0]!.question, blocking: false });
    }
  }
  const oldClones = new Map<string, number>();
  for (const analysis of before.files.values()) for (const callable of analysis.callables) oldClones.set(callable.cloneHash, (oldClones.get(callable.cloneHash) ?? 0) + 1);
  for (const group of after.clones) {
    if (group.some(site => before.omissions.some(gap => gap.file === site.file))) continue;
    const previous = oldClones.get(group[0]!.callable.cloneHash) ?? 0;
    if (group.length <= previous || !group.some(site => changed.has(site.file))) continue;
    push({ category: "duplication", title: "Additional exact-token callable copies", evidence: group.slice(0, 8).map(({ file, callable }) => ({ file, line: callable.line, endLine: callable.endLine, relation: "same body token sequence", witness: callable.name })), before: previous, after: group.length, unit: "copies", question: "Do these implementations represent one responsibility, or is their independence intentional? Compare signatures and surrounding contracts before sharing code.", blocking: false });
  }
  const oldImports = exactImports(before), imports = exactImports(after);
  const oldPairs = new Set(oldImports.map(e => `${e.from}\0${e.to}`));
  const missingBaseline = new Set(before.omissions.map(gap => gap.file));
  const added = imports.filter(e => !missingBaseline.has(e.from) && !missingBaseline.has(e.to) && !oldPairs.has(`${e.from}\0${e.to}`));
  for (const edge of added) {
    if (regionOf(edge.from) !== regionOf(edge.to)) push({ category: "coupling", title: `New dependency across directory regions`, evidence: [edge.evidence, { file: edge.to, line: 1, relation: "import target" }], before: 0, after: 1, unit: "direct dependency", question: "Should this region know about that implementation? Directory regions are a proxy, not declared architectural boundaries.", blocking: false });
    for (const policy of options.boundaries) if (inPrefix(edge.from, policy.from) && inPrefix(edge.to, policy.to)) push({ category: "policy", title: `Forbidden dependency: ${policy.from} -> ${policy.to}`, evidence: [edge.evidence], before: 0, after: 1, unit: "explicit boundary violation", question: policy.reason, blocking: true });
  }
  const oldComponents = new Set(components(oldImports).map(group => group.join("\0")));
  for (const group of components(imports)) if (!oldComponents.has(group.join("\0"))) {
    const members = new Set(group);
    const witnesses = imports.filter(e => members.has(e.from) && members.has(e.to));
    const newWitnesses = witnesses.filter(e => added.some(a => a.from === e.from && a.to === e.to));
    if (group.some(file => missingBaseline.has(file))) continue;
    if (!newWitnesses.length) continue;
    push({ category: "cycle", title: "New or expanded mutually dependent import region", evidence: [...newWitnesses, ...witnesses.filter(e => !newWitnesses.includes(e))].slice(0, 8).map(e => e.evidence), before: 0, after: group.length, unit: "files in strongly connected region", question: "Can these responsibilities depend in one direction? Imports establish a structural cycle, not necessarily a runtime failure.", blocking: false });
  }
  return findings;
}
type FileAnalysisPatterns = Model["files"] extends ReadonlyMap<string, infer A> ? A extends { patterns: infer P } ? P : never : never;

const weights: Partial<Record<Edge["kind"], number>> = { contains: 0.5, imports: 1, invokes: 0.7 };
function projection(graph: Graph): Graph {
  return { ...graph, edges: graph.edges.filter(e => weights[e.kind] !== undefined && !e.evidence?.possible
    && (e.kind === "contains" || (e.kind === "imports" && e.evidence?.strategy === "relative-import" && e.evidence.candidates === 1)
      || (e.kind === "invokes" && e.evidence?.strategy !== "globally-unique-symbol" && e.evidence?.candidates === 1))).map(e => ({ ...e, w: weights[e.kind]! })) };
}

export async function reviewModels(comparison: Comparison, before: Model, after: Model, options: AnalysisOptions, signal?: AbortSignal): Promise<ReviewReport> {
  const all = collect(before, after, new Set(comparison.changed), options);
  // Round-robin categories: never add unlike metric units into a synthetic quality score.
  const categories = ["policy", "cycle", "complexity", "duplication", "coupling", "verbosity"] as const;
  const queues = categories.map(category => all.filter(f => f.category === category).sort((a, b) => (b.after - b.before) - (a.after - a.before) || a.id.localeCompare(b.id)));
  const selected: Finding[] = [];
  while (selected.length < options.maxFindings && queues.some(q => q.length)) for (const queue of queues) {
    if (queue.length && budget({ used: selected.length, amount: 1, limit: options.maxFindings }).admit) selected.push(queue.shift()!);
  }
  const graph = projection(after.graph);
  for (const finding of selected) {
    signal?.throwIfAborted(); await yieldLoop();
    const site = finding.evidence[0]!;
    const candidates = graph.byFile.get(site.file) ?? [];
    const idx = candidates.find(i => graph.nodes[i]!.line === site.line && graph.nodes[i]!.kind !== "file")
      ?? candidates.find(i => graph.nodes[i]!.kind === "file");
    if (idx === undefined) continue;
    const seed = new Float64Array(graph.nodes.length); seed[idx] = 1;
    finding.exposure = diffuseMass(graph, seed, options.scales).map(({ time, mass }) => {
      const fileMass = new Map<string, number>(); let outsideRegion = 0;
      mass.forEach((value, i) => {
        const file = graph.nodes[i]!.file;
        fileMass.set(file, (fileMass.get(file) ?? 0) + value);
        if (regionOf(file) !== regionOf(site.file)) outsideRegion += value;
      });
      return { time, sourceMass: 1, conservedMass: mass.reduce((a, b) => a + b, 0), outsideRegion,
        neighbors: [...fileMass].filter(([file, mass]) => file !== site.file && mass > 1e-8).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 6).map(([file, mass]) => ({ file, mass })) };
    });
  }
  // Heat orders review within a category only; the sources remain the witnessed findings.
  selected.sort((a, b) => categories.indexOf(a.category) - categories.indexOf(b.category)
    || (b.exposure?.at(-1)?.outsideRegion ?? 0) - (a.exposure?.at(-1)?.outsideRegion ?? 0) || a.id.localeCompare(b.id));
  const configHash = configId(options);
  return {
    schemaVersion: 1, id: digest(`${comparison.root}\0${comparison.target}\0${before.snapshot.revision}\0${before.snapshot.id}\0${after.snapshot.id}\0${configHash}`),
    root: comparison.root, target: comparison.target, baseline: before.snapshot.revision, snapshot: after.snapshot.id,
    changed: comparison.changed, before: before.totals, after: after.totals,
    regions: [...new Set(comparison.changed.map(regionOf))].sort().map(region => ({ region, before: before.regions[region] ?? emptyTotals(), after: after.regions[region] ?? emptyTotals() })),
    findings: selected, totalFindings: all.length, blockingFindings: all.filter(f => f.blocking).length,
    coverage: { before: before.omissions, after: after.omissions, notes: [
      "JS/TS syntax metrics only; no type checking, behavioral equivalence, or test adequacy claims.",
      "Exact-token callable clones (>=30 tokens, >=4 source lines); signatures and parameter contracts may differ.",
      "Directory regions approximate subsystems. Calls are name-based evidence, not proven runtime targets.",
      "Heat is conserved review exposure, not defect probability. Times are graph scales, not wall-clock age.",
      `Unresolved imports: before ${before.graph.importCoverage?.unresolved ?? 0}, after ${after.graph.importCoverage?.unresolved ?? 0}; external dependencies and unsupported resolution forms are not modeled.`,
    ] }, configHash,
  };
}
