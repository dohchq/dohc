import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

export function relayInitializationRequired(config, dataDirectory, continuityDirectory) {
  if (existsSync(config)) return false;
  if ([dataDirectory, continuityDirectory].some(directory => readdirSync(directory).length !== 0)) {
    throw new Error('Relay data exists without its deployment configuration. Preserve both volumes and use the recovery procedure.');
  }
  return true;
}

// Every service's pg reads its connection URL with this parser, at the version the lockfile pins.
const parseConnection = url => createRequire(createRequire(new URL('../../services/workspace-api/package.json', import.meta.url))
  .resolve('pg'))('pg-connection-string')(url);

/** The bundled database stays inside the Compose network. An external one must present a certificate signed by the provider's CA. */
export function postgresUrl(env) {
  const user = env.POSTGRES_USER ?? 'dohc', password = env.POSTGRES_PASSWORD, database = env.POSTGRES_DB ?? 'dohc';
  const external = Boolean(env.DOHC_POSTGRES_HOST), ca = '/etc/dohc/postgres-ca.pem';
  const [host, port] = external ? [env.DOHC_POSTGRES_HOST, env.DOHC_POSTGRES_PORT] : ['postgres', '5432'];
  const url = `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(database)}` +
    (external ? `?sslmode=verify-full&sslrootcert=${ca}` : '');
  // A value the parser reads back differently, such as the database "..", would connect elsewhere or without TLS.
  const { ssl, ...parsed } = parseConnection(url);
  if (!isDeepStrictEqual(parsed, { user, password, host, port, database, ...(external ? { sslmode: 'verify-full', sslrootcert: ca } : {}) }) ||
    !isDeepStrictEqual(Object.keys(ssl ?? {}), external ? ['ca'] : [])) {
    throw new Error('The database settings do not survive the connection URL unchanged. Check POSTGRES_DB, POSTGRES_USER, DOHC_POSTGRES_HOST and DOHC_POSTGRES_PORT.');
  }
  return url;
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
  if (process.env.DOHC_ENGINE_READER_CONFIG === undefined) {
    try { process.env.DOHC_ENGINE_READER_CONFIG = readFileSync("/opt/dohc-reader/engine-reader/startup.json", "utf8"); }
    catch { /* Missing preparation leaves only the reader unavailable. */ }
  }
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
