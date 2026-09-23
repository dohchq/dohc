import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import test from 'node:test';
import { load, YAML11_SCHEMA } from 'js-yaml';
import { initialSettings, privateRouteInstructions, updateImageSetting } from '../tools/self-host/bootstrap.mjs';
import { validateSettings, composeArgs, supportedComposeVersion } from '../tools/self-host/config.mjs';
import { relayInitializationRequired } from '../tools/self-host/entrypoint.mjs';

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

test('database readiness waits for TCP after the temporary initialization server stops', () => {
  assert.match(compose.services.postgres.healthcheck.test[1], /pg_isready\s+-h\s+127\.0\.0\.1\s/);
  assert.equal(compose.services['postgres-migrate'].depends_on.postgres.condition, 'service_healthy');
});

test('auth, relay, and share links advertise the same public origin and exchange key', () => {
  const api = compose.services['workspace-api'].environment, relay = compose.services['sync-relay'].environment;
  const viewer = compose.services['share-web'].environment;
  assert.equal(api.WORKSPACE_API_BASE_URL, api.DOHC_SERVER_RELAY_URL);
  assert.equal(api.WORKSPACE_API_BASE_URL, viewer.DOHC_SHARE_WEB_PUBLIC_ORIGIN);
  assert.equal(api.WORKSPACE_API_BASE_URL, relay.SYNC_RELAY_AUTH_BASE_URL);
  assert.equal(relay.DOHC_RELAY_EXCHANGE_KEY, viewer.DOHC_SHARE_WEB_RELAY_EXCHANGE_KEY);
  assert.equal(relay.DOHC_RELAY_NAMED_LIVE_HOSTS, viewer.DOHC_SHARE_WEB_PUBLIC_HOSTS);
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

test('private mode selects the private-only gateway overlay and the real env file', () => {
  const args = composeArgs('.env.self-host', {...settings(), DOHC_SERVER_NETWORK_ACCESS: 'private'}, 'up');
  assert.ok(args.includes('tools/self-host/compose.private.yml'));
  assert.ok(args.some(value => value.endsWith('.env.self-host')));
  assert.ok(!args.some(value => value.endsWith('.env.self-host.example')));
  assert.match(readFileSync('tools/self-host/compose.private.yml', 'utf8'), /127\.0\.0\.1/);
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
