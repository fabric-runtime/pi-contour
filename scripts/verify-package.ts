import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader, SettingsManager, SessionManager, type AgentToolResult, type ExtensionContext } from "@earendil-works/pi-coding-agent";

const exec = promisify(execFile);
const project = fileURLToPath(new URL("../", import.meta.url));
const root = await mkdtemp(join(tmpdir(), "contour-package-"));
const run = (file: string, args: string[], cwd: string) => exec(file, args, { cwd, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
const manifest = JSON.parse(await readFile(join(project, "package.json"), "utf8"));
assert.match(manifest.devDependencies["pi-fovea"], /^\d+\.\d+\.\d+$/);
assert.equal(manifest.dependencies, undefined);
assert.equal(manifest.peerDependencies?.["@earendil-works/pi-coding-agent"], undefined);
assert.deepEqual(manifest.pi.extensions, ["./dist/index.mjs"]);
assert.equal(manifest.bin.contour, "dist/cli.mjs");
assert.equal(manifest.scripts.prepare, undefined); assert.equal(manifest.scripts.postinstall, undefined);
const previous = process.env.CONTOUR_BACKGROUND;
process.env.CONTOUR_BACKGROUND = "0";
try {
  const packed = JSON.parse((await run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", root], project)).stdout)[0];
  const archive = join(root, packed.filename);
  for (const path of ["dist/index.mjs", "dist/cli.mjs", "dist/THIRD_PARTY_LICENSES.txt", "dist/startup.json", "media/cover.svg", "skills/pi-contour/SKILL.md"]) {
    assert.ok(packed.files.some((file: { path: string }) => file.path === path), `Missing ${path}`);
  }
  const repository = join(root, "repository"); await mkdir(repository);
  await run("git", ["init", "-b", "main"], repository);
  await writeFile(join(repository, "a.ts"), "export function parse(n:number) {\n" + Array.from({ length: 12 }, (_, i) => `if (n === ${i}) return ${i + 1};`).join("\n") + "\nreturn 0;\n}\n");
  await run("git", ["add", "."], repository);
  const observations: unknown[] = [];
  for (const mode of ["npm", "git-layout"] as const) {
    const directory = join(root, mode); await mkdir(directory);
    let installed: string;
    if (mode === "npm") {
      await writeFile(join(directory, "package.json"), JSON.stringify({ private: true }));
      await run("npm", ["install", archive, "--omit=dev", "--omit=optional", "--ignore-scripts", "--no-audit", "--no-fund"], directory);
      installed = join(directory, "node_modules/pi-contour");
    } else {
      // The complete production-relevant Git layout, outside the sibling checkout.
      for (const name of ["package.json", "bun.lock", "dist", "skills", "media", "README.md", "LICENSE"]) {
        await cp(join(project, name), join(directory, name), { recursive: true });
      }
      // Pi uses a production npm install for Git sources; also verify Bun's frozen lock.
      await run("npm", ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], directory);
      await run("bun", ["install", "--production", "--ignore-scripts", "--frozen-lockfile"], directory);
      installed = directory;
    }
    for (const name of ["pi-fovea", "typescript", "tsx", "@earendil-works/pi-coding-agent"]) {
      await assert.rejects(access(join(directory, "node_modules", name)), `Unexpected ${mode} runtime install: ${name}`);
    }
    const cli = JSON.parse((await run(process.execPath, [join(installed, "dist/cli.mjs"), "review", "--root", repository, "--json"], directory)).stdout);
    assert.equal(cli.after.decisions, 12); assert.equal(cli.target, "staged");
    const reported = (await run(process.execPath, [join(installed, "dist/cli.mjs"), "--version"], directory)).stdout.trim();
    assert.equal(reported, `contour ${manifest.version}`);
    const loader = new DefaultResourceLoader({
      cwd: directory, agentDir: join(root, `agent-${mode}`), settingsManager: SettingsManager.inMemory(),
      additionalExtensionPaths: [installed], noExtensions: true, noSkills: true,
      noPromptTemplates: true, noThemes: true, noContextFiles: true,
    });
    const loadStart = performance.now(); await loader.reload(); const loadMs = performance.now() - loadStart;
    const loaded = loader.getExtensions(); assert.deepEqual(loaded.errors, []); assert.equal(loaded.extensions.length, 1);
    const extension = loaded.extensions[0]!;
    assert.deepEqual([...extension.tools.keys()], ["contour_review"]);
    assert.deepEqual([...extension.commands.keys()], ["contour"]);
    const session = SessionManager.inMemory(directory);
    loaded.runtime.appendEntry = (customType, data) => { session.appendCustomEntry(customType, data); };
    loaded.runtime.sendMessage = () => { throw new Error("Discovery must not send messages"); };
    const context = { cwd: directory, hasUI: false, sessionManager: session as ExtensionContext["sessionManager"] } as ExtensionContext;
    const start = performance.now();
    for (const handler of extension.handlers.get("session_start") ?? []) await handler({ type: "session_start" }, context);
    const sessionStartMs = performance.now() - start;
    try {
      await assert.rejects(extension.tools.get("contour_review")!.definition.execute("unselected", {}, undefined, undefined, context), /Git worktree/);
      assert.equal(session.getBranch().length, 0);
      for (const handler of extension.handlers.get("tool_result") ?? []) await handler({
        type: "tool_result", toolName: "read", toolCallId: "access", input: { path: join(repository, "a.ts") },
        content: [], details: undefined, isError: false,
      }, context);
      assert.ok(session.getBranch().some(entry => entry.type === "custom" && entry.customType === "pi-contour-workspace"));
      // Access enrolls the project, but the installation cwd has its own
      // manifest: an unrooted review must not silently switch to the ring.
      await assert.rejects(extension.tools.get("contour_review")!.definition.execute("enrolled-default", { target: "staged" }, undefined, undefined, context), /Git worktree/);
      const result = await extension.tools.get("contour_review")!.definition.execute("package-probe", { root: repository, target: "staged" }, undefined, undefined, context);
      assert.ok(result.content.some((content: AgentToolResult["content"][number]) => content.type === "text" && content.text.includes("complexity")));
      assert.equal((result.details as { root: string }).root, await realpath(repository));
    } finally {
      for (const handler of extension.handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown" }, context);
    }
    observations.push({ mode, reportedVersion: reported, cli: true, piLoader: true, lazyToolReview: true, disjointEnrollment: true, cwdDefaultPreserved: true, sessionPersistence: true, loaderMs: +loadMs.toFixed(2), sessionStartMs: +sessionStartMs.toFixed(3) });
  }
  console.log(JSON.stringify({ standalone: true, archiveFiles: packed.files.length, installed: observations }));
} finally {
  if (previous === undefined) delete process.env.CONTOUR_BACKGROUND; else process.env.CONTOUR_BACKGROUND = previous;
  await rm(root, { recursive: true, force: true });
}
