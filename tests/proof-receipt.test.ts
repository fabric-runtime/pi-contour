import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import {
  cp,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
const exec = promisify(execFile),
  require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../", import.meta.url));
const temps: string[] = [];
afterEach(async () => {
  await Promise.all(
    temps.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "contour-proof-"));
  temps.push(dir);
  for (const name of [
    "proofs",
    "src/verified",
    "scripts/check-proofs.ts",
    "scripts/compile-proofs.ts",
    "bun.lock",
    "package.json",
  ])
    await cp(join(root, name), join(dir, name), { recursive: true });
  await symlink(join(root, "node_modules"), join(dir, "node_modules"), "dir");
  return dir;
}
const check = (dir: string) =>
  exec(
    process.execPath,
    [
      require.resolve("tsx/cli"),
      join(dir, "scripts/check-proofs.ts"),
      "--artifact",
    ],
    { cwd: dir, timeout: 10000 },
  );
describe("source-bound proof receipts", () => {
  it("rejects an ABI that does not match the checked machine", async () => {
    const dir = await fixture();
    const file = join(dir, "proofs/abi.json");
    const abi = JSON.parse(await readFile(file, "utf8"));
    abi.budget.inputs.typo = abi.budget.inputs.used;
    delete abi.budget.inputs.used;
    await writeFile(file, JSON.stringify(abi));
    await expect(
      exec(
        process.execPath,
        [
          require.resolve("tsx/cli"),
          join(dir, "scripts/check-proofs.ts"),
          "--write",
        ],
        { cwd: dir, timeout: 25000 },
      ),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("ABI input mismatch"),
    });
  }, 30000);

  it("checks artifact freshness without invoking the prover", async () => {
    expect((await check(await fixture())).stdout).toContain("34 claim receipt");
  });
  it("refuses modified generated code", async () => {
    const dir = await fixture();
    await writeFile(
      join(dir, "src/verified/budget.js"),
      "export const forged = true;",
    );
    await expect(check(dir)).rejects.toMatchObject({
      stderr: expect.stringContaining("Stale proof artifact"),
    });
  });
  it("refuses an incomplete output inventory", async () => {
    const dir = await fixture();
    const file = join(dir, "src/verified/manifest.json");
    const r = JSON.parse(await readFile(file, "utf8"));
    delete r.outputs["src/verified/budget.js"];
    await writeFile(file, JSON.stringify(r));
    await expect(check(dir)).rejects.toMatchObject({
      stderr: expect.stringContaining("Incomplete proof outputs"),
    });
  });
  it("rejects dynamic imports before evaluating proof sources", async () => {
    const dir = await fixture();
    const file = join(dir, "proofs/policies.ts");
    await writeFile(
      file,
      (await readFile(file, "utf8")) + '\nawait import("node:fs");\n',
    );
    await expect(check(dir)).rejects.toMatchObject({
      stderr: expect.stringMatching(
        /Dynamic proof imports|Effectful proof expression/,
      ),
    });
  });
  it("refuses non-DSL effectful calls", async () => {
    const dir = await fixture();
    const file = join(dir, "proofs/policies.ts");
    await writeFile(
      file,
      (await readFile(file, "utf8")) + '\n({}).constructor("return 1")();\n',
    );
    await expect(check(dir)).rejects.toMatchObject({
      stderr: expect.stringMatching(
        /Unapproved proof method|Computed proof calls/,
      ),
    });
  });
});
