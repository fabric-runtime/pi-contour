import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { budget } from "../verified/budget.js";
import { retention } from "../verified/retention.js";
import { workers } from "../verified/workers.js";

export const digest = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
export const yieldLoop = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 2 ** 40) throw new RangeError("Invalid worker limit");
  let next = 0;
  const out = new Array<R>(items.length);
  await Promise.all(Array.from({ length: workers({ requested: limit, size: items.length }).count }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]!); }
  }));
  return out;
}

/** Byte- and entry-bounded LRU; failed/aborted work is never cached by callers. */
export class Lru<T> {
  private entries = new Map<string, { value: T; bytes: number }>();
  private bytes = 0;
  constructor(private maxEntries: number, private maxBytes = 2 ** 40) {
    if (maxBytes === Infinity) this.maxBytes = 2 ** 40;
    for (const value of [this.maxEntries, this.maxBytes]) if (!Number.isSafeInteger(value) || value < 0 || value > 2 ** 40) throw new RangeError("Invalid cache limit");
  }
  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key); this.entries.set(key, entry);
    return entry.value;
  }
  snapshot(): Array<[string, T]> { return [...this.entries].map(([key, entry]) => [key, entry.value]); }
  set(key: string, value: T, bytes = 1): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > 2 ** 40) throw new RangeError("Invalid cache entry size");
    const previous = this.entries.get(key);
    if (previous) { this.bytes -= previous.bytes; this.entries.delete(key); }
    if (bytes > this.maxBytes) return;
    this.entries.set(key, { value, bytes }); this.bytes += bytes;
    while (retention({ count: this.entries.size, bytes: this.bytes, maxCount: this.maxEntries, maxBytes: this.maxBytes }).evict) {
      const key = this.entries.keys().next().value!;
      this.bytes -= this.entries.get(key)!.bytes; this.entries.delete(key);
    }
  }
}

export function run(command: string, args: string[], cwd: string, options: { input?: string; signal?: AbortSignal; maxBytes?: number; allowFailure?: boolean } = {}): Promise<{ stdout: Buffer; code: number; stderr: string }> {
  options.signal?.throwIfAborted();
  const maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > 2 ** 40) throw new RangeError("Invalid output limit");
  return new Promise((resolve, reject) => {
    const git = command === "git";
    // Source observation must not invoke fsmonitor or fetch missing promisor objects.
    const child = spawn(command, git ? ["-c", "core.fsmonitor=false", ...args] : args, {
      cwd, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", ...(git ? { GIT_NO_LAZY_FETCH: "1", GIT_ALLOW_PROTOCOL: "", GIT_TERMINAL_PROMPT: "0" } : {}) },
      stdio: ["pipe", "pipe", "pipe"], signal: options.signal,
    });
    const chunks: Buffer[] = [];
    let bytes = 0, stderr = "", failure: Error | undefined;
    const timer = setTimeout(() => { failure = new Error(`${command} exceeded 45s deadline`); child.kill("SIGKILL"); }, 45_000);
    timer.unref();
    child.stdout.on("data", (chunk: Buffer) => {
      if (failure) return;
      const step = budget({ used: bytes, amount: chunk.length, limit: maxBytes });
      bytes = step.used;
      if (!step.admit) { failure = new Error(`${command} output limit exceeded`); child.kill("SIGKILL"); }
      else chunks.push(chunk);
    });
    child.stderr.on("data", chunk => { stderr = (stderr + String(chunk)).slice(-8192); });
    child.stdin.on("error", () => {});
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", code => {
      clearTimeout(timer);
      if (failure) return reject(failure);
      if (options.signal?.aborted) return reject(options.signal.reason);
      if (code !== 0 && !options.allowFailure) return reject(new Error(`${command} ${args[0] ?? ""}: ${stderr.trim() || `exit ${code}`}`));
      resolve({ stdout: Buffer.concat(chunks), code: code ?? 1, stderr });
    });
    child.stdin.end(options.input);
  });
}
