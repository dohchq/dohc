// Run after the frozen install. Builds only a test fixture generator.
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {mkdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {resolve, join} from 'node:path';
const destination = resolve(process.argv[2]);
const require = createRequire(new URL('../../../packages/ydoc-projection/package.json', import.meta.url));
const {build} = require('esbuild');
mkdirSync(destination, {recursive:true});
await build({entryPoints:[fileURLToPath(new URL('./prepare.ts',import.meta.url))],
  outfile:join(destination,'prepare.cjs'), bundle:true, platform:'node', format:'cjs',
  alias:{yjs:require.resolve('yjs')}});
const child = spawnSync(process.execPath,[join(destination,'prepare.cjs'),destination,...process.argv.slice(3)],{stdio:'inherit'});
process.exitCode = child.status ?? 1;
