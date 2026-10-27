import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
const root = fileURLToPath(new URL("../", import.meta.url));
const inputs = [
  "proofs/policies.ts",
  "proofs/laws.ts",
  "proofs/abi.json",
  "proofs/ledger.json",
  "scripts/compile-proofs.ts",
  "scripts/check-proofs.ts",
  "bun.lock",
];
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const read = (path: string) => readFileSync(join(root, path), "utf8");
function validateSource(path: string): void {
  const source = ts.createSourceFile(
    path,
    read(path),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const spec = ts.isStringLiteral(node.moduleSpecifier)
        ? node.moduleSpecifier.text
        : "";
      if (!["gdp-wired", "./policies.ts"].includes(spec))
        throw new Error(`Forbidden proof import: ${spec}`);
    }
    if (ts.isCallExpression(node)) {
      const e = node.expression;
      if (e.kind === ts.SyntaxKind.ImportKeyword)
        throw new Error("Dynamic proof imports forbidden");
      if (ts.isIdentifier(e)) {
        if (!["fun", "min", "upTo", "when", "policyLaws"].includes(e.text))
          throw new Error(`Unapproved proof call: ${e.text}`);
      } else if (ts.isPropertyAccessExpression(e)) {
        if (
          ![
            "inputs",
            "assume",
            "returns",
            "law",
            "atMost",
            "atLeast",
            "plus",
            "minus",
            "gt",
            "lt",
            "eq",
            "and",
            "or",
            "not",
            "implies",
          ].includes(e.name.text)
        )
          throw new Error(`Unapproved proof method: ${e.name.text}`);
      } else throw new Error("Computed proof calls forbidden");
    }
    if (
      ts.isNewExpression(node) ||
      ts.isAwaitExpression(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node)
    )
      throw new Error("Effectful proof expression forbidden");
    if (
      ts.isIdentifier(node) &&
      [
        "process",
        "globalThis",
        "require",
        "eval",
        "Function",
        "fetch",
        "global",
        "Reflect",
      ].includes(node.text)
    )
      throw new Error(`Effectful proof source: ${node.text}`);
    if (
      ts.isPropertyAccessExpression(node) &&
      ["facts", "fns"].includes(node.name.text)
    )
      throw new Error("Foreign proof assumptions forbidden");
    ts.forEachChild(node, visit);
  };
  visit(source);
}
async function main() {
  for (const path of ["proofs/policies.ts", "proofs/laws.ts"])
    validateSource(path);
  const mode = process.argv[2];
  if (mode && !["--write", "--artifact"].includes(mode))
    throw new Error("Use --write or --artifact");
  const sources = Object.fromEntries(inputs.map((p) => [p, hash(read(p))]));
  const pkg = JSON.parse(read("package.json"));
  if (pkg.devDependencies["gdp-wired"] !== "0.30.1")
    throw new Error("Expected pinned gdp-wired 0.30.1");
  const receiptPath = join(root, "src/verified/manifest.json");
  if (mode === "--artifact") {
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    if (JSON.stringify(receipt.sources) !== JSON.stringify(sources))
      throw new Error("Stale proof sources");
    const expected = Object.keys(JSON.parse(read("proofs/abi.json")))
      .flatMap((n) => [`src/verified/${n}.js`, `src/verified/${n}.d.ts`])
      .sort();
    if (
      JSON.stringify(Object.keys(receipt.outputs).sort()) !==
      JSON.stringify(expected)
    )
      throw new Error("Incomplete proof outputs");
    for (const path of expected)
      if (hash(read(path)) !== receipt.outputs[path])
        throw new Error(`Stale proof artifact: ${path}`);
    if (
      receipt.prover !== "gdp-wired@0.30.1" ||
      receipt.claims !== JSON.parse(read("proofs/ledger.json")).length
    )
      throw new Error("Invalid proof receipt");
    console.log(
      `${receipt.claims} claim receipt and executable artifacts match`,
    );
    return;
  }
  const { compileProofs } = await import("./compile-proofs.ts");
  const files = await compileProofs(root);
  for (const [path, text] of Object.entries(files)) {
    if (mode === "--write") {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    } else if (read(path) !== text)
      throw new Error(`Stale generated runtime: ${path}`);
  }
  const receipt = {
    prover: "gdp-wired@0.30.1",
    claims: JSON.parse(read("proofs/ledger.json")).length,
    sources,
    outputs: Object.fromEntries(
      Object.entries(files).map(([p, t]) => [p, hash(t)]),
    ),
  };
  if (mode === "--write")
    writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + "\n");
  else if (
    readFileSync(receiptPath, "utf8") !==
    JSON.stringify(receipt, null, 2) + "\n"
  )
    throw new Error("Stale proof receipt");
  console.log(
    `${receipt.claims} laws proved and checked; executable policies ${mode === "--write" ? "generated" : "matched"}`,
  );
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
