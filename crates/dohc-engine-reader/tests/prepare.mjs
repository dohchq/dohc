// Run after the frozen install. Builds only a test fixture generator.
import {build} from '../../../packages/ydoc-projection/node_modules/esbuild/lib/main.js';
import {spawnSync} from 'node:child_process';
import {resolve, join} from 'node:path';
const destination = resolve(process.argv[2]);
await build({entryPoints:[new URL('./prepare.ts',import.meta.url).pathname.replace(/^\/(.:)/,'$1')],
  outfile:join(destination,'prepare.cjs'), bundle:true, platform:'node', format:'cjs'});
const child = spawnSync(process.execPath,[join(destination,'prepare.cjs'),destination,...process.argv.slice(3)],{stdio:'inherit'});
process.exitCode = child.status ?? 1;
