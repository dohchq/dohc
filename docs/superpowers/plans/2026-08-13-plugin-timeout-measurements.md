# Plugin install/bundle timeout measurements

The evidence record for `PLUGIN_INSTALL_TIMEOUT_MS` and
`PLUGIN_BUNDLE_TIMEOUT_MS` in `apps/desktop/src/plugins/pluginSourceSnapshot.ts`
(AGENTS.md's "measure limits that reject work" rule). Moved here from a
gitignored `.agent-artifacts/references/` note (CodeRabbit #779 fixround
Section B item 9) so the record a shipped limit depends on is actually
tracked.

Measured on 2026-08-13. The measurement session started at
`2026-08-13T13:21:29.8719888Z`.

## Machine and tools

- Machine: `ICE-PC`
- OS: Microsoft Windows 11 Pro `10.0.22631`
- CPU: AMD Ryzen 9 7950X 16-Core Processor, 32 logical processors
- Memory: 67,811,323,904 bytes
- Node.js: `v24.16.0`
- pnpm: `11.20.0`
- esbuild: `0.28.1`

The pnpm entry was
`C:\Users\ice\dev\dohc\.agent-worktrees\plugin-pr2\apps\desktop\node_modules\pnpm\bin\pnpm.mjs`.
Run 1 installed this exact pinned desktop devDependency.

## Install measurements

Each fixture ran in a fresh `%TEMP%` directory. Each run had separate `work`,
`store`, `cache`, and `state` directories. The stopwatch covered only the pnpm
child process. It did not include the PowerShell startup or fixture copy.

The environment for each command was:

```text
PNPM_CONFIG_STORE_DIR=<run-root>\store
PNPM_CONFIG_CACHE_DIR=<run-root>\cache
PNPM_CONFIG_STATE_DIR=<run-root>\state
PNPM_CONFIG_UPDATE_NOTIFIER=false
```

The exact command was the same for all three runs:

```powershell
node C:\Users\ice\dev\dohc\.agent-worktrees\plugin-pr2\apps\desktop\node_modules\pnpm\bin\pnpm.mjs install --frozen-lockfile --ignore-scripts --ignore-workspace --node-linker=isolated
```

| Fixture | Temporary run root | Lockfile entries verified by pnpm | Installed bytes | Time |
| --- | --- | ---: | ---: | ---: |
| small | `C:\Users\ice\AppData\Local\Temp\dohc-pr2-run2-small-07658588-c49b-44dc-bda7-80bc83ac501c` | 1 | 4,560,218 | 1,730.851 ms |
| medium | `C:\Users\ice\AppData\Local\Temp\dohc-pr2-run2-medium-0fbc211c-d813-4a54-852d-7a11b4170c75` | 32 | 55,150,730 | 5,729.600 ms |
| large | `C:\Users\ice\AppData\Local\Temp\dohc-pr2-run2-large-6bdd6a7d-019b-4611-b63f-9599bb291d33` | 209 | 236,474,835 | 5,585.999 ms |

All commands exited with code 0. Every run downloaded into its own empty
store and cache; pnpm reported `reused 0`.

## Bundle measurements

Both measurements used esbuild's JavaScript `build()` API with these exact
options:

```js
{
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  metafile: true,
  logLevel: "silent",
}
```

The representative command bundled the existing hello-plugin entry:

```powershell
node --input-type=module -e "import { performance } from 'node:perf_hooks'; import { stat } from 'node:fs/promises'; import esbuild from './apps/desktop/node_modules/esbuild/lib/main.js'; const start=performance.now(); const result=await esbuild.build({entryPoints:['apps/desktop/e2e/fixtures/hello-plugin/plugin.mjs'],bundle:true,platform:'node',format:'esm',target:'node22',outfile:process.env.MEASURE_OUT,sourcemap:true,metafile:true,logLevel:'silent'}); const elapsed=performance.now()-start; const info=await stat(process.env.MEASURE_OUT); console.log(JSON.stringify({esbuildVersion:esbuild.version,elapsedMs:Number(elapsed.toFixed(3)),inputBytes:Object.values(result.metafile.inputs).reduce((sum,input)=>sum+input.bytes,0),outputBytes:info.size}));"
```

The heavy command appended the large fixture's `package.json` and
`pnpm-lock.yaml` bytes as a JSON-stringified exported payload. The two source
files total 71,819 bytes. Escaping and the hello-plugin source produced a
76,314-byte esbuild input.

```powershell
node --input-type=module -e "import { performance } from 'node:perf_hooks'; import { readFile,stat } from 'node:fs/promises'; import { dirname,resolve } from 'node:path'; import esbuild from './apps/desktop/node_modules/esbuild/lib/main.js'; const entry=resolve('apps/desktop/e2e/fixtures/hello-plugin/plugin.mjs'); const [hello,pkg,lock]=await Promise.all([readFile(entry,'utf8'),readFile('.agent-artifacts/references/measure-lockfiles/large/package.json','utf8'),readFile('.agent-artifacts/references/measure-lockfiles/large/pnpm-lock.yaml','utf8')]); const contents=hello+'\nexport const measurementPayload = '+JSON.stringify(pkg+lock)+';\n'; const start=performance.now(); const result=await esbuild.build({stdin:{contents,resolveDir:dirname(entry),sourcefile:'hello-plugin-heavy.mjs',loader:'js'},bundle:true,platform:'node',format:'esm',target:'node22',outfile:process.env.MEASURE_OUT,sourcemap:true,metafile:true,logLevel:'silent'}); const elapsed=performance.now()-start; const info=await stat(process.env.MEASURE_OUT); console.log(JSON.stringify({esbuildVersion:esbuild.version,elapsedMs:Number(elapsed.toFixed(3)),fixturePayloadBytes:Buffer.byteLength(pkg+lock),inputBytes:Object.values(result.metafile.inputs).reduce((sum,input)=>sum+input.bytes,0),outputBytes:info.size}));"
```

`MEASURE_OUT` named a new `bundle.mjs` in a fresh `%TEMP%` directory for each
command.

| Input | esbuild input bytes | Output bytes | Time |
| --- | ---: | ---: | ---: |
| hello-plugin | 2,252 | 2,385 | 190.892 ms |
| hello-plugin plus large fixture payload | 76,314 | 74,291 | 80.104 ms |

Both commands exited with code 0. The stopwatch started immediately before
`esbuild.build()` and included esbuild's service-process startup.

## Derived limits

- Largest healthy install: 5,729.600 ms. Four times this value is 22,918.400
  ms. `PLUGIN_INSTALL_TIMEOUT_MS` is 30,000 ms.
- Largest healthy bundle: 190.892 ms. Four times this value is 763.568 ms.
  `PLUGIN_BUNDLE_TIMEOUT_MS` is 1,000 ms.

Both constants round upward to clean values beyond four times the measured
healthy maximum. Re-measure if representative plugin dependency or source
sizes grow beyond these fixtures.

## Correction (2026-08-13, applied by the reviewing agent)

The "heavy" bundle measurement above embedded a JSON-stringified copy of the
large fixture's `package.json`/`pnpm-lock.yaml` text as a JS string constant
via `stdin`. esbuild never resolved or parsed real dependency modules for
that input, so it measured string-literal size, not bundling cost — which is
why it came back *faster* than the trivial hello-plugin case (80ms vs
191ms). That is not a representative "heavy" plugin bundle.

Re-measured with a real dependency graph: installed the medium fixture set
(`lucide-react@1.30.0`, `react@19.2.8`, `react-dom@19.2.8`, `zod@4.4.3`,
`esbuild@0.28.1`) via the same pinned pnpm command, wrote an entry that
actually imports and uses `react`, `react-dom/client`, `react-dom/server`,
ten named exports from `lucide-react`, and `zod`, then bundled it with the
same options (`bundle: true, platform: "node", format: "esm",
target: "node22", sourcemap: true, metafile: true, logLevel: "silent"`).

| Run | Input files | Input bytes | Output bytes | Time |
| --- | ---: | ---: | ---: | ---: |
| 1 (first build after fresh install, cold OS file cache) | 98 | 4,601,978 | 4,547,732 | 550.465 ms |
| 2 (warm re-bundle) | 98 | 4,601,978 | — | 278.561 ms |
| 3 (warm re-bundle) | 98 | 4,601,978 | — | 302.402 ms |

Largest healthy bundle: 550.465 ms. Four times this value is 2,201.860 ms.
`PLUGIN_BUNDLE_TIMEOUT_MS` is corrected from 1,000 ms to **3,000 ms**, still
rounding upward to a clean value beyond four times the measured healthy
maximum. Re-measure against a real T3-scale plugin once one exists (PR3).
