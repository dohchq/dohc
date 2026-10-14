import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { BlockList, isIP } from 'node:net';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import test from 'node:test';
import { defineSequenceTag, load, YAML11_SCHEMA } from 'js-yaml';
import { initialSettings } from '../../tools/self-host/bootstrap.mjs';
import { composeArgs, validateSettings } from '../../tools/self-host/config.mjs';
import { parseCloudflareRanges, refreshCloudflareRanges } from './refresh-cloudflare-ranges.mjs';

const read = path => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
const settings = () => ({ ...parseEnv(read('.env.self-host.example')),
  ...initialSettings({ origin: 'https://dohc.team.invalid', image: 'dohc-self-host:v1' }),
  DOHC_SMTP_HOST: 'mail.team.invalid', DOHC_SMTP_FROM: 'dohc@team.invalid' });

test('Cloudflare is opt-in and composes with the data disk and external database', () => {
  const baseline = composeArgs('.env.self-host', settings(), 'up');
  for (const value of [undefined, '0', '', 'true', '2']) {
    assert.deepEqual(composeArgs('.env.self-host', { ...settings(), DOHC_BEHIND_CLOUDFLARE: value }, 'up'), baseline);
  }
  assert.equal(settings().DOHC_BEHIND_CLOUDFLARE, '0');
  const args = composeArgs('.env.self-host', { ...settings(), DOHC_BEHIND_CLOUDFLARE: '1',
    DOHC_DATA_DIRECTORY: '/mnt/disk/dohc', DOHC_POSTGRES_HOST: 'db.provider.invalid' }, 'up', '-d');
  assert.deepEqual(args.slice(3), ['-f', 'docker-compose.self-host.yml', '-f', 'tools/self-host/compose.data-disk.yml',
    '-f', 'tools/self-host/compose.external-postgres.yml', '-f', 'tools/self-host/compose.cloudflare.yml', 'up', '-d']);
});

test('Cloudflare accepts only 0 or 1 and requires public mode', () => {
  for (const value of [undefined, '0', '1']) assert.deepEqual(validateSettings({ ...settings(), DOHC_BEHIND_CLOUDFLARE: value }), []);
  for (const value of ['', 'true', 'false', '2', ' 1']) {
    assert.ok(validateSettings({ ...settings(), DOHC_BEHIND_CLOUDFLARE: value }).some(error => error.includes('DOHC_BEHIND_CLOUDFLARE to 0 or 1')));
  }
  const privateSettings = { ...settings(), DOHC_PUBLIC_ORIGIN: 'https://machine.tail.ts.net',
    DOHC_PUBLIC_HOST: 'machine.tail.ts.net', DOHC_SERVER_NETWORK_ACCESS: 'private' };
  assert.deepEqual(validateSettings({ ...privateSettings, DOHC_BEHIND_CLOUDFLARE: '0' }), []);
  assert.ok(validateSettings({ ...privateSettings, DOHC_BEHIND_CLOUDFLARE: '1' }).some(error => error.includes('Cloudflare requires public mode')));
});

test('overlay replaces only gateway mounts, keeps certificate volumes and refuses missing config files', () => {
  const schema = YAML11_SCHEMA.withTags(defineSequenceTag('!override', { create: () => [], addItem: (items, value) => { items.push(value); } }));
  const overlay = load(read('tools/self-host/compose.cloudflare.yml'), { schema });
  assert.deepEqual(Object.keys(overlay), ['services']);
  assert.deepEqual(Object.keys(overlay.services), ['gateway']);
  assert.deepEqual(Object.keys(overlay.services.gateway), ['volumes']);
  assert.match(read('tools/self-host/compose.cloudflare.yml'), /volumes: !override/);
  assert.deepEqual(overlay.services.gateway.volumes, [
    { type: 'bind', source: './tools/self-host/Caddyfile.cloudflare', target: '/etc/caddy/Caddyfile',
      read_only: true, bind: { create_host_path: false } },
    { type: 'bind', source: './tools/self-host/cloudflare-proxies.caddy', target: '/etc/caddy/cloudflare-proxies.caddy',
      read_only: true, bind: { create_host_path: false } },
    'dohc_self_host_tls:/data', 'dohc_self_host_gateway_config:/config',
  ]);
});

test('gateway reads only the static Cloudflare trust file and CF-Connecting-IP, and overwrites X-Forwarded-For on every route', () => {
  const caddy = read('tools/self-host/Caddyfile.cloudflare');
  assert.match(caddy, /servers {\s+import \/etc\/caddy\/cloudflare-proxies\.caddy\s+client_ip_headers CF-Connecting-IP\s+}/);
  const proxies = [...caddy.matchAll(/reverse_proxy (\S+) {\s+header_up X-Forwarded-For {client_ip}\s+}/g)].map(match => match[1]);
  assert.deepEqual(proxies, ['workspace-api:1786', 'sync-relay:1788', 'share-web:1790']);
  assert.equal((caddy.match(/reverse_proxy /g) ?? []).length, proxies.length);
  // Removing address handling must leave the existing public gateway, including its TLS behavior, unchanged.
  assert.equal(caddy.replace(/  servers {[^}]+}\n/, '').replace(/reverse_proxy (\S+) {\s+header_up X-Forwarded-For {client_ip}\s+}/g, 'reverse_proxy $1'),
    read('tools/self-host/Caddyfile'));
});

test('shipped trust file parses as one static directive with valid IPv4 and IPv6 CIDRs, never all addresses', () => {
  const lines = read('tools/self-host/cloudflare-proxies.caddy').split('\n').filter(line => line.trim() && !line.startsWith('#'));
  assert.equal(lines.length, 1);
  const [directive, source, ...ranges] = lines[0].trim().split(/\s+/);
  assert.equal(directive, 'trusted_proxies');
  assert.equal(source, 'static');
  assert.ok(ranges.length > 0);
  const block = new BlockList(), families = new Set();
  for (const cidr of ranges) {
    const [address, prefix, extra] = cidr.split('/');
    const family = isIP(address);
    assert.ok(family === 4 || family === 6, cidr);
    assert.equal(extra, undefined);
    assert.match(prefix, /^[1-9]\d*$/, cidr);
    assert.ok(Number(prefix) <= (family === 4 ? 32 : 128), cidr);
    block.addSubnet(address, Number(prefix), family === 4 ? 'ipv4' : 'ipv6');
    families.add(family);
  }
  assert.deepEqual([...families].sort(), [4, 6]);
  assert.equal(block.check('173.245.48.5'), true);
  assert.equal(block.check('2606:4700::1', 'ipv6'), true);
  for (const peer of ['198.51.100.10', '127.0.0.1', '10.233.42.2']) assert.equal(block.check(peer), false);
  assert.equal(block.check('2001:db8::10', 'ipv6'), false);
});

test('range parser rejects empty lists, wrong families, invalid masks, non-IP text and universal trust', () => {
  assert.deepEqual(parseCloudflareRanges('173.245.48.0/20\r\n 103.21.244.0/22\n', 4), ['173.245.48.0/20', '103.21.244.0/22']);
  assert.deepEqual(parseCloudflareRanges('2606:4700::/32\n', 6), ['2606:4700::/32']);
  for (const [family, entries] of [
    [4, ['', ' \n', '<html>error</html>', '999.0.0.0/24', '173.245.48.0', '173.245.48.0/-1', '173.245.48.0/1.5',
      '173.245.48.0/33', '0.0.0.0/0', '173.245.48.0/020', '2606:4700::/32']],
    [6, ['', '2606:4700::/129', '::/0', 'invalid::ip/64', '2606:4700::%eth0/32', '173.245.48.0/20']],
  ]) {
    for (const value of entries) assert.throws(() => parseCloudflareRanges(value, family), /invalid.*CIDR/, value);
  }
  assert.deepEqual(parseCloudflareRanges('192.0.2.1/32', 4), ['192.0.2.1/32']);
  assert.deepEqual(parseCloudflareRanges('2001:db8::1/128', 6), ['2001:db8::1/128']);
});

test('refresh validates both successful HTTP responses before replacing the previous trust file', async () => {
  const folder = mkdtempSync(join(process.cwd(), '.cloudflare-test-')), output = join(folder, 'ranges.caddy');
  const old = 'previous valid ranges\n';
  try {
    const calls = [];
    await refreshCloudflareRanges({ output, fetch: async (url, options) => {
      calls.push(url);
      assert.ok(options.signal instanceof AbortSignal);
      return { ok: true, text: async () => url.endsWith('v4') ? '173.245.48.0/20\n' : '2606:4700::/32\n' };
    } });
    assert.deepEqual(calls, ['https://www.cloudflare.com/ips-v4', 'https://www.cloudflare.com/ips-v6']);
    assert.match(readFileSync(output, 'utf8'), /\ntrusted_proxies static 173\.245\.48\.0\/20 2606:4700::\/32\n$/);
    for (const failingUrl of calls) {
      for (const failure of ['http', 'empty', 'invalid', 'wrong-family', 'network']) {
        writeFileSync(output, old);
        await assert.rejects(refreshCloudflareRanges({ output, fetch: async url => {
          if (url === failingUrl) {
            if (failure === 'network') throw new Error('network unavailable');
            return { ok: failure !== 'http', status: 503, text: async () => failure === 'http' ? (url.endsWith('v4') ? '173.245.48.0/20' : '2606:4700::/32') : failure === 'empty' ? '' :
              failure === 'wrong-family' ? (url.endsWith('v4') ? '2606:4700::/32' : '173.245.48.0/20') : 'bad CIDR' };
          }
          return { ok: true, text: async () => url.endsWith('v4') ? '173.245.48.0/20' : '2606:4700::/32' };
        } }));
        assert.equal(readFileSync(output, 'utf8'), old, failingUrl + ' ' + failure);
      }
    }
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test('release ships every Cloudflare runtime and maintenance file and test:repo runs these guards', () => {
  const release = read('tools/self-host/release.mjs');
  for (const file of ['tools/self-host/Caddyfile.cloudflare', 'tools/self-host/compose.cloudflare.yml',
    'tools/self-host/cloudflare-proxies.caddy', 'scripts/self-host/refresh-cloudflare-ranges.mjs']) {
    assert.ok(release.includes("'" + file + "'"), file);
    read(file);
  }
  assert.ok(JSON.parse(read('package.json')).scripts['test:repo'].includes('scripts/self-host/cloudflare.test.mjs'));
});
