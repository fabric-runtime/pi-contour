import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { build } from "esbuild";
import { compileJs } from "gdp-wired/machine";
import { crossCheckDecision, proveDecision } from "gdp-wired";
import { policies } from "../proofs/policies.ts";
import { laws } from "../proofs/laws.ts";

type Shape = Record<string, "number" | "boolean">;
export async function compileProofs(
  root: string,
): Promise<Record<string, string>> {
  const ledger = JSON.parse(
    readFileSync(join(root, "proofs/ledger.json"), "utf8"),
  ) as string[];
  if (
    JSON.stringify(laws.map((l) => l.name).sort()) !==
      JSON.stringify([...ledger].sort()) ||
    new Set(ledger).size !== ledger.length
  )
    throw new Error("Proof ledger mismatch");
  for (const law of laws) {
    const result = proveDecision(law);
    if (!result.proven || !result.checked)
      throw new Error(`Unproved law: ${law.name}`);
    const cross = crossCheckDecision(law);
    if (cross.failure || !cross.checked)
      throw new Error(cross.failure ?? "Vacuous cross-check");
  }
  const abi = JSON.parse(
    readFileSync(join(root, "proofs/abi.json"), "utf8"),
  ) as Record<string, { inputs: Shape; outputs: Shape }>;
  if (
    JSON.stringify(Object.keys(abi).sort()) !==
    JSON.stringify(Object.keys(policies).sort())
  )
    throw new Error("ABI policy mismatch");
  const files: Record<string, string> = {};
  const shape = (s: Shape) =>
    `{ ${Object.entries(s)
      .map(([k, t]) => `${k}: ${t}`)
      .join("; ")} }`;
  for (const [name, policy] of Object.entries(policies)) {
    const machine = policy.rule.machine;
    if (Object.keys(machine.fns ?? {}).length)
      throw new Error("Foreign proof functions are forbidden");
    const source = compileJs(machine);
    const ast = ts.createSourceFile(
      "machine.js",
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    const exported = ast.statements.filter(
      (s) =>
        ts.canHaveModifiers(s) &&
        ts.getModifiers(s)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword),
    );
    if (
      exported.length !== 3 ||
      !exported.every(ts.isFunctionDeclaration) ||
      exported
        .map((s) => (s as ts.FunctionDeclaration).name?.text)
        .join(",") !== "init,fork,step"
    )
      throw new Error("Unrecognized generated module");
    const spec = abi[name]!;
    if (
      JSON.stringify([...machine.inputs].sort()) !==
      JSON.stringify(Object.keys(spec.inputs).sort())
    )
      throw new Error(`ABI input mismatch: ${name}`);
    if (
      JSON.stringify(Object.keys(machine.state).sort()) !==
      JSON.stringify(
        Object.keys(spec.outputs)
          .map((key) => `out.${key}`)
          .sort(),
      )
    )
      throw new Error(`ABI output mismatch: ${name}`);
    const inputs = Object.entries(spec.inputs)
      .map(
        ([k, t]) =>
          `${JSON.stringify(k)}: ${t === "boolean" ? `+input.${k}` : `input.${k}`}`,
      )
      .join(",");
    const outputs = Object.entries(spec.outputs)
      .map(
        ([k, t]) =>
          `${JSON.stringify(k)}: ${t === "boolean" ? "!!" : ""}result[${JSON.stringify("out." + k)}]`,
      )
      .join(",");
    let wrapper = `${source.replace(/^export /gm, "")}\nexport function ${name}(input){${name === "budget" ? `if(input.used>input.limit)throw new RangeError("Invalid budget state");` : name === "fit" ? `if(input.selected>0&&input.selectedCost>input.budget)throw new RangeError("Invalid prefix state");` : ""}const result=step({},init({}),{${inputs}}).scalars; return {${outputs}};}`;
    const keys = Object.keys(spec.inputs),
      fields = Object.keys(spec.outputs);
    if (
      Object.values(spec.inputs).every((type) => type === "boolean") &&
      Object.values(spec.outputs).every((type) => type === "boolean") &&
      keys.length <= 8 &&
      fields.length <= 8
    ) {
      // Enumerate the complete Boolean domain, not a sampled approximation.
      // The ABI and Boolean result checks bound this dynamic compiler bridge.
      const run = policy.run.bind(policy) as unknown as (
        input: Record<string, boolean>,
      ) => Record<string, boolean>;
      const table = Array.from({ length: 2 ** keys.length }, (_, mask) => {
        const input = Object.fromEntries(
          keys.map((key, bit) => [key, !!(mask & (1 << bit))]),
        );
        const result = run(input);
        if (fields.some((key) => typeof result[key] !== "boolean"))
          throw new Error(`Invalid Boolean ABI: ${name}`);
        return fields.reduce(
          (bits, key, bit) => bits | (Number(result[key]) << bit),
          0,
        );
      });
      const guard = `if(${JSON.stringify(keys)}.some(key=>typeof input[key]!=="boolean"))throw new TypeError("Expected Boolean policy input");`;
      const index =
        keys.map((key, bit) => `Number(input.${key})*${2 ** bit}`).join("+") ||
        "0";
      const values = fields
        .map((key, bit) => `${JSON.stringify(key)}:!!(bits&${2 ** bit})`)
        .join(",");
      wrapper = `const table=${JSON.stringify(table)};export function ${name}(input){${guard}const bits=table[${index}];return {${values}};}`;
    }
    const bundled = await build({
      stdin: { contents: wrapper, loader: "js" },
      write: false,
      bundle: true,
      format: "esm",
      platform: "neutral",
      target: "es2022",
      minify: false,
      legalComments: "none",
    });
    const code = bundled.outputFiles![0]!.text;
    if (
      /\b(?:process|globalThis|console|fetch|eval|Function|require)\b/.test(
        code,
      ) ||
      /^import /m.test(code)
    )
      throw new Error("Impure generated runtime");
    files[`src/verified/${name}.js`] =
      `// Generated by gdp-wired 0.30.1; do not edit. MIT, Copyright (c) 2026 Tom X Nguyen.\n${code}`;
    files[`src/verified/${name}.d.ts`] =
      `// Generated runtime ABI; do not edit.\nexport declare function ${name}(input: ${shape(spec.inputs)}): ${shape(spec.outputs)};\n`;
  }
  return files;
}
