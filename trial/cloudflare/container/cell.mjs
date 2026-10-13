// Runs one dohc cell in a single container: the release's three services,
// Mailpit for trial mail, and Caddy as the path router on port 8080.
// Port 8080 opens only after every service reports ready, so the platform's
// port check marks the cell ready at the same point Compose would.
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

const started = performance.now();
const timings = [];
const mark = name => {
  const entry = { name, ms: Math.round(performance.now() - started) };
  timings.push(entry);
  console.log(JSON.stringify({ trial: 'phase', ...entry }));
};

const env = process.env;
const origin = env.DOHC_PUBLIC_ORIGIN, host = new URL(origin).host;
for (const name of ['POSTGRES_URL', 'BETTER_AUTH_SECRET', 'DOHC_RELAY_LINK_KEY', 'DOHC_RELAY_EXCHANGE_KEY']) {
  if (!env[name]) throw new Error(`${name} is missing.`);
}
// entrypoint.mjs replaces POSTGRES_URL with the Compose host when POSTGRES_PASSWORD is set.
const base = { PATH: env.PATH, HOME: '/tmp', NODE_ENV: 'production', POSTGRES_URL: env.POSTGRES_URL };
const auth = { ...base, BETTER_AUTH_SECRET: env.BETTER_AUTH_SECRET };
const entry = ['/app/tools/self-host/entrypoint.mjs'];
const services = {
  mailpit: { command: '/usr/local/bin/mailpit', args: [], env: {
    PATH: env.PATH, MP_SMTP_BIND_ADDR: '127.0.0.1:1025', MP_UI_BIND_ADDR: '127.0.0.1:8025',
    MP_WEBROOT: '/__trial/mail/', MP_MAX_MESSAGES: '20000', MP_DATABASE: '/tmp/mailpit.db' } },
  'workspace-api': { args: [...entry, 'workspace-api'], env: { ...auth,
    WORKSPACE_API_PORT: '1786', WORKSPACE_API_BASE_URL: origin, DOHC_WEB_ORIGIN: origin, DOHC_SERVER_RELAY_URL: origin,
    DOHC_SERVER_NAME: env.DOHC_SERVER_NAME ?? 'dohc trial cell', DOHC_SERVER_NETWORK_ACCESS: 'public',
    DOHC_AUTH_TRUSTED_PROXIES: '127.0.0.1',
    DOHC_SMTP_HOST: '127.0.0.1', DOHC_SMTP_PORT: '1025', DOHC_SMTP_SECURE: 'false', DOHC_SMTP_FROM: 'dohc trial <trial@dohc.invalid>' } },
  'sync-relay': { args: [...entry, 'sync-relay'], env: { ...auth,
    DOHC_RELAY_LINK_KEY: env.DOHC_RELAY_LINK_KEY, DOHC_RELAY_EXCHANGE_KEY: env.DOHC_RELAY_EXCHANGE_KEY,
    DOHC_RELAY_SHARE_WEB_ORIGIN: origin, SYNC_RELAY_AUTH_BASE_URL: origin, SYNC_RELAY_BIND: '127.0.0.1', SYNC_RELAY_PORT: '1788',
    DOHC_RELAY_DEPLOYMENT_CONFIG: '/continuity/deployment.json', DOHC_SELF_HOST_LIVE: '1', DOHC_RELAY_AUTOMATIONS: '1',
    DOHC_RELAY_NAMED_LIVE_HOSTS: host, DOHC_RELAY_SERVICE_HOST_ROOT: '/host-data',
    DOHC_RELAY_ENGINE_EXECUTABLE: '/app/bin/dohc-workspace-engine', DOHC_RELAY_PUBLIC_ORIGIN: origin,
    DOHC_RELAY_APP_PUBLICATIONS: '0', DOHC_RELAY_APP_BACKEND_MAX_PARTICIPANTS_PER_GRANT: '1000',
    DOHC_RELAY_APP_COLLECTION_MAX_CREATES_PER_GRANT: '0' } },
  'share-web': { args: [...entry, 'share-web'], env: { ...base,
    DOHC_SELF_HOST_LIVE: '1', DOHC_SHARE_WEB_RELAY_URL: 'http://127.0.0.1:1788', DOHC_SHARE_WEB_AUTH_URL: 'http://127.0.0.1:1786',
    DOHC_SHARE_WEB_PUBLIC_ORIGIN: origin, DOHC_SHARE_WEB_PUBLIC_RELAY_URL: origin, DOHC_SHARE_WEB_PUBLIC_HOSTS: host,
    DOHC_SHARE_WEB_RELAY_EXCHANGE_KEY: env.DOHC_RELAY_EXCHANGE_KEY, DOHC_SHARE_WEB_TRUSTED_PROXIES: '127.0.0.1',
    DOHC_SHARE_WEB_APP_DOMAIN: '', DOHC_SHARE_WEB_BIND: '127.0.0.1', DOHC_SHARE_WEB_PORT: '1790' } },
  caddy: { command: '/usr/local/bin/caddy', args: ['run', '--config', '/etc/dohc-trial/Caddyfile', '--adapter', 'caddyfile'],
    env: { PATH: env.PATH, HOME: '/tmp', XDG_DATA_HOME: '/tmp/caddy-data', XDG_CONFIG_HOME: '/tmp/caddy-config' } },
};

const children = new Map();
let stopping = false;
function stopAll(code) {
  if (stopping) return;
  stopping = true;
  mark('stopping');
  for (const child of children.values()) child.kill('SIGTERM');
  const exit = () => { if ([...children.values()].every(child => child.exitCode !== null || child.signalCode !== null)) process.exit(code); };
  for (const child of children.values()) child.once('exit', exit);
  exit();
}
process.on('SIGTERM', () => stopAll(0));
process.on('SIGINT', () => stopAll(0));

function start(name) {
  const service = services[name];
  const child = spawn(service.command ?? process.execPath, service.args, { env: service.env, stdio: 'inherit' });
  children.set(name, child);
  child.once('exit', (code, signal) => {
    if (stopping) return;
    console.error(JSON.stringify({ trial: 'exit', service: name, code, signal }));
    stopAll(1);
  });
}

function once(name, action) {
  const result = spawnSync(process.execPath, [...entry, action], { env: action === 'migrate' ? base : { PATH: env.PATH }, stdio: 'inherit' });
  if (result.error || result.status !== 0) throw new Error(`${name} failed.`);
  mark(name);
}

async function ready(name) {
  const healthEnv = { ...services[name].env };
  for (;;) {
    if (stopping) return;
    const result = spawnSync(process.execPath, ['/app/tools/self-host/health.mjs', name], { env: healthEnv, stdio: 'ignore' });
    if (result.status === 0) { mark(`${name} ready`); return; }
    await delay(250);
  }
}

// Loopback-only trial endpoint for startup timings and per-process memory.
function processes() {
  const rows = [];
  for (const pid of readdirSync('/proc').filter(name => /^\d+$/.test(name))) {
    try {
      const status = readFileSync(`/proc/${pid}/status`, 'utf8');
      const field = name => Number(new RegExp(`^${name}:\\s+(\\d+)`, 'm').exec(status)?.[1] ?? NaN);
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ');
      rows.push({ pid: Number(pid), rssMiB: +(field('VmRSS') / 1024).toFixed(1), peakMiB: +(field('VmHWM') / 1024).toFixed(1),
        cpuSeconds: +((Number(stat[11]) + Number(stat[12])) / 100).toFixed(2),
        command: readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim().slice(0, 80) });
    } catch {}
  }
  return rows;
}
function memory() {
  const read = path => { try { return readFileSync(path, 'utf8').trim(); } catch { return null; } };
  return { cgroupCurrent: read('/sys/fs/cgroup/memory.current'), cgroupMax: read('/sys/fs/cgroup/memory.max'),
    meminfo: read('/proc/meminfo')?.split('\n').slice(0, 5) };
}
createServer((request, response) => {
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify({ uptimeMs: Math.round(performance.now() - started), timings, processes: processes(), memory: memory() }));
}).listen(8099, '127.0.0.1');

mark('supervisor');
once('migrate', 'migrate');
once('initialize', 'initialize');
start('mailpit');
start('workspace-api');
start('sync-relay');
await Promise.all([ready('workspace-api'), ready('sync-relay')]);
start('share-web');
await ready('share-web');
start('caddy');
mark('router');
