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

/** The bundled database stays inside the Compose network. An external one must present a certificate signed by the provider's CA. */
export function postgresUrl(env) {
  const credentials = `${encodeURIComponent(env.POSTGRES_USER ?? 'dohc')}:${encodeURIComponent(env.POSTGRES_PASSWORD)}`;
  const database = encodeURIComponent(env.POSTGRES_DB ?? 'dohc');
  if (!env.DOHC_POSTGRES_HOST) return `postgres://${credentials}@postgres:5432/${database}`;
  return `postgres://${credentials}@${env.DOHC_POSTGRES_HOST}:${env.DOHC_POSTGRES_PORT}/${database}?sslmode=verify-full&sslrootcert=/etc/dohc/postgres-ca.pem`;
}

/** Migrations record every applied id, so a database without one has never held dohc's accounts. */
export async function accountsSchemaState(client) {
  const { rows: [table] } = await client.query("select to_regclass('dohc_migrations') is not null as present");
  if (!table.present) return 'missing';
  const { rows: [applied] } = await client.query('select exists (select 1 from dohc_migrations) as present');
  return applied.present ? 'present' : 'missing';
}

async function checkAccounts() {
  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString: process.env.POSTGRES_URL, connectionTimeoutMillis: 10_000 });
  await client.connect();
  try { console.log(await accountsSchemaState(client)); } finally { await client.end(); }
}

async function main(action) {
  if (process.env.POSTGRES_PASSWORD !== undefined) process.env.POSTGRES_URL = postgresUrl(process.env);
  if (action === 'check-accounts') return checkAccounts();
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
  if (!Object.hasOwn(entrypoints, action)) throw new Error('Expected workspace-api, sync-relay, share-web, migrate, initialize, or check-accounts.');
  await import(pathToFileURL(entrypoints[action]).href);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv[2]).catch(error => { console.error(error.message); process.exitCode = 1; });
}
