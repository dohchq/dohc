import { existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function relayInitializationRequired(config, dataDirectory, continuityDirectory) {
  if (existsSync(config)) return false;
  if ([dataDirectory, continuityDirectory].some(directory => readdirSync(directory).length !== 0)) {
    throw new Error('Relay data exists without its deployment configuration. Preserve both volumes and use the recovery procedure.');
  }
  return true;
}

async function main(action) {
  const password = process.env.POSTGRES_PASSWORD;
  if (password !== undefined) {
    process.env.POSTGRES_URL = `postgres://${encodeURIComponent(process.env.POSTGRES_USER ?? 'dohc')}:${encodeURIComponent(password)}@postgres:5432/${encodeURIComponent(process.env.POSTGRES_DB ?? 'dohc')}`;
  }
  const entrypoints = {
    'workspace-api': '/app/services/workspace-api/dist/main.js',
    'sync-relay': '/app/services/sync-relay/dist/main.js',
    'share-web': '/app/services/share-web/dist/main.js',
    migrate: '/app/scripts/migrate-postgres.mjs',
  };
  if (action === 'initialize') {
    const config = '/continuity/deployment.json';
    if (relayInitializationRequired(config, '/data', '/continuity')) {
      const result = spawnSync(process.execPath, ['/app/services/sync-relay/dist/relay-deployment.js', 'initialize',
        '--config', config, '--database', '/data/sync-relay.sqlite', '--continuity-directory', '/continuity/history'], { stdio: 'inherit' });
      if (result.error || result.status !== 0) throw new Error('Relay initialization failed. Preserve its volumes before retrying.');
    } else {
      console.log('Using the existing relay deployment. Startup will verify its continuity.');
    }
    return;
  }
  if (!Object.hasOwn(entrypoints, action)) throw new Error('Expected workspace-api, sync-relay, share-web, migrate, or initialize.');
  await import(pathToFileURL(entrypoints[action]).href);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv[2]).catch(error => { console.error(error.message); process.exitCode = 1; });
}
