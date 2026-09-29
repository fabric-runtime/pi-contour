import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { readFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import contour from "../src/index.js";
import { main } from "../src/cli.js";
import { installHook, uninstallHook } from "../src/core/hook.js";
import { run } from "../src/core/util.js";
import { complex, git, put, repo } from "./helpers.js";

const output = () => { const values = { out: "", error: "" }; return { values, io: { out: (s: string) => { values.out += s; return true; }, error: (s: string) => { values.error += s; return true; } } }; };

describe("public interfaces", () => {
  it("registers exactly the review tool and contour command without factory-time background work", async () => {
    vi.useFakeTimers();
    const api = { on: vi.fn(), registerTool: vi.fn(), registerCommand: vi.fn(), sendMessage: vi.fn() };
    contour(api as unknown as ExtensionAPI);
    expect(api.registerTool.mock.calls.map(call => call[0].name)).toEqual(["contour_review"]);
    expect(api.registerCommand.mock.calls.map(call => call[0])).toEqual(["contour"]);
    expect(vi.getTimerCount()).toBe(0);
    const start = api.on.mock.calls.find(call => call[0] === "session_start")![1];
    const shutdown = api.on.mock.calls.find(call => call[0] === "session_shutdown")![1];
    await start({}, { cwd: "/not-an-enrolled-project" }); expect(vi.getTimerCount()).toBe(1);
    await shutdown({}); expect(vi.getTimerCount()).toBe(0); expect(api.sendMessage).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
  it("executes a read-only staged tool review and explicit command without triggering an agent turn", async () => {
    const root = await repo({ "a.ts": "export const a = 1;" }); await put(root, "a.ts", complex()); await git(root, ["add", "."]); await put(root, "a.ts", "// unstaged cleanup\n");
    const api = { on: vi.fn(), registerTool: vi.fn(), registerCommand: vi.fn(), sendMessage: vi.fn() };
    contour(api as unknown as ExtensionAPI);
    const tool = api.registerTool.mock.calls[0]![0] as ToolDefinition;
    const executeTool = vi.fn(async () => { throw new Error("Unexpected nested tool"); });
    const ctx = { cwd: root, hasUI: false, tools: [], executeTool } as unknown as ExtensionToolContext;
    const result = await tool.execute("call", { target: "staged", maxTokens: 512 }, undefined, undefined, ctx);
    expect(executeTool).not.toHaveBeenCalled();
    expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("Δ [complexity; advisory]") });
    const text = (result.content[0] as { text: string }).text;
    for (const marker of ["  ▪ a.ts:", "  ↗ Exposure (modeled):", "  ? "]) expect(text).toContain(marker);
    const command = api.registerCommand.mock.calls[0]![1]; await command.handler("review staged", ctx);
    expect(api.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ customType: "contour-review", display: true,
      content: expect.stringContaining("Δ [complexity; advisory]") }), { triggerTurn: false });
  });
  it("supports CLI text/JSON, default advisory behavior, explicit policy, and stable checkpoint suppression", async () => {
    const root = await repo({ "core/a.ts": "export const a = 1;", "ui/b.ts": "export const b = 2;" });
    await put(root, "core/a.ts", "import { b } from '../ui/b'; export const a = b;"); await git(root, ["add", "."]);
    const first = output(); expect(await main(["review", "--root", root, "--checkpoint"], first.io)).toBe(0); expect(first.values.out).toContain("Δ [coupling; advisory]"); expect(first.values.out).toContain("  ▪ core/a.ts:");
    const second = output(); expect(await main(["review", "--root", root, "--checkpoint"], second.io)).toBe(0); expect(second.values.out).toBe("");
    const explicit = output(); expect(await main(["review", "--root", root, "--json"], explicit.io)).toBe(0);
    expect(JSON.parse(explicit.values.out)).toMatchObject({ schemaVersion: 1, target: "staged", blockingFindings: 0 });
    await put(root, "policy.json", JSON.stringify({ boundaries: [{ from: "core", to: "ui", reason: "Core must not depend on UI." }] }));
    for (let i = 0; i < 2; i++) { const policy = output(); expect(await main(["review", "--root", root, "--policy", "policy.json", "--checkpoint", "--max-findings", "1"], policy.io)).toBe(2); expect(policy.values.out).toContain("Forbidden dependency"); }
    const invalid = output(); expect(await main(["review", "--root", root, "--max-tokens", "NaN"], invalid.io)).toBe(1); expect(invalid.values.error).toContain("maxTokens");
  });
  it("does not print automatic clean-result notifications; unknown CLI arguments fail", async () => {
    const root = await repo({ "a.ts": "const a = 1;" }), clean = output();
    expect(await main(["review", "--root", root, "--checkpoint"], clean.io)).toBe(0); expect(clean.values.out).toBe("");
    const bad = output(); expect(await main(["review", "--made-up"], bad.io)).toBe(1); expect(bad.values.error).toContain("Unknown");
  });
  it("reports the source-checkout version and lists the flag in usage", async () => {
    const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    const version = output(); expect(await main(["--version"], version.io)).toBe(0);
    expect(version.values.out).toBe(`contour ${manifest.version}\n`); expect(version.values.error).toBe("");
    const both = output(); expect(await main(["--version", "--help"], both.io)).toBe(0); expect(both.values.out).toContain("contour --version");
  });
  it("installs only on explicit request and never overwrites existing hooks or symlinks", async () => {
    const root = await repo(), cli = join(root, "fake ' cli.mjs"), hook = join(root, ".git/hooks/pre-commit");
    await put(root, "fake ' cli.mjs", "process.exitCode = 1;");
    await expect(installHook(root, join(root, "cli.ts"))).rejects.toThrow("Build first");
    await installHook(root, cli); const script = await readFile(hook, "utf8"); expect(script).toContain("--staged --checkpoint");
    await expect(installHook(root, cli)).rejects.toThrow("already exists"); expect(await readFile(hook, "utf8")).toBe(script);
    const advisory = await run("sh", [hook], root, { allowFailure: true }); expect(advisory.code).toBe(0); expect(advisory.stderr).toContain("analysis unavailable");
    await put(root, ".git/hooks/pre-commit", script + "# user change\n");
    await expect(uninstallHook(root)).rejects.toThrow("modified");
    await put(root, ".git/hooks/pre-commit", script);
    await uninstallHook(root);
    await installHook(root, cli, join(root, "policy.json")); expect((await run("sh", [hook], root, { allowFailure: true })).code).toBe(1);
    await uninstallHook(root); await symlink(cli, hook);
    await expect(installHook(root, cli)).rejects.toThrow("already exists"); await expect(uninstallHook(root)).rejects.toThrow("Refusing");
  });
  it("honors custom hooksPath without changing Git configuration", async () => {
    const root = await repo(), cli = join(root, "fake.mjs"); await put(root, "fake.mjs", "process.exitCode = 0;");
    await git(root, ["config", "core.hooksPath", ".githooks"]); await installHook(root, cli);
    expect(await readFile(join(root, ".githooks/pre-commit"), "utf8")).toContain("pi-contour managed");
    expect((await git(root, ["config", "core.hooksPath"])).trim()).toBe(".githooks"); await uninstallHook(root);
  });
});
