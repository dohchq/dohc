import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const desktopRoot = fileURLToPath(new URL('..', import.meta.url));
const runtimeRoot = resolve(desktopRoot, '../../packages/app-backend-runtime');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

async function identities(root, prefix = '') {
  const result = {};
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix + entry.name;
    if (entry.isDirectory()) Object.assign(result, await identities(root, path + '/'));
    else if (entry.isFile() && path !== 'manifest.json') result[path] = digest(await readFile(join(root, path)));
    else if (!entry.isFile()) throw new Error(`Unexpected app runtime resource: ${path}`);
  }
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
}

export async function requireAppBackendRuntime(root = join(desktopRoot, 'resources/app-backend-runtime')) {
  const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
  const files = await identities(root);
  if (manifest.version !== 1 || !files['child.mjs'] || !files['persistent-child.mjs'] || !Object.keys(files).some(path => path.endsWith('.wasm')) ||
      JSON.stringify(manifest.files) !== JSON.stringify(files)) throw new Error('App backend runtime resources changed. Stage them before packaging.');
}

export async function stageAppBackendRuntime({ destination = join(desktopRoot, 'resources/app-backend-runtime') } = {}) {
  destination = resolve(destination);
  // The main bundle imports the compiled client; the child runs outside app.asar.
  execFileSync(process.execPath, [join(runtimeRoot, 'scripts/build.mjs')], { windowsHide: true, stdio: 'inherit' });
  await mkdir(dirname(destination), { recursive: true });
  const staging = await mkdtemp(`${destination}.staging-`);
  try {
    await cp(join(runtimeRoot, 'dist/child.mjs'), join(staging, 'child.mjs'));
    await cp(join(runtimeRoot, 'dist/persistent-child.mjs'), join(staging, 'persistent-child.mjs'));
    const copied = new Map();
    async function dependency(name, from) {
      const require = createRequire(join(from, 'package.json'));
      let source;
      try { source = dirname(require.resolve(`${name}/package.json`)); }
      catch (error) {
        if (error.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error;
        source = dirname(require.resolve(name));
        while (JSON.parse(await readFile(join(source, 'package.json'), 'utf8').catch(error => {
          if (error.code === 'ENOENT') return '{}'; throw error;
        })).name !== name) {
          const parent = dirname(source);
          if (parent === source) throw new Error(`Cannot locate app runtime dependency: ${name}`);
          source = parent;
        }
      }
      const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
      if (copied.has(name)) {
        if (copied.get(name) !== manifest.version) throw new Error(`Conflicting app runtime dependency: ${name}`);
        return;
      }
      copied.set(name, manifest.version);
      await cp(source, join(staging, 'node_modules', name), {
        recursive: true, dereference: true, filter: path => path === source || !path.slice(source.length + 1).split(/[\\/]/).includes('node_modules'),
      });
      for (const child of Object.keys(manifest.dependencies ?? {})) await dependency(child, source);
    }
    await dependency('quickjs-emscripten', runtimeRoot);
    await writeFile(join(staging, 'manifest.json'), JSON.stringify({ version: 1, files: await identities(staging) }));
    await requireAppBackendRuntime(staging);
    const current = await readFile(join(destination, 'manifest.json'), 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (current === await readFile(join(staging, 'manifest.json'), 'utf8')) {
      await requireAppBackendRuntime(destination);
      return { destination, changed: false };
    }
    const exists = await stat(destination).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
    const previous = `${staging}.previous`;
    if (exists) await rename(destination, previous);
    try { await rename(staging, destination); }
    catch (error) { if (exists) await rename(previous, destination); throw error; }
    const retained = exists ? await rm(previous, { recursive: true, force: true }).then(() => null, () => previous) : null;
    return { destination, changed: true, retained };
  } finally { await rm(staging, { recursive: true, force: true }); }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  console.log(JSON.stringify(await stageAppBackendRuntime()));
}
