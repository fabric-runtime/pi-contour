import { expect, it, vi } from "vitest";
import { join } from "node:path";
import { VERSION, createAgentSession, createCodemodeExtension, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { complex, repo } from "./helpers.js";

it.each(["../src/index.ts", "../dist/index.mjs"])("Pi 1.0 loads Contour %s and executes nested review behind codemode-only", async (entrypoint) => {
  expect(VERSION).toBe("1.0.0");
  const root = await repo({ "entry.ts": complex("migrationProbe") }, false);
  const previous = process.env.CONTOUR_BACKGROUND;
  process.env.CONTOUR_BACKGROUND = "0";
  // Restore a deterministic parent call through the authoritative session store.
  // No provider, credentials, or network is involved.
  const sessionManager = SessionManager.inMemory(root);
  sessionManager.appendMessage({ role: "assistant", api: "offline", provider: "offline", model: "fixture",
    content: [{ type: "toolCall", id: "offline-parent", name: "codemode", arguments: {} }],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "toolUse", timestamp: 0 });
  const settingsManager = SettingsManager.inMemory({ defaultTools: ["+codemode"] });
  const loader = new DefaultResourceLoader({ cwd: root, agentDir: join(root, "agent"), settingsManager,
    additionalExtensionPaths: [new URL(entrypoint, import.meta.url).pathname],
    extensionFactories: [createCodemodeExtension({ mode: "only" })],
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    await loader.reload();
    expect(loader.getExtensions().errors).toEqual([]);
    ({ session } = await createAgentSession({ cwd: root, agentDir: join(root, "agent"), settingsManager, resourceLoader: loader, sessionManager }));
    const errors = vi.fn();
    session.extensionRunner.onError(errors);
    await session.bindExtensions({});
    expect(session.getCallableToolNames()).toContain("contour_review");
    const projected = await session.agent.transformContext!([{ role: "system", content: "probe", toolsAdded: session.agent.state.tools.map(({ name, description, parameters }) => ({ name, description, parameters })), timestamp: 0 }]);
    expect(projected.flatMap(message => message.role === "system" ? message.toolsAdded?.map(tool => tool.name) ?? [] : [])).toEqual(["codemode"]);
    const outcome = await session.extensionRunner.createToolContext("offline-parent", undefined).executeTool("contour_review", { root, target: "staged", maxTokens: 512 });
    expect(outcome.isError, JSON.stringify(outcome.result)).toBe(false);
    expect(outcome.result.details).toMatchObject({ target: "staged", after: { decisions: 12 } });
    expect(session.sessionManager.getBranch().some(entry => entry.type === "custom" && entry.customType === "pi-contour-workspace")).toBe(true);
    session.setActiveToolsByName(session.getActiveToolNames().filter(name => name !== "codemode"));
    const direct = await session.agent.transformContext!([{ role: "system", content: "probe", toolsAdded: session.agent.state.tools.map(({ name, description, parameters }) => ({ name, description, parameters })), timestamp: 0 }]);
    expect(direct.flatMap(message => message.role === "system" ? message.toolsAdded?.map(tool => tool.name) ?? [] : [])).toContain("contour_review");
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    // The finally block repeats shutdown after actual analysis.
    expect(errors).not.toHaveBeenCalled();
  } finally {
    if (session) { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); }
    if (previous === undefined) delete process.env.CONTOUR_BACKGROUND; else process.env.CONTOUR_BACKGROUND = previous;
  }
}, 30_000);
