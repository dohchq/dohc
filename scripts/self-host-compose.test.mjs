import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import test from 'node:test';
import { load, YAML11_SCHEMA } from 'js-yaml';
import { initialSettings, privateRouteInstructions } from '../tools/self-host/bootstrap.mjs';
import { validateSettings, composeArgs } from '../tools/self-host/config.mjs';
import { relayInitializationRequired } from '../tools/self-host/entrypoint.mjs';

const composeText = readFileSync('docker-compose.self-host.yml', 'utf8');
const compose = load(composeText, { schema: YAML11_SCHEMA });
const settings = () => ({ ...parseEnv(readFileSync('.env.self-host.example', 'utf8')),
  ...initialSettings({ origin: 'https://dohc.team.invalid', image: 'dohc-self-host:v1' }),
  DOHC_SMTP_HOST: 'mail.team.invalid', DOHC_SMTP_FROM: 'dohc@team.invalid' });

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

test('diagnostics reject placeholders and invalid origins without revealing secrets', () => {
  assert.deepEqual(validateSettings(settings()), []);
  const invalid = {...settings(), DOHC_PUBLIC_ORIGIN: 'garbage', DOHC_SERVER_NETWORK_ACCESS: 'private', BETTER_AUTH_SECRET: 'change-me'};
  assert.ok(validateSettings(invalid).some(error => error.includes('BETTER_AUTH_SECRET')));
  assert.ok(validateSettings(parseEnv(readFileSync('.env.self-host.example', 'utf8'))).length > 0);
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
