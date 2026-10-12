import { cpSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { acquireBuildSlot, freeDiskGb, resolveBuildBudget } from '../rust-engine-program/build-slot.mjs';

const { values } = parseArgs({ options: { image: { type: 'string' }, output: { type: 'string' }, archive: { type: 'boolean' }, 'allow-dirty': { type: 'boolean' } } });
function run(command, args, capture = false) {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit' });
  if (result.error || result.status !== 0) throw new Error(`${command} failed (${result.status ?? 'unavailable'}).`);
  return result.stdout?.trim();
}
let slot;
try {
  if (!values.image || !values.output) throw new Error('Use --image dohc-self-host:VERSION --output NEW_DIRECTORY [--archive].');
  const output = resolve(values.output);
  if (existsSync(output)) throw new Error('Choose a new output directory. Existing release bundles are never replaced.');
  const revision = run('git', ['rev-parse', 'HEAD'], true);
  const dirty = Boolean(run('git', ['status', '--porcelain'], true));
  if (dirty && !values['allow-dirty']) throw new Error('Commit the release source before building. Use --allow-dirty only for a local proof.');
  const budget = resolveBuildBudget(), free = freeDiskGb(process.cwd());
  if (free === null || free < (budget?.diskFloorGb ?? 40)) throw new Error('Release build requires at least 40 GB of verified free disk space.');
  if (budget) slot = await acquireBuildSlot(budget);
  run('docker', ['build', '--progress=plain', '-f', 'tools/self-host/Dockerfile', '--build-arg', `DOHC_REVISION=${revision}`, '-t', values.image, '.']);
  slot?.release(); slot = undefined;
  const image = JSON.parse(run('docker', ['image', 'inspect', values.image], true))[0];
  mkdirSync(output, { recursive: true });
  const files = ['docker-compose.self-host.yml', '.env.self-host.example', 'scripts/check-self-host.mjs',
    'tools/self-host/bootstrap.mjs', 'tools/self-host/config.mjs', 'tools/self-host/Caddyfile', 'tools/self-host/Caddyfile.private', 'tools/self-host/compose.private.yml',
    ...['scripts/self-host/recovery.mjs', 'scripts/self-host/archive.mjs', 'docs/how-to/self-host.md', 'docs/how-to/self-host-recovery.md', 'services/share-web/README.md'].filter(existsSync)];
  for (const path of files) {
    const destination = join(output, path);
    mkdirSync(dirname(destination), { recursive: true }); cpSync(path, destination);
  }
  if (values.archive) run('docker', ['image', 'save', '-o', join(output, 'services.tar'), values.image]);
  writeFileSync(join(output, 'release.json'), JSON.stringify({ version: 1, revision, dirty, image: values.image,
    imageId: image.Id, platform: `${image.Os}/${image.Architecture}`, files, archive: values.archive ? 'services.tar' : null }, null, 2) + '\n');
  console.log(`Release bundle: ${output}`);
  console.log('The bundle contains no deployment secrets. No image was published.');
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { slot?.release(); }
