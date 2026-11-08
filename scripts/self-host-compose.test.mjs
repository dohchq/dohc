import assert from 'node:assert/strict';
import fs, { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import test from 'node:test';
import { defineMappingTag, defineScalarTag, load, YAML11_SCHEMA } from 'js-yaml';
import { initialSettings, privateRouteInstructions, updateImageSetting } from '../tools/self-host/bootstrap.mjs';
import { accountsDatabaseError, deploymentChecks, validateSettings, composeArgs, dataDiskVolumeErrors, relayDeploymentCheck, relayDeploymentError, startupWaitSeconds, supportedComposeVersion } from '../tools/self-host/config.mjs';
import { accountsSchemaState, postgresUrl, relayInitializationRequired } from '../tools/self-host/entrypoint.mjs';

const composeText = readFileSync('docker-compose.self-host.yml', 'utf8');
const compose = load(composeText, { schema: YAML11_SCHEMA });
const settings = () => ({ ...parseEnv(readFileSync('.env.self-host.example', 'utf8')),
  ...initialSettings({ origin: 'https://dohc.team.invalid', image: 'dohc-self-host:v1' }),
  DOHC_SMTP_HOST: 'mail.team.invalid', DOHC_SMTP_FROM: 'dohc@team.invalid' });

test('private overlay requires a Compose version that supports override tags', () => {
  for (const version of ['2.24.4', 'v2.24.4', '2.25.0', '3.0.0']) assert.equal(supportedComposeVersion(version), true);
  for (const version of ['2.24.3', '1.29.2', '2.23.9', '', 'unavailable']) assert.equal(supportedComposeVersion(version), false);
});

test('production services use built images without source mounts or install commands', () => {
  for (const name of ['workspace-api', 'sync-relay', 'share-web']) {
    const service = compose.services[name];
    assert.match(service.image, /^\$\{DOHC_IMAGE:\?/);
    assert.deepEqual(service.command, [name]);
    assert.equal(service.environment.NODE_ENV, 'production');
    assert.equal(service.restart, 'unless-stopped');
    assert.ok(service.healthcheck.test);
    assert.ok(!(service.volumes ?? []).some(value => value.startsWith('.:')));
    assert.equal(service.ports, undefined);
  }
});

test('startup gates data services on their single-use initialization jobs', () => {
  assert.equal(compose.services['workspace-api'].depends_on['postgres-migrate'].condition, 'service_completed_successfully');
  assert.equal(compose.services['sync-relay'].depends_on['relay-initialize'].condition, 'service_completed_successfully');
  for (const name of ['workspace-api', 'sync-relay', 'share-web']) assert.equal(compose.services.gateway.depends_on[name].condition, 'service_healthy');
});

test('startup waits through the relay start period, then 180 s for its failing checks and the services after it', () => {
  const [, start] = /^(\d+)s$/.exec(compose.services['sync-relay'].healthcheck.start_period);
  assert.equal(startupWaitSeconds, Number(start) + 180);
});

test('an aborted relay validation process writes no core file', () => {
  assert.deepEqual(compose.services['sync-relay'].ulimits, { core: 0 });
});

test('database readiness waits for TCP after the temporary initialization server stops', () => {
  assert.match(compose.services.postgres.healthcheck.test[1], /pg_isready\s+-h\s+127\.0\.0\.1\s/);
  assert.equal(compose.services['postgres-migrate'].depends_on.postgres.condition, 'service_healthy');
});

test('auth, relay, and share links advertise the same public origin and exchange key, and the relay accepts live editing from share links', () => {
  const api = compose.services['workspace-api'].environment, relay = compose.services['sync-relay'].environment;
  const viewer = compose.services['share-web'].environment;
  assert.equal(api.WORKSPACE_API_BASE_URL, api.DOHC_SERVER_RELAY_URL);
  assert.equal(api.WORKSPACE_API_BASE_URL, viewer.DOHC_SHARE_WEB_PUBLIC_ORIGIN);
  assert.equal(api.WORKSPACE_API_BASE_URL, relay.SYNC_RELAY_AUTH_BASE_URL);
  assert.equal(relay.DOHC_RELAY_EXCHANGE_KEY, viewer.DOHC_SHARE_WEB_RELAY_EXCHANGE_KEY);
  const liveHosts = relay.DOHC_RELAY_NAMED_LIVE_HOSTS.split(',');
  assert.ok(liveHosts.includes(new URL(viewer.DOHC_SHARE_WEB_RELAY_URL).host), 'the relay must accept live editing that share links forward to it');
  assert.ok(liveHosts.includes(viewer.DOHC_SHARE_WEB_PUBLIC_HOSTS), 'the relay must still accept live editing through the public address');
  assert.equal(api.DOHC_AUTH_TRUSTED_PROXIES, `${compose.services.gateway.networks.dohc.ipv4_address},${compose.services['share-web'].networks.dohc.ipv4_address}`);
});

test('fresh configuration generates independent secrets and refuses invalid private endpoints', () => {
  const first = initialSettings({origin: 'https://machine.tail.ts.net', mode: 'private'});
  const second = initialSettings({origin: 'https://machine.tail.ts.net', mode: 'private'});
  assert.notEqual(first.BETTER_AUTH_SECRET, second.BETTER_AUTH_SECRET);
  assert.notEqual(first.BETTER_AUTH_SECRET, first.DOHC_RELAY_LINK_KEY);
  assert.equal(first.BETTER_AUTH_SECRET.length, 43);
  assert.throws(() => initialSettings({origin: 'http://machine.tail.ts.net', mode: 'private'}));
  assert.throws(() => initialSettings({origin: 'https://public.invalid', mode: 'private'}));
  assert.match(privateRouteInstructions(first).join('\n'), /Confirm HTTPS port 443 has no existing route/);
});

test('upgrade replaces spaced, exported, repeated and unchanged image assignments', () => {
  for (const assignment of ["DOHC_IMAGE='old:v1'", " DOHC_IMAGE = 'old:v1'", "export DOHC_IMAGE = old:v1", "DOHC_IMAGE=old:v1\nDOHC_IMAGE = old:v2"]) {
    const original = `# deployment\n${assignment}\nBETTER_AUTH_SECRET='preserve-this-value'\n`;
    const updated = updateImageSetting(original, 'new:v2');
    assert.equal(parseEnv(updated).DOHC_IMAGE, 'new:v2');
    assert.equal(parseEnv(updated).BETTER_AUTH_SECRET, 'preserve-this-value');
    assert.equal(updateImageSetting(updated, 'new:v2'), updated);
  }
  assert.throws(() => updateImageSetting('# DOHC_IMAGE=old:v1\n', 'new:v2'), /Add a DOHC_IMAGE assignment/);
  assert.throws(() => updateImageSetting("DOHC_IMAGE='old:\nv1'\n", 'new:v2'), /single-line/);
  assert.throws(() => updateImageSetting("NOTE='keep\nDOHC_IMAGE=quoted-content\n'\nDOHC_IMAGE=old:v1\n", 'new:v2'), /outside quoted multiline values/);
});

test('diagnostics reject placeholders and invalid origins without revealing secrets', () => {
  assert.deepEqual(validateSettings(settings()), []);
  const invalid = {...settings(), DOHC_PUBLIC_ORIGIN: 'garbage', DOHC_SERVER_NETWORK_ACCESS: 'private', BETTER_AUTH_SECRET: 'change-me'};
  assert.ok(validateSettings(invalid).some(error => error.includes('BETTER_AUTH_SECRET')));
  assert.ok(validateSettings(parseEnv(readFileSync('.env.self-host.example', 'utf8'))).length > 0);
});

test('server automations default on and accept an explicit opt-out', () => {
  assert.equal(settings().DOHC_RELAY_AUTOMATIONS, '1');
  assert.equal(compose.services['sync-relay'].environment.DOHC_RELAY_AUTOMATIONS, '${DOHC_RELAY_AUTOMATIONS:-1}');
  for (const value of [undefined, '0', '1']) assert.deepEqual(validateSettings({...settings(), DOHC_RELAY_AUTOMATIONS: value}), []);
  for (const value of ['', 'true', '2']) {
    assert.ok(validateSettings({...settings(), DOHC_RELAY_AUTOMATIONS: value}).some(error => error.includes('DOHC_RELAY_AUTOMATIONS to 0 or 1')));
  }
});

test('app publications use one opt-in setting', () => {
  assert.equal(settings().DOHC_RELAY_APP_PUBLICATIONS, '0');
  assert.equal(compose.services['sync-relay'].environment.DOHC_RELAY_APP_PUBLICATIONS, '${DOHC_RELAY_APP_PUBLICATIONS:-0}');
  assert.deepEqual(validateSettings({...settings(), DOHC_RELAY_APP_PUBLICATIONS: '1'}), []);
  assert.ok(validateSettings({...settings(), DOHC_RELAY_APP_PUBLICATIONS: 'true'}).some(error => error.includes('DOHC_RELAY_APP_PUBLICATIONS to 0 or 1')));
});

test('app participant limit reaches the relay and validates positive safe integers', () => {
  assert.equal(settings().DOHC_RELAY_APP_BACKEND_MAX_PARTICIPANTS_PER_GRANT, '1000');
  assert.equal(compose.services['sync-relay'].environment.DOHC_RELAY_APP_BACKEND_MAX_PARTICIPANTS_PER_GRANT, '${DOHC_RELAY_APP_BACKEND_MAX_PARTICIPANTS_PER_GRANT:-1000}');
  for (const value of [undefined, '1', '2500', '9007199254740991']) {
    assert.deepEqual(validateSettings({...settings(),DOHC_RELAY_APP_BACKEND_MAX_PARTICIPANTS_PER_GRANT:value}),[]);
  }
  for (const value of ['', '0', '-1', '1.5', '1e3', ' 1', '01', '9007199254740992']) {
    assert.ok(validateSettings({...settings(),DOHC_RELAY_APP_BACKEND_MAX_PARTICIPANTS_PER_GRANT:value}).some(error=>error.includes('MAX_PARTICIPANTS_PER_GRANT')));
  }
});

test('sign-up stays open by default and asks the relay about invites on the internal network', () => {
  assert.equal(settings().DOHC_SIGN_UP_EMAILS, '');
  const api = compose.services['workspace-api'].environment;
  assert.equal(api.DOHC_SIGN_UP_EMAILS, '${DOHC_SIGN_UP_EMAILS:-}');
  assert.equal(api.WORKSPACE_API_RELAY_URL, `http://sync-relay:${compose.services['sync-relay'].environment.SYNC_RELAY_PORT}`);
  assert.equal(api.BETTER_AUTH_SECRET, compose.services['sync-relay'].environment.BETTER_AUTH_SECRET);
});

test('private mode selects the private-only gateway overlay and the real env file', () => {
  const args = composeArgs('.env.self-host', {...settings(), DOHC_SERVER_NETWORK_ACCESS: 'private'}, 'up');
  assert.ok(args.includes('tools/self-host/compose.private.yml'));
  assert.ok(args.some(value => value.endsWith('.env.self-host')));
  assert.ok(!args.some(value => value.endsWith('.env.self-host.example')));
  assert.match(readFileSync('tools/self-host/compose.private.yml', 'utf8'), /127\.0\.0\.1/);
});

test('hourly snapshots read the relay read-only, never mount continuity, and start only with off-site storage', () => {
  const service = compose.services['relay-snapshot'];
  assert.deepEqual(service.profiles, ['snapshots']);
  assert.deepEqual(service.volumes, ['dohc_self_host_sync_relay:/data:ro', 'dohc_self_host_snapshots:/snapshots']);
  assert.ok(!JSON.stringify(service).includes('continuity'));
  assert.equal(service.read_only, true);
  assert.equal(service.depends_on['sync-relay'].condition, 'service_healthy');
  assert.ok(!Object.keys(compose.services['sync-relay'].environment).some(name => name.startsWith('DOHC_SNAPSHOT_')));
  // Outbound only: its own network, shared with no service, so Postgres, workspace-api and the relay are unreachable.
  assert.deepEqual(service.networks, ['snapshots']);
  assert.deepEqual(compose.networks.snapshots, {});
  for (const [name, other] of Object.entries(compose.services)) if (name !== 'relay-snapshot') assert.ok(!JSON.stringify(other.networks ?? []).includes('snapshots'), name);
  for (const overlay of ['private', 'cloudflare', 'external-postgres', 'data-disk']) {
    const text = readFileSync(`tools/self-host/compose.${overlay}.yml`, 'utf8');
    assert.ok(!/relay-snapshot|networks:/.test(text), overlay);
  }
  assert.ok(!composeArgs('.env.self-host', settings(), 'up').includes('--profile'));
  const enabled = composeArgs('.env.self-host', { ...settings(), DOHC_SNAPSHOT_S3_BUCKET: 'dohc-snapshots', DOHC_DATA_DIRECTORY: '/mnt/disk/dohc' }, 'up');
  assert.ok(enabled.indexOf('tools/self-host/compose.data-disk.yml') < enabled.indexOf('--profile'));
  assert.deepEqual(enabled.slice(enabled.indexOf('--profile'), enabled.indexOf('--profile') + 3), ['--profile', 'snapshots', 'up']);
});

// Compose interpolates every service, including those whose profile is off, so a required value here would stop every deployment.
test('a deployment without snapshots starts without a snapshot key', () => {
  const required = /\$\{DOHC_SNAPSHOT_[A-Z0-9_]*:\?/;
  assert.ok(!required.test(composeText));
  for (const file of ['compose.data-disk.yml', 'compose.private.yml', 'compose.external-postgres.yml', 'compose.cloudflare.yml']) {
    assert.ok(!required.test(readFileSync(`tools/self-host/${file}`, 'utf8')), file);
  }
  assert.equal(compose.services['relay-snapshot'].environment.DOHC_SNAPSHOT_KEY, '${DOHC_SNAPSHOT_KEY:-}');
  for (const key of [undefined, '']) assert.deepEqual(validateSettings({ ...settings(), DOHC_SNAPSHOT_KEY: key }), [], String(key));
});

test('bootstrap generates a snapshot key and settings refuse snapshot storage without a key or with partial settings', () => {
  assert.match(settings().DOHC_SNAPSHOT_KEY, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(validateSettings({ ...settings(), DOHC_SNAPSHOT_KEY: 'change-me' }).some(error => error.includes('DOHC_SNAPSHOT_KEY')));
  const storage = { DOHC_SNAPSHOT_S3_ENDPOINT: 'https://account.r2.cloudflarestorage.com', DOHC_SNAPSHOT_S3_BUCKET: 'dohc-snapshots',
    DOHC_SNAPSHOT_S3_ACCESS_KEY_ID: 'id', DOHC_SNAPSHOT_S3_SECRET_ACCESS_KEY: 'secret', DOHC_SNAPSHOT_ALERT_EMAIL: 'ops@team.invalid' };
  assert.deepEqual(validateSettings({ ...settings(), ...storage }), []);
  for (const key of [undefined, '']) {
    assert.deepEqual(validateSettings({ ...settings(), ...storage, DOHC_SNAPSHOT_KEY: key }),
      ['Set DOHC_SNAPSHOT_KEY to the key that bootstrap generated, or clear every DOHC_SNAPSHOT_S3_ value to turn off snapshot upload.'], String(key));
  }
  assert.deepEqual(validateSettings({ ...settings(), ...storage, DOHC_SNAPSHOT_HEARTBEAT_URL: 'https://heartbeat.invalid/ping' }), []);
  assert.ok(validateSettings({ ...settings(), ...storage, DOHC_SNAPSHOT_S3_SECRET_ACCESS_KEY: '' }).some(error => error.includes('DOHC_SNAPSHOT_S3_SECRET_ACCESS_KEY')));
  assert.ok(validateSettings({ ...settings(), ...storage, DOHC_SNAPSHOT_ALERT_EMAIL: '' }).some(error => error.includes('DOHC_SNAPSHOT_ALERT_EMAIL')));
  assert.ok(validateSettings({ ...settings(), ...storage, DOHC_SNAPSHOT_S3_ENDPOINT: 'http://storage.invalid' }).some(error => error.includes('HTTPS origin')));
  assert.ok(validateSettings({ ...settings(), DOHC_SNAPSHOT_HEARTBEAT_URL: 'http://heartbeat.invalid' }).some(error => error.includes('HEARTBEAT')));
});

test('a data directory selects the data-disk overlay for relay, continuity, host data and snapshot staging only', () => {
  assert.ok(!composeArgs('.env.self-host', settings(), 'up').includes('tools/self-host/compose.data-disk.yml'));
  const args = composeArgs('.env.self-host', {...settings(), DOHC_SERVER_NETWORK_ACCESS: 'private', DOHC_DATA_DIRECTORY: '/mnt/disk/dohc'}, 'up');
  assert.ok(args.indexOf('tools/self-host/compose.private.yml') < args.indexOf('tools/self-host/compose.data-disk.yml'));
  assert.ok(args.indexOf('tools/self-host/compose.data-disk.yml') < args.indexOf('up'));
  const overlay = load(readFileSync('tools/self-host/compose.data-disk.yml', 'utf8'), { schema: YAML11_SCHEMA });
  assert.deepEqual(Object.keys(overlay), ['services', 'volumes']);
  // The data-disk check runs in relay-initialize, so it must see host data and snapshot state too; it never writes them.
  assert.deepEqual(overlay.services, {'relay-initialize': {volumes: ['dohc_self_host_host_data:/host-data:ro', 'dohc_self_host_snapshots:/snapshots:ro']}});
  const folders = {dohc_self_host_sync_relay: 'sync-relay', dohc_self_host_relay_continuity: 'continuity', dohc_self_host_host_data: 'host-data',
    dohc_self_host_snapshots: 'snapshots'};
  assert.deepEqual(Object.keys(overlay.volumes), Object.keys(folders));
  for (const [name, folder] of Object.entries(folders)) {
    assert.ok(Object.hasOwn(compose.volumes, name));
    // A bound volume fails to mount when its folder is missing; Docker never creates it.
    assert.deepEqual(overlay.volumes[name], {driver: 'local', driver_opts: {type: 'none', o: 'bind',
      device: `\${DOHC_DATA_DIRECTORY:?Set DOHC_DATA_DIRECTORY}/${folder}`}});
  }
  assert.deepEqual(compose.services.postgres.volumes, ['dohc_self_host_postgres:/var/lib/postgresql/data']);
});

test('existing volumes stored anywhere but the configured disk folder are refused without changing them', () => {
  const device = '/mnt/disk/dohc/continuity', options = {type: 'none', o: 'bind', device};
  const config = {volumes: {dohc_self_host_postgres: {name: 'p_postgres'}, dohc_self_host_relay_continuity: {name: 'p_continuity', driver: 'local', driver_opts: options}}};
  const check = (existing, missing = {status: 1, stdout: '', stderr: 'Error response from daemon: get p_continuity: no such volume'}) => {
    const calls = [];
    const errors = dataDiskVolumeErrors(config, args => {
      calls.push(args);
      return existing ? {status: 0, stdout: JSON.stringify([{Name: args[2], ...existing}])} : missing;
    });
    assert.deepEqual(calls, [['volume', 'inspect', 'p_continuity']]);
    return errors;
  };
  assert.deepEqual(check(undefined), []);
  // Only Docker's own answer establishes that a volume is absent.
  for (const failure of [{status: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon.'}, {status: null, stdout: ''}]) {
    assert.throws(() => check(undefined, failure), /Docker could not inspect volume p_continuity/);
  }
  assert.deepEqual(check({Driver: 'local', Options: {...options}}), []);
  assert.match(check({Driver: 'local', Options: null}).join(), /p_continuity keeps its data in Docker storage, not \/mnt\/disk\/dohc\/continuity\. Restore the previous DOHC_DATA_DIRECTORY/);
  assert.match(check({Driver: 'local', Options: {...options, device: '/mnt/old/dohc/continuity'}}).join(), /keeps its data in \/mnt\/old\/dohc\/continuity, not/);
  assert.equal(check({Driver: 'other', Options: {...options}}).length, 1);
});

// Runs the relay deployment check against in-memory folders, with the status and output `node -e` would give.
function relayCheck(files, unreadable = false) {
  const fs = {statSync: path => files.includes(path) ? {} : undefined, readdirSync: folder => {
    if (unreadable) throw Object.assign(new Error('permission denied'), {code: 'EACCES'});
    return files.filter(path => path.startsWith(`${folder}/`));
  }};
  const process = {exitCode: 0}, output = [];
  try {
    new Function('require', 'process', 'console', relayDeploymentCheck)(() => fs, process, {error() {}, log: line => output.push(line)});
  } catch { return {status: 1, stdout: ''}; }
  return {status: process.exitCode, stdout: output.map(line => `${line}\n`).join('')};
}

test('only the first start of a data-disk deployment may initialize its relay', () => {
  const settings = {DOHC_DATA_DIRECTORY: '/mnt/disk/dohc'};
  const record = '/continuity/deployment.json', database = '/data/sync-relay.sqlite', hostData = '/host-data/automations/replica.db';
  const snapshotState = '/snapshots/notifications.json';
  const result = (check, firstStart) => relayDeploymentError('.env.self-host', settings, args => {
    assert.ok(args.includes('tools/self-host/compose.data-disk.yml') && args.includes('relay-initialize'));
    return check;
  }, firstStart);
  const found = relayCheck([record, database]), empty = relayCheck([]);
  // A later start accepts empty host data: documents rebuild from the relay (claims in progress do not, #2016).
  assert.equal(result(found, false), '');
  assert.equal(result(relayCheck([record, database, hostData]), false), '');
  assert.equal(result(relayCheck([record, database, snapshotState]), false), '');
  assert.equal(result(empty, true), '');
  // Snapshot state is not relay data, so it never stands in for a deployment.
  for (const files of [[], [hostData], [snapshotState], [hostData, snapshotState]]) {
    assert.match(result(relayCheck(files), false), /No relay deployment found in \/mnt\/disk\/dohc\. Mount the data disk there and try again\. Never recreate its folders/);
  }
  const refusals = [
    [[record, database], '/mnt/disk/dohc/sync-relay, /mnt/disk/dohc/continuity already hold data'],
    [[record, database, hostData], '/mnt/disk/dohc/sync-relay, /mnt/disk/dohc/continuity, /mnt/disk/dohc/host-data already hold data'],
    [[record], '/mnt/disk/dohc/continuity already holds data'], [[database], '/mnt/disk/dohc/sync-relay already holds data'],
    [['/continuity/history/continuity.sqlite'], '/mnt/disk/dohc/continuity already holds data'],
    [[database, snapshotState], '/mnt/disk/dohc/sync-relay, /mnt/disk/dohc/snapshots already hold data'],
  ];
  for (const [files, holding] of refusals) {
    assert.equal(result(relayCheck(files), true), `${holding}. A first start needs empty disk folders. Start without --first-start.`, files.join());
  }
  // Leftover host data alone still refuses a first start, which would otherwise run on another deployment's host state.
  assert.equal(result(relayCheck([hostData]), true), '/mnt/disk/dohc/host-data already holds data. A first start needs empty disk folders. ' +
    'Check that DOHC_DATA_DIRECTORY names a new deployment folder.');
  assert.equal(result(relayCheck([snapshotState]), true), '/mnt/disk/dohc/snapshots already holds data. A first start needs empty disk folders. ' +
    'Check that DOHC_DATA_DIRECTORY names a new deployment folder.');
  for (const files of [[record], [database]]) {
    assert.match(result(relayCheck(files), false), /The relay deployment in \/mnt\/disk\/dohc is missing its record or its database/, files.join());
  }
  // A failed check never reads as an empty disk or a found deployment.
  for (const check of [relayCheck([], true), {status: 1, stdout: ''}, {status: 125, stdout: ''}, {status: null}, {status: 0, stdout: ''},
    {status: 0, stdout: 'Creating network\n'}, {status: 1, stdout: empty.stdout}, {status: 0, stdout: '{"deployment":false,"holding":["other"]}\n'}]) {
    for (const firstStart of [false, true]) assert.match(result(check, firstStart), /Could not check the data disk in \/mnt\/disk\/dohc/, JSON.stringify(check));
  }
});

test('every later start needs an accounts database, checked before any container mounts its volume', () => {
  const config = {services: {postgres: {image: 'postgres:17.9-alpine'}}, volumes: {dohc_self_host_postgres: {name: 'p_postgres'}}};
  const check = (inspect, probe) => {
    const calls = [];
    const error = accountsDatabaseError('.env.self-host', {}, config, args => {
      calls.push(args);
      return args[0] === 'volume' ? inspect : probe;
    });
    return {error, probed: calls.some(args => args[0] === 'run')};
  };
  const exists = {status: 0, stdout: JSON.stringify([{Name: 'p_postgres', Driver: 'local'}])};
  assert.deepEqual(check(exists, {status: 0, stdout: 'present\n'}), {error: '', probed: true});
  assert.match(check(exists, {status: 0, stdout: 'missing\n'}).error, /p_postgres holds no accounts database\. Restore it/);
  const absent = check({status: 1, stderr: 'Error: No such volume: p_postgres'}, {status: 0, stdout: 'present\n'});
  assert.equal(absent.probed, false);
  assert.match(absent.error, /holds no accounts database/);
  // Docker exits 1 for a failed attach, so only the probe's own output decides.
  for (const probe of [{status: 1, stdout: ''}, {status: 1, stdout: 'missing\n'}, {status: 0, stdout: ''}, {status: 125, stdout: ''}, {status: 126}, {status: null}]) {
    assert.match(check(exists, probe).error, /Could not check Docker volume p_postgres/, JSON.stringify(probe));
  }
  assert.throws(() => check({status: 1, stderr: 'Cannot connect to the Docker daemon.'}, {status: 0}), /Docker could not inspect volume p_postgres/);
});

const RESET = Symbol('!reset');
const overlaySchema = YAML11_SCHEMA.withTags(defineScalarTag('!reset', {resolve: () => RESET}),
  defineMappingTag('!reset', {create: () => RESET, addPair: () => '', has: () => false, keys: () => [], get: () => undefined}));
const externalOverlay = () => load(readFileSync('tools/self-host/compose.external-postgres.yml', 'utf8'), { schema: overlaySchema });
const external = () => ({...settings(), DOHC_POSTGRES_HOST: 'db.provider.invalid', DOHC_POSTGRES_PORT: '25060',
  DOHC_POSTGRES_CA_FILE: '/etc/dohc/provider-ca.pem', POSTGRES_PASSWORD: 'provider-password'});

test('an external database leaves out the bundled database, its volume and every wait on it', () => {
  assert.ok(!composeArgs('.env.self-host', settings(), 'up').includes('tools/self-host/compose.external-postgres.yml'));
  const args = composeArgs('.env.self-host', {...external(), DOHC_DATA_DIRECTORY: '/mnt/disk/dohc'}, 'up');
  assert.ok(args.indexOf('tools/self-host/compose.data-disk.yml') < args.indexOf('tools/self-host/compose.external-postgres.yml'));
  assert.ok(args.indexOf('tools/self-host/compose.external-postgres.yml') < args.indexOf('up'));
  const overlay = externalOverlay();
  assert.equal(overlay.services.postgres, RESET);
  assert.deepEqual(overlay.volumes, {dohc_self_host_postgres: RESET});
  // These are the only references to the bundled database in the base file, and the overlay resets each one.
  assert.deepEqual(Object.keys(compose.services).filter(name => compose.services[name].depends_on?.postgres), ['postgres-migrate']);
  assert.equal(overlay.services['postgres-migrate'].depends_on, RESET);
  assert.deepEqual(Object.keys(compose.services).filter(name => (compose.services[name].volumes ?? []).some(volume => String(volume).startsWith('dohc_self_host_postgres:'))), ['postgres']);
  // Every service that connects to the database gets the external host and the provider's CA certificate.
  const clients = Object.keys(compose.services).filter(name => name !== 'postgres' && compose.services[name].environment?.POSTGRES_PASSWORD);
  assert.deepEqual(clients, ['postgres-migrate', 'workspace-api', 'sync-relay']);
  assert.deepEqual(Object.keys(overlay.services).filter(name => !['postgres', 'relay-initialize'].includes(name)), clients);
  // Relay setup waits for migrations, so a first start whose migrations fail leaves the relay volumes empty for a retry.
  assert.deepEqual(overlay.services['relay-initialize'], {depends_on: {'postgres-migrate': {condition: 'service_completed_successfully'}}});
  for (const name of clients) {
    assert.deepEqual(overlay.services[name].environment, {DOHC_POSTGRES_HOST: '${DOHC_POSTGRES_HOST:?Set DOHC_POSTGRES_HOST}',
      DOHC_POSTGRES_PORT: '${DOHC_POSTGRES_PORT:?Set DOHC_POSTGRES_PORT}'});
    // Docker creates a missing source path as an empty folder unless the mount forbids it.
    assert.deepEqual(overlay.services[name].volumes, [{type: 'bind', source: '${DOHC_POSTGRES_CA_FILE:?Set DOHC_POSTGRES_CA_FILE}',
      target: '/etc/dohc/postgres-ca.pem', read_only: true, bind: {create_host_path: false}}]);
  }
});

// The parser reads the CA certificate that the overlay mounts in each service.
const providerCa = t => {
  const read = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (path, ...rest) => path === '/etc/dohc/postgres-ca.pem' ? 'provider CA' : read(path, ...rest));
};

test('services reach an external database only over TLS that verifies its certificate against the provider CA', t => {
  providerCa(t);
  const env = {POSTGRES_USER: 'dohc admin', POSTGRES_PASSWORD: 'p@ss/word?#', POSTGRES_DB: 'dohc'};
  assert.equal(postgresUrl(env), 'postgres://dohc%20admin:p%40ss%2Fword%3F%23@postgres:5432/dohc');
  const url = new URL(postgresUrl({...env, DOHC_POSTGRES_HOST: 'db.provider.invalid', DOHC_POSTGRES_PORT: '25060'}));
  assert.equal(url.host, 'db.provider.invalid:25060');
  assert.equal(decodeURIComponent(url.password), 'p@ss/word?#');
  assert.deepEqual([...url.searchParams], [['sslmode', 'verify-full'], ['sslrootcert', externalOverlay().services['workspace-api'].volumes[0].target]]);
});

test("every accepted database and user name reaches the clients' parser unchanged, and no other does", t => {
  providerCa(t);
  const env = {...external(), POSTGRES_PASSWORD: 'p@ss/word?#%'};
  for (const name of ['dohc', 'defaultdb', 'postgres.abcdefgh', 'neon_db-1', 'a..b']) {
    for (const key of ['POSTGRES_DB', 'POSTGRES_USER']) {
      assert.deepEqual(validateSettings({...env, [key]: name}), [], `${key}=${name}`);
      for (const target of [env, {...env, DOHC_POSTGRES_HOST: ''}]) assert.ok(postgresUrl({...target, [key]: name}));
    }
  }
  // Each of these would select another database: ".." and "." drop out of the path, and the rest come back still encoded.
  for (const name of ['.', '..', 'dohc/accounts', 'dohc?x', 'dohc#x']) {
    for (const target of [env, settings()]) assert.ok(validateSettings({...target, POSTGRES_DB: name}).some(error => error.includes('Use only letters') && error.includes('POSTGRES_DB')), name);
    for (const target of [env, {...env, DOHC_POSTGRES_HOST: ''}]) assert.throws(() => postgresUrl({...target, POSTGRES_DB: name}), /do not survive the connection URL/, name);
  }
  // A host that carries a path, query or fragment would change the database or turn TLS off.
  for (const host of ['db.provider.invalid:5432/dohc?sslmode=disable&unused=', 'db.provider.invalid/dohc?sslmode=disable#', 'user@db.provider.invalid']) {
    assert.throws(() => postgresUrl({...env, DOHC_POSTGRES_HOST: host}), /do not survive the connection URL/, host);
  }
});

test('an external database needs its host, port, names that survive its connection URL, and CA certificate', () => {
  assert.deepEqual(validateSettings(external()), []);
  // The provider sets an external database's password, so only the bundled one needs the generated length.
  assert.ok(validateSettings({...settings(), POSTGRES_PASSWORD: 'provider-password'}).some(error => error.includes('POSTGRES_PASSWORD must contain')));
  assert.ok(validateSettings({...external(), POSTGRES_PASSWORD: 'change-me'}).some(error => error.includes('Set POSTGRES_PASSWORD.')));
  const refusals = {
    DOHC_POSTGRES_HOST: ['', 'db.example.com', '-db.invalid', 'db..invalid', 'user@db.invalid', 'db.invalid:5432', 'db.invalid/dohc?sslmode=disable', '[::1]'],
    DOHC_POSTGRES_PORT: [undefined, '', '0', '05432', '65536', '5432x', ' 5432'],
    DOHC_POSTGRES_CA_FILE: [undefined, '', 'provider-ca.pem', './ca.pem', '/etc/../ca.pem', '/etc/dohc/ca pem', 'C:/ca.pem'],
    POSTGRES_DB: [undefined, '', '.', '..', '...', 'dohc/accounts', 'dohc?x', 'dohc#x', 'dohc accounts', 'dohc%2Faccounts'],
    POSTGRES_USER: [undefined, '', '..', 'dohc@provider', 'dohc:admin', 'dohc admin'],
  };
  for (const [name, values] of Object.entries(refusals)) {
    for (const value of values) assert.ok(validateSettings({...external(), [name]: value}).some(error => error.includes(name)), `${name}=${value}`);
  }
  // A port or CA certificate without a host would quietly keep the bundled database.
  for (const name of ['DOHC_POSTGRES_PORT', 'DOHC_POSTGRES_CA_FILE']) {
    assert.ok(validateSettings({...settings(), [name]: external()[name]}).some(error => error.includes('Set DOHC_POSTGRES_HOST to use an external database')), name);
  }
});

test('a later start with an external database needs dohc accounts there, checked through the migration service', () => {
  const check = reply => {
    const calls = [];
    // No Compose configuration: the check never inspects or mounts a local accounts volume.
    const error = accountsDatabaseError('.env.self-host', external(), undefined, args => { calls.push(args); return reply; });
    assert.equal(calls.length, 1);
    assert.ok(calls[0].includes('tools/self-host/compose.external-postgres.yml'));
    assert.deepEqual(calls[0].slice(calls[0].indexOf('run')), ['run', '--rm', '--no-deps', '-T', 'postgres-migrate', 'check-accounts']);
    return error;
  };
  assert.equal(check({status: 0, stdout: 'present\n'}), '');
  assert.match(check({status: 0, stdout: 'missing\n'}), /Database dohc on db\.provider\.invalid holds no dohc accounts\. .*Without it, people sign up again/);
  // Docker exits 1 for some of its own failures, so only the check's own output decides.
  for (const reply of [{status: 1, stdout: 'present\n'}, {status: 1, stdout: ''}, {status: 0, stdout: ''}, {status: 125, stdout: ''}, {status: null}]) {
    assert.match(check(reply), /Could not check database dohc on db\.provider\.invalid/, JSON.stringify(reply));
  }
});

test('the accounts check finds dohc accounts only where migrations recorded an applied id', async () => {
  const client = (table, applied) => ({ async query(sql) {
    if (sql === "select to_regclass('dohc_migrations') is not null as present") return {rows: [{present: table}]};
    assert.ok(table, 'queried a table that does not exist');
    assert.equal(sql, 'select exists (select 1 from dohc_migrations) as present');
    return {rows: [{present: applied}]};
  } });
  assert.equal(await accountsSchemaState(client(false, false)), 'missing');
  assert.equal(await accountsSchemaState(client(true, false)), 'missing');
  assert.equal(await accountsSchemaState(client(true, true)), 'present');
});

// Runs the start checks with an external database on Docker volumes. `calls` names each service a check ran.
const externalChecks = (options, {accounts = 'missing', relay = relayCheck([])} = {}) => {
  const calls = [];
  const checks = deploymentChecks('.env.self-host', external(), args => {
    assert.ok(args.includes('tools/self-host/compose.external-postgres.yml') && !args.includes('tools/self-host/compose.data-disk.yml'));
    if (args.includes('check-accounts')) { calls.push('check-accounts'); return {status: 0, stdout: `${accounts}\n`}; }
    if (args.includes('relay-initialize')) { calls.push('relay-initialize'); return relay; }
    throw new Error(`Unexpected Docker call: ${args.join(' ')}`);
  }, options);
  return {checks, calls};
};

const deployed = relayCheck(['/continuity/deployment.json', '/data/sync-relay.sqlite']);

test('with an external database, every start but the first refuses an empty database before Compose starts it', () => {
  const later = {start: true, firstStart: false};
  const refused = externalChecks(later, {relay: deployed}).checks;
  assert.deepEqual(refused.map(([name]) => name), ['relay deployment', 'accounts database']);
  assert.match(refused[1][1], /holds no dohc accounts/);
  assert.deepEqual(externalChecks(later, {accounts: 'present', relay: deployed}),
    {checks: [['relay deployment', ''], ['accounts database', '']], calls: ['relay-initialize', 'check-accounts']});
  assert.deepEqual(externalChecks({start: true, firstStart: true}), {checks: [['relay deployment', '']], calls: ['relay-initialize']});
  assert.deepEqual(externalChecks({start: false, firstStart: false}), {checks: [], calls: []});
  // Without an external database or a data disk, a start checks neither, as before.
  assert.deepEqual(deploymentChecks('.env.self-host', settings(), () => assert.fail('Docker ran'), later), []);
});

test('a first start with an external database refuses relay Docker volumes that already hold relay data', () => {
  const firstStart = {start: true, firstStart: true};
  for (const files of [['/continuity/deployment.json', '/data/sync-relay.sqlite'], ['/continuity/deployment.json'], ['/continuity/history/continuity.sqlite']]) {
    // Fresh accounts in the new database would not own the existing relay data, so the accounts check never runs.
    assert.deepEqual(externalChecks(firstStart, {relay: relayCheck(files)}), {calls: ['relay-initialize'],
      checks: [['relay deployment', "The relay's Docker volumes already hold relay data. Start without --first-start."]]}, files.join());
  }
  for (const relay of [relayCheck([], true), {status: 1, stdout: ''}, {status: 125, stdout: ''}, {status: null}, {status: 0, stdout: ''}]) {
    assert.deepEqual(externalChecks(firstStart, {relay}).checks,
      [['relay deployment', "Could not check the relay's Docker volumes. Check that Docker is running, then try again."]], JSON.stringify(relay));
  }
});

test('a later start with an external database refuses relay Docker volumes without the relay deployment', () => {
  const later = {start: true, firstStart: false};
  // Empty volumes on a new host, or after relay setup failed: setup would create a new relay deployment under the existing accounts.
  // Only a deliberate first start, which finds the volumes empty, creates one.
  assert.deepEqual(externalChecks(later, {accounts: 'present'}), {calls: ['relay-initialize'], checks: [['relay deployment',
    "The relay's Docker volumes hold no relay deployment. Start on the host that holds them. " +
    'Start with --first-start only to create a new relay deployment that holds none of the existing workspaces.']]});
  assert.deepEqual(externalChecks({start: true, firstStart: true}, {accounts: 'present'}).checks, [['relay deployment', '']]);
  for (const files of [['/continuity/deployment.json'], ['/data/sync-relay.sqlite']]) {
    assert.deepEqual(externalChecks(later, {accounts: 'present', relay: relayCheck(files)}).checks, [['relay deployment',
      "The relay deployment in the relay's Docker volumes is missing its record or its database. Keep the volumes unchanged and check that this host ran the deployment."]], files.join());
  }
  for (const relay of [relayCheck([], true), {status: 1, stdout: ''}, {status: 0, stdout: ''}]) {
    assert.deepEqual(externalChecks(later, {accounts: 'present', relay}).checks,
      [['relay deployment', "Could not check the relay's Docker volumes. Check that Docker is running, then try again."]], JSON.stringify(relay));
  }
});

test('the data directory must be an absolute folder without parent segments', () => {
  for (const value of [undefined, '', '/mnt/disk/dohc', '/mnt/HC_Volume_1234/dohc.data']) {
    assert.deepEqual(validateSettings({...settings(), DOHC_DATA_DIRECTORY: value}), []);
  }
  for (const value of ['relative/dohc', '/', '/mnt/disk/', '/mnt/../etc', '/mnt/./disk', '/mnt/disk,dohc', '/mnt/disk dohc', 'C:/dohc']) {
    assert.ok(validateSettings({...settings(), DOHC_DATA_DIRECTORY: value}).some(error => error.includes('DOHC_DATA_DIRECTORY')), value);
  }
});

test('every gateway refuses internal paths before proxy handles', () => {
  for (const file of ['Caddyfile', 'Caddyfile.private', 'Caddyfile.cloudflare']) {
    const config = readFileSync(`tools/self-host/${file}`, 'utf8');
    assert.match(config, /@internal path \/internal\/\*\s+handle @internal \{\s+respond 404\s+\}/);
    assert.ok(config.indexOf('handle @internal') < config.indexOf('handle @account'));
    assert.ok(config.indexOf('handle @internal') < config.indexOf('handle @relay'));
    assert.ok(config.indexOf('handle @internal') < config.indexOf('handle {'));
  }
  assert.equal(compose.services['share-web'].environment.DOHC_SHARE_WEB_INTERNAL_HOSTS, 'share-web:1790');
});

test('automatic initialization cannot overwrite orphaned data or continuity', () => {
  const root = mkdtempSync(join(tmpdir(), 'dohc-bootstrap-'));
  try {
    const data = join(root, 'data'), continuity = join(root, 'continuity'), config = join(continuity, 'deployment.json');
    mkdirSync(data); mkdirSync(continuity);
    assert.equal(relayInitializationRequired(config, data, continuity), true);
    writeFileSync(join(data, 'sync-relay.sqlite'), 'existing');
    assert.throws(() => relayInitializationRequired(config, data, continuity), /Preserve both volumes/);
    writeFileSync(config, '{}');
    assert.equal(relayInitializationRequired(config, data, continuity), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
