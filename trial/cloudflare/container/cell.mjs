// Runs one dohc cell in a single container: the release's three services,
// Mailpit for trial mail, and Caddy as the path router on port 8080.
// Port 8080 opens only after every service reports ready, so the platform's
// port check marks the cell ready at the same point Compose would.
// The disk does not survive sleep, so the cell restores its last saved
// generation from R2 before starting and saves a new one after stopping.
import { spawn, spawnSync } from 'node:child_process';
import { once as event } from 'node:events';
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, readdirSync, rmSync, writeSync } from 'node:fs';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { createGunzip, createGzip } from 'node:zlib';

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

// The outbound handler for this host lives in the Worker. It stores parts in R2
// and records each committed generation in the cell's Durable Object.
const STATE = 'http://state.trial';
const PART_BYTES = 64 * 1024 * 1024;
const RELAY_DB = '/data/sync-relay.sqlite';
let generation = 0, restored = false;

function relayStamp() {
  const db = new DatabaseSync(RELAY_DB, { readOnly: true });
  try { return Number(db.prepare('SELECT stamp FROM sync_relay_continuity').get().stamp); } finally { db.close(); }
}

async function exited(child) {
  const [code] = child.exitCode === null ? await event(child, 'exit') : [child.exitCode];
  if (code !== 0) throw new Error(`${child.spawnfile} exited with ${code}.`);
}

async function restore() {
  const saved = await (await fetch(`${STATE}/generation`)).json();
  let bytes = 0;
  if (saved.generation > 0) {
    const tar = spawn('tar', ['-xf', '-', '-C', '/'], { stdio: ['pipe', 'inherit', 'inherit'] });
    const gunzip = createGunzip();
    gunzip.pipe(tar.stdin);
    for (let index = 0; index < saved.parts; index++) {
      const response = await fetch(`${STATE}/parts/${saved.generation}/${index}`);
      if (!response.ok) throw new Error(`Part ${index} of generation ${saved.generation} is missing.`);
      for await (const chunk of response.body) {
        bytes += chunk.length;
        if (!gunzip.write(chunk)) await event(gunzip, 'drain');
      }
    }
    gunzip.end();
    await exited(tar);
    // The archive must match the Durable Object's record, or it is not the last confirmed save.
    if (relayStamp() !== saved.relayStamp) throw new Error(`Restored relay stamp ${relayStamp()} is not the recorded ${saved.relayStamp}.`);
  }
  generation = saved.generation;
  restored = true;
  mark(`restore generation=${generation} bytes=${bytes}`);
}

async function save() {
  if (!restored || !existsSync(RELAY_DB)) return;
  const begun = performance.now(), next = generation + 1, relay = relayStamp();
  const tar = spawn('tar', ['-cf', '-', '-C', '/', 'data', 'continuity', 'host-data'], { stdio: ['ignore', 'pipe', 'inherit'] });
  const gzip = createGzip({ level: 1 });
  tar.stdout.pipe(gzip);
  let parts = 0, bytes = 0, pending = [], size = 0;
  const flush = async () => {
    const body = Buffer.concat(pending);
    pending = []; size = 0;
    const response = await fetch(`${STATE}/parts/${next}/${parts}`, { method: 'PUT', body });
    if (!response.ok) throw new Error(`Saving part ${parts} failed with ${response.status}.`);
    parts++; bytes += body.length;
  };
  for await (const chunk of gzip) {
    pending.push(chunk); size += chunk.length;
    if (size >= PART_BYTES) await flush();
  }
  if (size > 0 || parts === 0) await flush();
  await exited(tar);
  const saveMs = Math.round(performance.now() - begun);
  const response = await fetch(`${STATE}/commit/${next}`, { method: 'POST', body: JSON.stringify({ parts, bytes, relayStamp: relay, saveMs }) });
  if (!response.ok) throw new Error(`Committing generation ${next} failed with ${response.status}.`);
  generation = next;
  mark(`save generation=${next} bytes=${bytes} parts=${parts} saveMs=${saveMs}`);
}

const children = new Map();
let stopping = false;
function stopAll(code) {
  if (stopping) return;
  stopping = true;
  mark('stopping');
  for (const child of children.values()) child.kill('SIGTERM');
  let finishing = false;
  const finish = async () => {
    if (finishing || ![...children.values()].every(child => child.exitCode !== null || child.signalCode !== null)) return;
    finishing = true;
    try { await save(); } catch (error) { console.error(JSON.stringify({ trial: 'save-failed', error: String(error) })); code = 1; }
    process.exit(code);
  };
  for (const child of children.values()) child.once('exit', finish);
  finish();
}
process.on('SIGTERM', () => stopAll(0));
process.on('SIGINT', () => stopAll(0));

function start(name) {
  if (stopping) return;
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
function cgroup() {
  const read = path => { try { return readFileSync(path, 'utf8').trim(); } catch { return null; } };
  return { memoryCurrent: read('/sys/fs/cgroup/memory.current'), memoryMax: read('/sys/fs/cgroup/memory.max'),
    memoryStat: read('/sys/fs/cgroup/memory.stat')?.split('\n').filter(line => /^(anon|file) /.test(line)),
    cpuStat: read('/sys/fs/cgroup/cpu.stat')?.split('\n').slice(0, 3), cpuMax: read('/sys/fs/cgroup/cpu.max'),
    meminfo: read('/proc/meminfo')?.split('\n').slice(0, 3) };
}
function sizes() {
  const result = spawnSync('du', ['-sb', '/data', '/continuity', '/host-data'], { encoding: 'utf8' });
  return Object.fromEntries(result.stdout.trim().split('\n').map(line => line.split('\t')).map(([bytes, path]) => [path, Number(bytes)]));
}
// Same shape as trial/measure/fsync.cjs: 4 KiB write+fsync, the cost of a WAL commit.
function fsyncProbe(directory) {
  const path = `${directory}/.trial-fsync-probe`, buffer = Buffer.alloc(4096, 1), samples = [];
  const fd = openSync(path, 'w');
  try {
    for (let index = 0; index < 200; index++) {
      const begun = process.hrtime.bigint();
      writeSync(fd, buffer); fsyncSync(fd);
      samples.push(Number(process.hrtime.bigint() - begun) / 1e6);
    }
  } finally { closeSync(fd); rmSync(path); }
  return percentiles({ directory }, samples);
}
// Round trips from the container to its Durable Object or to R2 through the outbound handler.
async function stateProbe(target, bytes) {
  const samples = [], body = Buffer.alloc(bytes, 1);
  for (let index = 0; index < 50; index++) {
    const begun = performance.now();
    const response = await fetch(`${STATE}/probe/${target}`, { method: 'PUT', body });
    if (!response.ok) throw new Error(`Probe failed with ${response.status}.`);
    samples.push(performance.now() - begun);
  }
  return percentiles({ target, bytes }, samples);
}
function percentiles(fields, samples) {
  samples.sort((a, b) => a - b);
  const at = p => +samples[Math.floor(p * (samples.length - 1))].toFixed(2);
  return { ...fields, count: samples.length, p50Ms: at(0.5), p95Ms: at(0.95), p99Ms: at(0.99), maxMs: at(1) };
}
createServer(async (request, response) => {
  const url = new URL(request.url, 'http://cell');
  response.setHeader('content-type', 'application/json');
  try {
    if (url.pathname === '/__trial/stats/fsync') return response.end(JSON.stringify(fsyncProbe(url.searchParams.get('dir') ?? '/host-data')));
    if (url.pathname === '/__trial/stats/state') {
      return response.end(JSON.stringify(await stateProbe(url.searchParams.get('target') ?? 'do', Number(url.searchParams.get('bytes') ?? 4096))));
    }
    response.end(JSON.stringify({ uptimeMs: Math.round(performance.now() - started), generation, timings,
      processes: processes(), cgroup: cgroup(), bytes: sizes() }));
  } catch (error) { response.statusCode = 500; response.end(JSON.stringify({ error: String(error) })); }
}).listen(8099, '127.0.0.1');

mark('supervisor');
await restore();
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
