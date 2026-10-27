import { lstat, open, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { budget as admitBudget } from "../verified/budget.js";
import { digest, Lru, mapLimit, run } from "./util.js";
import type { Comparison, Omission, Snapshot, SourceFile, Target } from "./types.js";

interface Entry { file: string; oid: string; mode: string }
interface WorkEntry { stamp: string; source: SourceFile }
interface Blob { text: string; hash: string; bytes: number }
export interface SnapshotLimits { maxFiles: number; maxFileBytes: number; maxTotalBytes: number }
const DEFAULT_LIMITS: SnapshotLimits = { maxFiles: 2000, maxFileBytes: 512 * 1024, maxTotalBytes: 32 * 1024 * 1024 };
const SUPPORTED = /\.(?:[cm]?[jt]s|[jt]sx)$/i;
const CODE = /\.(?:py|go|rs|java|kt|rb|c|cc|cpp|h|cs|swift|ex|exs|vue|svelte|php)$/i;
const EXCLUDED = /(?:^|\/)(?:node_modules|vendor|dist|build|coverage|\.git|\.pi|\.next)\//;
const safePath = (file: string): boolean => !!file && !file.startsWith("/") && !file.includes("\\") && !file.split("/").some(p => !p || p === "." || p === "..");
const stampOf = (s: Awaited<ReturnType<typeof lstat>>): string => `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}:${s.mode}`;

/** Reads pinned Git blobs in batches; never checks out, stages, or executes repository code. */
export class SnapshotReader {
  private blobs = new Lru<Blob>(8000, 64 * 1024 * 1024);
  private baseTrees = new Lru<Entry[]>(4);
  private work = new Lru<WorkEntry>(4000, 64 * 1024 * 1024);
  private trees = new Lru<Snapshot>(4, 64 * 1024 * 1024);
  readonly stats = { blobReads: 0, workReads: 0, statHits: 0 };
  constructor(readonly limits: SnapshotLimits = DEFAULT_LIMITS) {
    for (const value of Object.values(limits)) if (!Number.isSafeInteger(value) || value < 1 || value > 2 ** 40) throw new Error("Invalid snapshot limits");
  }
  private async git(root: string, args: string[], signal?: AbortSignal, input?: string, maxBytes?: number): Promise<Buffer> {
    return (await run("git", args, root, { signal, input, maxBytes })).stdout;
  }
  private async head(root: string, signal?: AbortSignal): Promise<string> {
    const result = await run("git", ["rev-parse", "--verify", "--quiet", "HEAD"], root, { signal, allowFailure: true });
    if (result.code === 0) return result.stdout.toString().trim();
    if (result.code !== 1) throw new Error(result.stderr || "Cannot resolve HEAD");
    // Only an unborn symbolic HEAD is an empty baseline; detached/broken states are errors.
    await this.git(root, ["symbolic-ref", "--quiet", "HEAD"], signal);
    return "unborn";
  }
  private parse(raw: Buffer, index: boolean): Entry[] {
    return raw.toString("utf8").split("\0").filter(Boolean).map(record => {
      const tab = record.indexOf("\t");
      const fields = record.slice(0, tab).split(/ +/);
      const file = record.slice(tab + 1);
      if (tab < 0 || !safePath(file) || file.includes("\ufffd")) throw new Error("Unsupported Git path encoding or unsafe path");
      if (index && fields[2] !== "0") throw new Error(`Unmerged index entry: ${file}`);
      return { file, mode: fields[0]!, oid: fields[index ? 1 : 2]! };
    }).sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0);
  }
  private select(entries: Entry[], worktree = false): { selected: Entry[]; omissions: Omission[] } {
    const selected: Entry[] = [], omissions: Omission[] = [];
    for (const entry of entries) {
      if (EXCLUDED.test(entry.file)) { omissions.push({ file: entry.file, reason: "excluded generated/dependency directory" }); continue; }
      if (!worktree && entry.mode !== "100644" && entry.mode !== "100755") { omissions.push({ file: entry.file, reason: "symlink, submodule, or non-regular entry" }); continue; }
      if (!SUPPORTED.test(entry.file)) { if (CODE.test(entry.file)) omissions.push({ file: entry.file, reason: "unsupported language (v0.1 metrics cover JS/TS)" }); continue; }
      if (!admitBudget({ used: selected.length, amount: 1, limit: this.limits.maxFiles }).admit) omissions.push({ file: entry.file, reason: "file count cap" });
      else selected.push(entry);
    }
    return { selected, omissions };
  }
  private async blobSnapshot(root: string, entries: Entry[], revision: string, signal?: AbortSignal): Promise<Snapshot> {
    const key = digest(JSON.stringify({ entries, limits: this.limits }));
    const cached = this.trees.get(key);
    if (cached) return { ...cached, revision };
    const { selected, omissions } = this.select(entries);
    const needed = [...new Set(selected.map(e => e.oid).filter(oid => this.blobs.get(oid) === undefined))];
    const sizes = new Map<string, number>();
    if (needed.length) {
      const check = await this.git(root, ["cat-file", "--batch-check"], signal, needed.join("\n") + "\n");
      for (const line of check.toString().trim().split("\n")) {
        const [oid, type, size] = line.split(" ");
        if (type !== "blob" || !Number.isSafeInteger(Number(size))) throw new Error(`Unavailable Git blob: ${oid}`);
        sizes.set(oid!, Number(size));
      }
    }
    let bytes = 0;
    const accepted = selected.filter(entry => {
      const size = this.blobs.get(entry.oid)?.bytes ?? sizes.get(entry.oid)!;
      const step = admitBudget({ used: bytes, amount: size, limit: this.limits.maxTotalBytes });
      if (!admitBudget({ used: 0, amount: size, limit: this.limits.maxFileBytes }).admit || !step.admit) {
        omissions.push({ file: entry.file, reason: size > this.limits.maxFileBytes ? "file byte cap" : "snapshot byte cap" }); return false;
      }
      bytes = step.used; return true;
    });
    const missing = [...new Set(accepted.map(e => e.oid).filter(oid => this.blobs.get(oid) === undefined))];
    // Retain this invocation's accepted blobs even if the bounded LRU evicts others.
    const loaded = new Map<string, Blob>();
    for (const entry of accepted) { const cached = this.blobs.get(entry.oid); if (cached) loaded.set(entry.oid, cached); }
    for (let i = 0; i < missing.length; i += 32) {
      signal?.throwIfAborted();
      const data = await this.git(root, ["cat-file", "--batch"], signal, missing.slice(i, i + 32).join("\n") + "\n", this.limits.maxTotalBytes + 65536);
      let offset = 0;
      while (offset < data.length) {
        const end = data.indexOf(10, offset);
        const [oid, type, rawSize] = data.subarray(offset, end).toString().split(" ");
        const size = Number(rawSize);
        if (end < 0 || type !== "blob" || !Number.isSafeInteger(size) || size < 0 || end + 1 + size >= data.length) throw new Error("Invalid cat-file batch response");
        const text = data.subarray(end + 1, end + 1 + size).toString("utf8");
        const blob = { text, hash: digest(text), bytes: Buffer.byteLength(text) };
        this.blobs.set(oid!, blob, blob.bytes); loaded.set(oid!, blob); this.stats.blobReads++;
        offset = end + size + 2;
      }
    }
    const files = new Map<string, SourceFile>();
    for (const entry of accepted) {
      const blob = loaded.get(entry.oid)!;
      if (blob.text.includes("\0") || blob.text.includes("\ufffd")) omissions.push({ file: entry.file, reason: "binary or non-UTF8 source" });
      else files.set(entry.file, { file: entry.file, hash: blob.hash, text: blob.text });
    }
    const snapshot = this.finish(files, omissions, entries, revision);
    this.trees.set(key, snapshot, bytes);
    return snapshot;
  }
  private finish(files: Map<string, SourceFile>, omissions: Omission[], entries: Entry[], revision: string): Snapshot {
    omissions.sort((a, b) => a.file.localeCompare(b.file));
    const id = digest(JSON.stringify({ entries, contents: [...files].map(([f, s]) => [f, s.hash]), omissions, limits: this.limits }));
    return { id, files, omissions, revision, listed: entries.length };
  }
  private async workSnapshot(root: string, entries: Entry[], signal?: AbortSignal): Promise<Snapshot> {
    const { selected, omissions } = this.select(entries, true);
    const observed = new Map<string, string | undefined>();
    let budget = 0;
    const accepted: Array<{ entry: Entry; stamp: string; size: number }> = [];
    const ancestors = new Map<string, Promise<boolean>>();
    const ancestorIsSymlink = (path: string): Promise<boolean> => {
      let pending = ancestors.get(path);
      if (!pending) { pending = lstat(path).then(stat => stat.isSymbolicLink()); ancestors.set(path, pending); }
      return pending;
    };
    const stats = await mapLimit(selected, 24, async entry => {
      signal?.throwIfAborted();
      try {
        // Refuse symlink ancestors too; a tracked directory can be replaced in the worktree.
        const parts = entry.file.split("/");
        for (let i = 1; i < parts.length; i++) if (await ancestorIsSymlink(join(root, ...parts.slice(0, i)))) throw new Error("symlink ancestor");
        const stat = await lstat(join(root, entry.file));
        observed.set(entry.file, stampOf(stat));
        return { entry, stat };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") observed.set(entry.file, undefined);
        else omissions.push({ file: entry.file, reason: `unreadable: ${String(error)}` });
        return undefined;
      }
    });
    for (const item of stats) {
      if (!item) continue;
      if (!item.stat.isFile()) { omissions.push({ file: item.entry.file, reason: "non-regular working-tree source" }); continue; }
      const step = admitBudget({ used: budget, amount: item.stat.size, limit: this.limits.maxTotalBytes });
      if (!admitBudget({ used: 0, amount: item.stat.size, limit: this.limits.maxFileBytes }).admit || !step.admit) {
        omissions.push({ file: item.entry.file, reason: item.stat.size > this.limits.maxFileBytes ? "file byte cap" : "snapshot byte cap" }); continue;
      }
      budget = step.used; accepted.push({ entry: item.entry, stamp: stampOf(item.stat), size: item.stat.size });
    }
    const values = await mapLimit(accepted, 24, async ({ entry, stamp }) => {
      signal?.throwIfAborted();
      const key = `${root}\0${entry.file}`, cached = this.work.get(key);
      if (cached?.stamp === stamp) { this.stats.statHits++; return cached.source; }
      const handle = await open(join(root, entry.file), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stampOf(stat) !== stamp) throw new Error("Working tree changed during capture; retry review");
        const buffer = Buffer.alloc(Math.min(stat.size + 1, this.limits.maxFileBytes + 1));
        let length = 0;
        while (length < buffer.length) { const read = await handle.read(buffer, length, buffer.length - length, null); if (!read.bytesRead) break; length += read.bytesRead; }
        if (length > stat.size || stampOf(await handle.stat()) !== stamp) throw new Error("Working tree changed during capture; retry review");
        const text = buffer.subarray(0, length).toString("utf8");
        const source = { file: entry.file, hash: digest(text), text };
        this.work.set(key, { stamp, source }, Buffer.byteLength(text)); this.stats.workReads++;
        return source;
      } finally { await handle.close(); }
    });
    // A second metadata sweep rejects mixtures assembled while files were being edited.
    await mapLimit([...observed], 24, async ([file, stamp]) => {
      signal?.throwIfAborted();
      try {
        if (stampOf(await lstat(join(root, file))) !== stamp) throw new Error("Working tree changed during capture; retry review");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT" && stamp === undefined) return;
        throw error;
      }
    });
    const files = new Map<string, SourceFile>();
    for (const source of values) {
      if (source.text.includes("\0") || source.text.includes("\ufffd")) omissions.push({ file: source.file, reason: "binary or non-UTF8 source" });
      else files.set(source.file, source);
    }
    return this.finish(files, omissions, entries, "working-tree");
  }
  async capture(cwd: string, target: Target = "staged", signal?: AbortSignal): Promise<Comparison> {
    if (target !== "staged" && target !== "working-tree") throw new Error("Target must be staged or working-tree");
    const root = await realpath((await this.git(cwd, ["rev-parse", "--show-toplevel"], signal)).toString().replace(/\n$/, ""));
    const head = await this.head(root, signal);
    const index = await this.git(root, ["ls-files", "--stage", "-z"], signal);
    const entries = this.parse(index, true);
    const baseKey = `${root}\0${head}`;
    let baseEntries = this.baseTrees.get(baseKey);
    if (!baseEntries) {
      baseEntries = head === "unborn" ? [] : this.parse(await this.git(root, ["ls-tree", "-r", "-z", "--full-tree", head], signal), false);
      this.baseTrees.set(baseKey, baseEntries);
    }
    const untracked = target === "working-tree" ? await this.git(root, ["ls-files", "--others", "--exclude-standard", "-z"], signal) : Buffer.alloc(0);
    const workEntries = [...entries];
    for (const file of untracked.toString().split("\0").filter(Boolean)) {
      if (!safePath(file)) throw new Error("Unsafe untracked path");
      workEntries.push({ file, oid: "untracked", mode: "100644" });
    }
    workEntries.sort((a, b) => a.file.localeCompare(b.file));
    const before = await this.blobSnapshot(root, baseEntries, head, signal);
    const after = target === "staged" ? await this.blobSnapshot(root, entries, digest(index), signal) : await this.workSnapshot(root, workEntries, signal);
    if (head !== await this.head(root, signal) || !index.equals(await this.git(root, ["ls-files", "--stage", "-z"], signal))
      || (target === "working-tree" && !untracked.equals(await this.git(root, ["ls-files", "--others", "--exclude-standard", "-z"], signal)))) {
      throw new Error("Repository changed during capture; retry review");
    }
    const changed = [...new Set([...before.files.keys(), ...after.files.keys()])].filter(file => before.files.get(file)?.hash !== after.files.get(file)?.hash).sort();
    return { root, target, before, after, changed };
  }
}
