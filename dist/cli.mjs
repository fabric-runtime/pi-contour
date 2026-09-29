#!/usr/bin/env node
import { createRequire as __contourCreateRequire } from "node:module"; import { fileURLToPath as __contourFileURLToPath } from "node:url"; import { dirname as __contourDirname } from "node:path"; const require = __contourCreateRequire(import.meta.url); const __filename = __contourFileURLToPath(import.meta.url); const __dirname = __contourDirname(__filename);
import{a as w,b as $,c as k,d as R,e as N}from"./chunk-PLKGFI4M.mjs";import"./chunk-WUMNOO5F.mjs";import{a as I}from"./chunk-KGMBD5FP.mjs";import"./chunk-HXQEELCN.mjs";import{readFile as P,realpath as J}from"node:fs/promises";import{resolve as C}from"node:path";import{fileURLToPath as T}from"node:url";import{mkdir as j,readFile as U,writeFile as A,unlink as H,lstat as B}from"node:fs/promises";import{dirname as G,resolve as D}from"node:path";var v="# pi-contour managed pre-commit v1",y=t=>`'${t.replaceAll("'","'\\''")}'`;async function S(t){let{stdout:r}=await $("git",["rev-parse","--git-path","hooks/pre-commit"],t);return D(t,r.toString().trim())}async function _(t,r,e){if(!r.endsWith(".mjs"))throw new Error("Build first, then install using node dist/cli.mjs hook install");let i=await S(t),a=`#!/bin/sh
${v}
${y(process.execPath)} ${y(r)} review --staged --checkpoint${e?` --policy ${y(e)}`:""}
code=$?
`+(e?`exit "$code"
`:`if [ "$code" -eq 2 ]; then exit 2; fi
if [ "$code" -ne 0 ]; then printf "%s\\n" "Contour analysis unavailable; advisory hook did not block this commit." >&2; fi
exit 0
`);await j(G(i),{recursive:!0});let s=`#!/bin/sh
${v}
`,l=s+`# sha256:${w(a)}
`+a.slice(s.length);try{await A(i,l,{flag:"wx",mode:493})}catch(c){throw c.code==="EEXIST"?new Error(`Hook already exists at ${i}; integrate Contour manually or explicitly uninstall its managed hook first`):c}return`Installed ${i}${e?" (explicit policy enforcement; analysis failures block)":" (advisory)"}`}async function O(t){let r=await S(t);if(!(await B(r)).isFile())throw new Error("Refusing to remove a hook not managed by Contour");let e=await U(r,"utf8"),i=`#!/bin/sh
${v}
`,a=e.slice(i.length),s=a.indexOf(`
`);if(!e.startsWith(i)||a.slice(0,s)!==`# sha256:${w(i+a.slice(s+1))}`)throw new Error("Refusing to remove a modified or unmanaged Contour hook");return await H(r),`Removed ${r}`}async function L(){return"0.4.5"}var M=`contour review [--staged|--working-tree] [--json] [--root DIR]
               [--max-tokens N] [--max-findings N] [--policy FILE] [--checkpoint]
contour hook install [--root DIR] [--policy FILE]
contour hook uninstall [--root DIR]
contour --version

Reviews compare HEAD with an immutable target snapshot. No source or index writes.
Exit 0: advisory; 2: explicit boundary policy violations; 1: analysis/usage failure.
Hooks are opt-in, never overwrite existing hooks, and do not intercept shell commands.
`;async function V(t,r={out:e=>process.stdout.write(e),error:e=>process.stderr.write(e)}){if(!t.length||t.includes("--help")||t[0]==="help")return r.out(M),0;try{if(t.includes("--version"))return r.out(`contour ${await L()}
`),0;let e=[...t],i=e.shift(),a=i==="hook"?e.shift():void 0,s=process.cwd(),l="staged",c=!1,f=!1,u=!1,m,g=2500,x=8;for(;e.length;){let o=e.shift();if(o==="--json")f=!0;else if(o==="--checkpoint")u=!0;else if(o==="--staged"||o==="--working-tree"){if(c)throw new Error("Choose exactly one target");c=!0,l=o==="--staged"?"staged":"working-tree"}else if(["--root","--policy","--max-tokens","--max-findings"].includes(o??"")){let n=e.shift();if(!n||n.startsWith("--"))throw new Error(`Missing value for ${o}`);o==="--root"?s=C(n):o==="--policy"?m=n:o==="--max-tokens"?g=Number(n):x=Number(n)}else throw new Error(`Unknown argument: ${o}`)}let p=m?C(s,m):void 0,E=[];if(p){let o=await P(p,"utf8");if(o.length>65536)throw new Error("Policy file exceeds 64KiB");let n=JSON.parse(o);if(!n||!Array.isArray(n.boundaries)||Object.keys(n).some(h=>h!=="boundaries"))throw new Error("Policy must contain only a boundaries array");E=n.boundaries}let F=R({maxTokens:g,maxFindings:x,boundaries:E});if(i==="hook"){if(f||u||c)throw new Error("Review flags do not apply to hook management");if(a==="install")r.out(await _(s,T(import.meta.url),p)+`
`);else if(a==="uninstall")r.out(await O(s)+`
`);else throw new Error("Use hook install or hook uninstall");return 0}if(i!=="review")throw new Error(`Unknown command: ${i}`);if(u&&l!=="staged")throw new Error("Commit checkpoints require the staged target");let b=new AbortController,d=()=>b.abort(new Error("Review cancelled"));process.once("SIGINT",d),process.once("SIGTERM",d);try{let o=await new N().review(s,l,F,b.signal),n=!0;if(u&&!f){n=o.totalFindings>0||o.coverage.before.length>0||o.coverage.after.length>0;let h=await k.read(o.root,"checkpoint");!o.blockingFindings&&h===o.id&&(n=!1),n&&await k.write(o.root,"checkpoint",o.id)}return n&&r.out(f?JSON.stringify(o,null,2)+`
`:I(o,g).text+`
`),o.blockingFindings?2:0}finally{process.off("SIGINT",d),process.off("SIGTERM",d)}}catch(e){return r.error(`Contour: ${e instanceof Error?e.message:String(e)}
`),1}}process.argv[1]&&await J(process.argv[1]).catch(()=>"")===T(import.meta.url)&&(process.exitCode=await V(process.argv.slice(2)));export{V as main};
