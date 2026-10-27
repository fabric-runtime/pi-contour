import { constants, type Stats } from "node:fs";
import * as fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { digest } from "./util.js";
import { retention } from "../verified/retention.js";
import { prune } from "../verified/prune.js";

const DAY = 24 * 60 * 60 * 1000;
export const STORAGE_LIMITS = { bytes: 128 * 1024 * 1024, files: 128, ageMs: 7 * DAY, tempGraceMs: DAY, intervalMs: 60_000 };
const FACT_BYTES = 64 * 1024 * 1024, CHECKPOINT_BYTES = 1024;
const BASE = "(?:facts-[a-f0-9]{64}\\.json|checkpoint-[a-f0-9]{64}\\.txt)";
const UUID = "[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}";
const finalName = new RegExp(`^${BASE}$`);
const tempName = new RegExp(`^${BASE}\\.(?:([1-9][0-9]{0,9})\\.)?${UUID}\\.tmp$`);
const same = (a: Stats, b: Stats): boolean => a.dev === b.dev && a.ino === b.ino && a.uid === b.uid
  && a.mode === b.mode && a.nlink === b.nlink && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === "ENOENT";

export interface StoragePruneResult {
  dryRun: boolean;
  filesBefore: number;
  bytesBefore: number;
  filesAfter: number;
  bytesAfter: number;
  removedFiles: number;
  removedBytes: number;
  candidates: string[];
  skipped: number;
  failed: number;
  error?: string;
}

/** Disposable facts and advisory suppression only. No I/O or timers until actual use. */
export class TemporaryStorage {
  private sweep?: Promise<void>;
  private lastSweep = -Infinity;
  private protectedNames = new Set<string>();
  private dirty = false;
  constructor(private directory = join(tmpdir(), `pi-contour-${process.getuid?.() ?? "user"}`),
    private limits = STORAGE_LIMITS) {}

  name(root: string, kind: "facts" | "checkpoint"): string {
    return `${kind}-${digest(root)}.${kind === "facts" ? "json" : "txt"}`;
  }
  private owned(stat: Stats): boolean { return typeof process.getuid === "function" && stat.uid === process.getuid(); }
  private file(stat: Stats): boolean { return this.owned(stat) && stat.isFile() && stat.nlink === 1 && (stat.mode & 0o077) === 0; }
  private async dir(create = false): Promise<Stats> {
    if (basename(this.directory) !== `pi-contour-${process.getuid?.() ?? "user"}`) throw new Error("Unsafe cache directory name");
    if (create) { try { await fs.mkdir(this.directory, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; } }
    const stat = await fs.lstat(this.directory);
    if (!this.owned(stat) || !stat.isDirectory() || (stat.mode & 0o077) !== 0) throw new Error("Unsafe cache directory");
    return stat;
  }
  private async directoryUnchanged(original: Stats): Promise<boolean> {
    const current = await this.dir();
    return original.dev === current.dev && original.ino === current.ino;
  }
  private async inspect(name: string): Promise<Stats | undefined> {
    try { return await fs.lstat(join(this.directory, name)); } catch (error) { if (!missing(error)) throw error; }
  }
  private async remove(name: string, original: Stats, directory: Stats, protectedNames?: ReadonlySet<string>): Promise<boolean> {
    if (!await this.directoryUnchanged(directory)) return false;
    const current = await this.inspect(name);
    if (!current || !this.file(current) || !same(original, current) || protectedNames?.has(name)) return false;
    await fs.unlink(join(this.directory, name));
    return true;
  }
  private cap(name: string): number { return name.startsWith("facts-") ? FACT_BYTES : CHECKPOINT_BYTES; }

  async read(root: string, kind: "facts" | "checkpoint"): Promise<string | undefined> {
    const name = this.name(root, kind);
    try {
      const directory = await this.dir(), before = await this.inspect(name);
      if (!before || !this.file(before) || before.size > this.cap(name)) return;
      const handle = await fs.open(join(this.directory, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = await handle.stat();
        if (!this.file(stat) || !same(before, stat) || !await this.directoryUnchanged(directory)) return;
        // Read at most the observed size plus one byte, even if another process grows the file.
        const bytes = Buffer.alloc(stat.size + 1);
        let length = 0;
        while (length < bytes.length) {
          const read = await handle.read(bytes, length, bytes.length - length, length);
          if (!read.bytesRead) break;
          length += read.bytesRead;
        }
        if (length !== stat.size || !same(stat, await handle.stat())) return;
        // Successful use renews retention without following a replaced path.
        const now = new Date(); await handle.utimes(now, now).catch(() => {});
        return bytes.subarray(0, length).toString("utf8");
      } finally { await handle.close(); }
    } catch { /* Optional local storage must never invalidate evidence. */ }
    finally { await this.housekeep(root); }
  }

  async write(root: string, kind: "facts" | "checkpoint", data: string): Promise<boolean> {
    const name = this.name(root, kind);
    let directory: Stats | undefined, temp: string | undefined, owned: Stats | undefined;
    let written = false;
    try {
      if (Buffer.byteLength(data) > this.cap(name)) return false;
      directory = await this.dir(true);
      const before = await this.inspect(name);
      if (before && !this.file(before)) return false;
      temp = `${name}.${process.pid}.${randomUUID()}.tmp`;
      const handle = await fs.open(join(this.directory, temp), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile(data, "utf8"); }
      finally { try { owned = await handle.stat(); } finally { await handle.close(); } }
      if (!await this.directoryUnchanged(directory)) return false;
      const current = await this.inspect(name), staged = await this.inspect(temp);
      if (!staged || !this.file(staged) || !same(owned!, staged)
        || (before ? !current || !same(before, current) : !!current)) return false;
      await fs.rename(join(this.directory, temp), join(this.directory, name));
      written = true;
      return true;
    } catch { return false; }
    finally {
      // Only our exclusive inode, never a replacement or an arbitrary .tmp file.
      if (temp && owned && directory) await this.remove(temp, owned, directory).catch(() => false);
      await this.housekeep(root, written);
    }
  }

  /** Coalesce concurrent use; throttle read-only passes, but enforce pressure after writes. */
  housekeep(root: string, changed = false): Promise<void> {
    if (!this.sweep && !changed && Date.now() - this.lastSweep < this.limits.intervalMs) return Promise.resolve();
    this.protectedNames.add(this.name(root, "facts")); this.protectedNames.add(this.name(root, "checkpoint"));
    if (this.sweep) { this.dirty ||= changed; return this.sweep; }
    this.sweep = (async () => {
      do {
        this.dirty = false;
        await this.collect().catch(() => {});
      } while (this.dirty);
    })().finally(() => { this.lastSweep = Date.now(); this.protectedNames.clear(); this.sweep = undefined; });
    return this.sweep;
  }

  /** Explicit maintenance/preview; runtime callers use the coalesced housekeep path. */
  async prune(dryRun = true, keepRoot?: string): Promise<StoragePruneResult> {
    const protectedNames = new Set<string>();
    if (keepRoot) {
      protectedNames.add(this.name(keepRoot, "facts")); protectedNames.add(this.name(keepRoot, "checkpoint"));
    }
    return this.collect(dryRun, protectedNames);
  }

  private async collect(dryRun = false, protectedNames: ReadonlySet<string> = this.protectedNames): Promise<StoragePruneResult> {
    const result: StoragePruneResult = { dryRun, filesBefore: 0, bytesBefore: 0, filesAfter: 0, bytesAfter: 0,
      removedFiles: 0, removedBytes: 0, candidates: [], skipped: 0, failed: 0 };
    try {
      const directory = await this.dir(), now = Date.now();
      const entries: Array<{ name: string; stat: Stats; removable: boolean }> = [];
      for (const name of await fs.readdir(this.directory)) {
        const temporary = tempName.exec(name);
        if (!finalName.test(name) && !temporary) { result.skipped++; continue; }
        try {
          const stat = await this.inspect(name);
          if (!stat || !this.file(stat)) { result.skipped++; continue; }
          let removable = !temporary;
          if (temporary) {
            const age = now - Math.max(stat.mtimeMs, stat.ctimeMs);
            // Legacy UUID-only temps have no writer identity: allow a full retention window.
            removable = age > (temporary[1] ? this.limits.tempGraceMs : this.limits.ageMs);
            if (removable && temporary[1]) {
              try { process.kill(Number(temporary[1]), 0); removable = false; }
              catch (error) { removable = (error as NodeJS.ErrnoException).code === "ESRCH"; }
            }
          }
          entries.push({ name, stat, removable });
        } catch { result.failed++; /* A concurrent writer or unreadable entry is not ours to remove. */ }
      }
      let bytes = entries.reduce((sum, entry) => sum + entry.stat.size, 0), count = entries.length;
      result.bytesBefore = bytes; result.filesBefore = count;
      entries.sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs || a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (!prune({ protected: protectedNames.has(entry.name), removable: entry.removable,
          pressure: retention({ count, bytes, maxCount: this.limits.files, maxBytes: this.limits.bytes }).evict,
          expired: !!tempName.test(entry.name) || now - entry.stat.mtimeMs > this.limits.ageMs, oversized: entry.stat.size > this.cap(entry.name) }).remove) continue;
        result.candidates.push(entry.name);
        try {
          if (dryRun || await this.remove(entry.name, entry.stat, directory, protectedNames)) {
            bytes -= entry.stat.size; count--;
            if (!dryRun) { result.removedFiles++; result.removedBytes += entry.stat.size; }
          } else result.skipped++;
        } catch { result.failed++; /* Failed cleanup does not stop other candidates or reviews. */ }
      }
      result.filesAfter = count; result.bytesAfter = bytes;
    } catch (error) { result.failed++; result.error = String(error); }
    return result;
  }
}

/** Explicit directory, current UID only. Preview by default; after-counts are projected in dry runs. */
export function pruneTemporaryStorage(directory: string, options: { dryRun?: boolean; keepRoot?: string } = {}): Promise<StoragePruneResult> {
  return new TemporaryStorage(directory).prune(options.dryRun ?? true, options.keepRoot);
}

export const temporaryStorage = new TemporaryStorage();
