import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { ContourEngine } from "../src/core/engine.js";
import { TemporaryStorage, temporaryStorage } from "../src/core/storage.js";
import { run } from "../src/core/util.js";

// Round-robin background workload: more roots than the two-root hydration LRU.
// Use real Git snapshots and isolated disk facts, not a repeated module import.
if (typeof process.getuid !== "function") {
  throw new Error("The hydration benchmark requires POSIX uid-based storage ownership checks.");
}
const parent = await realpath(await mkdtemp(join(tmpdir(), "contour-hydration-")));
const storage = new TemporaryStorage(join(parent, `pi-contour-${process.getuid()}`));
const original = { read: temporaryStorage.read, write: temporaryStorage.write, housekeep: temporaryStorage.housekeep };
let factReads = 0;
temporaryStorage.read = async (...args) => { if (args[1] === "facts") factReads++; return storage.read(...args); };
temporaryStorage.write = (...args) => storage.write(...args);
temporaryStorage.housekeep = (...args) => storage.housekeep(...args);
try {
  const roots: string[] = [];
  for (let r = 0; r < 4; r++) {
    const root = join(parent, `root-${r}`); roots.push(root); await mkdir(root);
    const git = (args: string[]) => run("git", args, root);
    await git(["init", "-b", "main"]);
    await git(["config", "user.name", "Contour benchmark"]);
    await git(["config", "user.email", "benchmark@example.invalid"]);
    await git(["config", "core.hooksPath", ".git/hooks"]);
    await git(["config", "commit.gpgSign", "false"]);
    for (let f = 0; f < 60; f++) {
      const text = Array.from({ length: 12 }, (_, i) => `export function f${r}_${f}_${i}(x:number) { if (x < ${i + f}) return x + ${r}; return x * ${f + i + 1}; }`).join("\n");
      await writeFile(join(root, `f${f}.ts`), text);
    }
    await git(["add", "."]); await git(["commit", "-m", "test(benchmark): initialize corpus"]);
  }
  const engine = new ContourEngine();
  const reports = [];
  for (const root of roots) reports.push(await engine.review(root, "working-tree"));
  const initial = { factReads, diskHits: engine.metrics.stats.diskHits, parses: engine.metrics.stats.parses, models: engine.stats.models, reviews: engine.stats.reviews };
  const wall = performance.now(), cpu = process.cpuUsage();
  for (let round = 0; round < 3; round++) for (let i = 0; i < roots.length; i++) {
    assert.deepEqual(await engine.review(roots[i]!, "working-tree"), reports[i]);
  }
  const used = process.cpuUsage(cpu);
  assert.equal(engine.metrics.stats.parses, initial.parses);
  assert.equal(engine.stats.models, initial.models);
  assert.equal(engine.stats.reviews, initial.reviews);
  console.log(JSON.stringify({ roots: roots.length, filesPerRoot: 60, functionsPerRoot: 720, warmReviews: 12,
    wallMs: Math.round(performance.now() - wall), cpuMs: Math.round((used.user + used.system) / 1000),
    factReads: factReads - initial.factReads, diskHits: engine.metrics.stats.diskHits - initial.diskHits,
    parses: engine.metrics.stats.parses - initial.parses, models: engine.stats.models - initial.models,
    reportHits: engine.stats.reportHits }, null, 2));
} finally {
  Object.assign(temporaryStorage, original);
  await rm(parent, { recursive: true, force: true });
}
