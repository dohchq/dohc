import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID, X509Certificate } from 'node:crypto';
import { linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { BlockList, isIP } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { defineSequenceTag, load, YAML11_SCHEMA } from 'js-yaml';
import { initialSettings } from '../../tools/self-host/bootstrap.mjs';
import { cloudflareApps, composeArgs, validateSettings } from '../../tools/self-host/config.mjs';
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

test('network instructions restrict Cloudflare origins without changing direct or private access', () => {
  const folder = mkdtempSync(join(process.cwd(), '.cloudflare-test-')), envFile = join(folder, 'settings');
  try {
    for (const mode of ['public', 'private']) {
      for (const enabled of ['0', '1']) {
        writeFileSync(envFile, Object.entries({ ...settings(), DOHC_SERVER_NETWORK_ACCESS: mode, DOHC_BEHIND_CLOUDFLARE: enabled })
          .map(([key, value]) => key + '=' + value).join('\n'));
        const result = spawnSync(process.execPath, ['tools/self-host/bootstrap.mjs', 'network', '--env-path', envFile], { encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
        if (mode === 'private') assert.match(result.stdout, /tailscale serve/);
        else if (enabled === '1') {
          assert.match(result.stdout, /only to this host's IPv4 \(A\) record\. Do not configure an origin AAAA record/);
          assert.match(result.stdout, /Cloudflare's ranges/);
          assert.match(result.stdout, /provider's network firewall or Docker's DOCKER-USER chain/);
          assert.doesNotMatch(result.stdout, /Permit inbound TCP 80 and 443/);
        } else assert.match(result.stdout, /Permit inbound TCP 80 and 443/);
      }
    }
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test('gateway reads only the static Cloudflare trust file and CF-Connecting-IP, and pins forwarded address, host and protocol on every route', () => {
  const caddy = read('tools/self-host/Caddyfile.cloudflare');
  assert.match(caddy, /servers {\s+import \/etc\/caddy\/cloudflare-proxies\.caddy\s+client_ip_headers CF-Connecting-IP\s+}/);
  const proxies = [...caddy.matchAll(/reverse_proxy (\S+) {\s+header_up X-Forwarded-For {client_ip}\s+header_up X-Forwarded-Host {host}\s+header_up X-Forwarded-Proto https\s+}/g)].map(match => match[1]);
  assert.deepEqual(proxies, ['workspace-api:1786', 'sync-relay:1788', 'share-web:1790']);
  assert.equal((caddy.match(/reverse_proxy /g) ?? []).length, proxies.length);
  // Removing address handling must leave the existing public gateway, including its TLS behavior, unchanged.
  assert.equal(caddy.replace(/  servers {[^}]+}\n/, '').replace(/reverse_proxy (\S+) {\s+header_up X-Forwarded-For {client_ip}\s+header_up X-Forwarded-Host {host}\s+header_up X-Forwarded-Proto https\s+}/g, 'reverse_proxy $1'),
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

test('range parser rejects empty lists, wrong families, invalid masks, non-IP text, wide prefixes and nonzero host bits', () => {
  assert.deepEqual(parseCloudflareRanges('173.245.48.0/20\r\n 103.21.244.0/22\n', 4), ['173.245.48.0/20', '103.21.244.0/22']);
  assert.deepEqual(parseCloudflareRanges('2606:4700::/32\n', 6), ['2606:4700::/32']);
  for (const [family, entries] of [
    [4, ['', ' \n', '<html>error</html>', '999.0.0.0/24', '173.245.48.0', '173.245.48.0/-1', '173.245.48.0/1.5',
      '104.16.0.0/1', '0.0.0.0/7', '104.16.0.1/13', '104.16.0.0/11', '173.245.48.0/33', '0.0.0.0/0', '173.245.48.0/020', '2606:4700::/32']],
    [6, ['', '2606:4700::/3', '2600::/23', '2606:4700::1/32', '2606:4701::/31', '2606:4700::/129', '::/0', 'invalid::ip/64', '2606:4700::%eth0/32', '173.245.48.0/20']],
  ]) {
    for (const value of entries) assert.throws(() => parseCloudflareRanges(value, family), /invalid.*CIDR/, value);
  }
  for (const [family, value] of [[4, '104.0.0.0/8'], [4, '104.16.0.0/13'], [6, '2606:4700::/24'],
    [6, '2606:4700::/33'], [6, '2001:db8:0:0:0:0:0:0/32'], [6, '::ffff:192.0.2.0/120']]) {
    assert.deepEqual(parseCloudflareRanges(value, family), [value]);
  }
  assert.deepEqual(parseCloudflareRanges('192.0.2.1/32', 4), ['192.0.2.1/32']);
  assert.deepEqual(parseCloudflareRanges('2001:db8::1/128', 6), ['2001:db8::1/128']);
});

test('refresh validates both successful HTTP responses before replacing the previous trust file', async () => {
  const folder = mkdtempSync(join(process.cwd(), '.cloudflare-test-')), output = join(folder, 'ranges.caddy');
  const old = 'previous valid ranges\n';
  try {
    const calls = [];
    writeFileSync(output, old);
    const previous = join(folder, 'previous.caddy');
    linkSync(output, previous);
    await refreshCloudflareRanges({ output, fetch: async (url, options) => {
      calls.push(url);
      assert.ok(options.signal instanceof AbortSignal);
      return { ok: true, text: async () => url.endsWith('v4') ? '173.245.48.0/20\n' : '2606:4700::/32\n' };
    } });
    assert.equal(readFileSync(previous, 'utf8'), old, 'refresh must replace the file, not truncate it');
    assert.deepEqual(readdirSync(folder).sort(), ['previous.caddy', 'ranges.caddy']);
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
    rmSync(output);
    mkdirSync(output);
    await assert.rejects(refreshCloudflareRanges({ output: pathToFileURL(output), fetch: async url =>
      ({ ok: true, text: async () => url.endsWith('v4') ? '173.245.48.0/20' : '2606:4700::/32' }) }));
    assert.deepEqual(readdirSync(folder).sort(), ['previous.caddy', 'ranges.caddy'], 'failed rename must remove staged files');
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test('release ships every Cloudflare runtime and maintenance file and test:repo runs these guards', () => {
  const release = read('tools/self-host/release.mjs');
  for (const file of ['tools/self-host/Caddyfile.cloudflare', 'tools/self-host/compose.cloudflare.yml',
    'tools/self-host/cloudflare-proxies.caddy', 'scripts/self-host/refresh-cloudflare-ranges.mjs',
    'tools/self-host/Caddyfile.cloudflare-apps', 'tools/self-host/compose.cloudflare-apps.yml']) {
    assert.ok(release.includes("'" + file + "'"), file);
    read(file);
  }
  assert.ok(JSON.parse(read('package.json')).scripts['test:repo'].includes('scripts/self-host/cloudflare.test.mjs'));
});

const apps = () => ({ ...settings(), DOHC_BEHIND_CLOUDFLARE: '1', DOHC_SHARE_WEB_APP_DOMAIN: 'team-apps.invalid',
  DOHC_APP_TLS_CERT_FILE: '/etc/dohc/app-tls/cert.pem', DOHC_APP_TLS_KEY_FILE: '/etc/dohc/app-tls/key.pem' });
const appsOverlay = 'tools/self-host/compose.cloudflare-apps.yml';

test('the app overlay follows the Cloudflare overlay, and only behind Cloudflare with an app domain', () => {
  const args = composeArgs('.env.self-host', { ...apps(), DOHC_DATA_DIRECTORY: '/mnt/disk/dohc', DOHC_POSTGRES_HOST: 'db.provider.invalid',
    DOHC_SNAPSHOT_S3_BUCKET: 'dohc-snapshots' }, 'up');
  assert.deepEqual(args.slice(3), ['-f', 'docker-compose.self-host.yml', '-f', 'tools/self-host/compose.data-disk.yml',
    '-f', 'tools/self-host/compose.external-postgres.yml', '-f', 'tools/self-host/compose.cloudflare.yml', '-f', appsOverlay,
    '--profile', 'snapshots', 'up']);
  // Direct and private access keep their gateways, even with an app domain served by the operator's own proxy.
  for (const changed of [{ DOHC_BEHIND_CLOUDFLARE: '0' }, { DOHC_BEHIND_CLOUDFLARE: undefined }, { DOHC_SHARE_WEB_APP_DOMAIN: '' },
    { DOHC_SHARE_WEB_APP_DOMAIN: undefined }, { DOHC_SERVER_NETWORK_ACCESS: 'private', DOHC_BEHIND_CLOUDFLARE: '0' }]) {
    const value = { ...apps(), ...changed };
    assert.equal(cloudflareApps(value), false, JSON.stringify(changed));
    assert.ok(!composeArgs('.env.self-host', value, 'up').includes(appsOverlay), JSON.stringify(changed));
  }
  assert.deepEqual(composeArgs('.env.self-host', { ...settings(), DOHC_SHARE_WEB_APP_DOMAIN: 'team-apps.invalid' }, 'up'),
    composeArgs('.env.self-host', settings(), 'up'));
});

test('the app overlay refuses a partial configuration before any Docker action', () => {
  assert.deepEqual(validateSettings(apps()), []);
  assert.equal(settings().DOHC_APP_TLS_CERT_FILE, '');
  assert.equal(settings().DOHC_APP_TLS_KEY_FILE, '');
  for (const name of ['DOHC_APP_TLS_CERT_FILE', 'DOHC_APP_TLS_KEY_FILE']) {
    for (const value of [undefined, '', 'cert.pem', './cert.pem', '/etc/../cert.pem', '/etc/dohc/app tls/cert.pem', 'C:/cert.pem']) {
      assert.ok(validateSettings({ ...apps(), [name]: value }).some(error => error.includes(`Set ${name} to the absolute path`)), `${name}=${value}`);
    }
    // A certificate that no gateway would use is refused too, so a forgotten setting does not look configured.
    const other = name === 'DOHC_APP_TLS_CERT_FILE' ? 'DOHC_APP_TLS_KEY_FILE' : 'DOHC_APP_TLS_CERT_FILE';
    for (const changed of [{ DOHC_BEHIND_CLOUDFLARE: '0' }, { DOHC_SHARE_WEB_APP_DOMAIN: '' }]) {
      assert.ok(validateSettings({ ...apps(), ...changed, [other]: '' }).some(error => error.includes('used only behind Cloudflare with an app domain')),
        `${name} ${JSON.stringify(changed)}`);
    }
  }
  // Caddy substitutes the domain into its configuration, so only a plain lowercase host name passes.
  for (const domain of ['Apps.invalid', 'https://apps.invalid', 'apps.invalid:443', '*.apps.invalid', 'apps', 'apps.invalid.',
    'apps.invalid {', 'apps .invalid', '-apps.invalid', 'apps.invalid\n}']) {
    assert.ok(validateSettings({ ...apps(), DOHC_SHARE_WEB_APP_DOMAIN: domain }).some(error => error.includes('DOHC_SHARE_WEB_APP_DOMAIN to a lowercase domain')),
      JSON.stringify(domain));
  }
  // The wildcard site must never capture the server's own host.
  for (const domain of ['dohc.team.invalid', 'team.invalid']) {
    assert.ok(validateSettings({ ...apps(), DOHC_SHARE_WEB_APP_DOMAIN: domain }).some(error => error.includes('Keep DOHC_PUBLIC_HOST outside')), domain);
  }
  assert.deepEqual(validateSettings({ ...apps(), DOHC_BEHIND_CLOUDFLARE: '0', DOHC_APP_TLS_CERT_FILE: '', DOHC_APP_TLS_KEY_FILE: '' }), []);
});

test('the app overlay adds only the app domain, the gateway configuration and read-only certificate mounts that Docker never creates', () => {
  const text = read(appsOverlay), overlay = load(text, { schema: YAML11_SCHEMA });
  assert.deepEqual(Object.keys(overlay), ['services']);
  assert.deepEqual(Object.keys(overlay.services), ['gateway']);
  assert.deepEqual(overlay.services.gateway.environment, { DOHC_SHARE_WEB_APP_DOMAIN: '${DOHC_SHARE_WEB_APP_DOMAIN:?Set DOHC_SHARE_WEB_APP_DOMAIN}' });
  const bind = (source, target) => ({ type: 'bind', source, target, read_only: true, bind: { create_host_path: false } });
  assert.deepEqual(overlay.services.gateway.volumes, [
    bind('./tools/self-host/Caddyfile.cloudflare-apps', '/etc/caddy/Caddyfile'),
    bind('./tools/self-host/Caddyfile.cloudflare', '/etc/caddy/Caddyfile.cloudflare'),
    bind('${DOHC_APP_TLS_CERT_FILE:?Set DOHC_APP_TLS_CERT_FILE}', '/etc/caddy/app-tls/cert.pem'),
    bind('${DOHC_APP_TLS_KEY_FILE:?Set DOHC_APP_TLS_KEY_FILE}', '/etc/caddy/app-tls/key.pem'),
  ]);
  // Compose merges mounts by container path, so the trust file and the certificate volumes of compose.cloudflare.yml stay.
  assert.doesNotMatch(text, /!override|!reset|cloudflare-proxies|dohc_self_host_/);
  assert.doesNotMatch(text, /relay-snapshot|networks:|DOHC_SNAPSHOT_/);
});

test('the app route imports the Cloudflare gateway first, sends only app hosts to share-web, and keeps the viewer hosts exact', () => {
  const caddy = read('tools/self-host/Caddyfile.cloudflare-apps');
  assert.match(caddy, /^import \/etc\/caddy\/Caddyfile\.cloudflare\n/);
  assert.deepEqual([...caddy.matchAll(/^(\S.*) \{$/gm)].map(match => match[1]), ['*.{$DOHC_SHARE_WEB_APP_DOMAIN}']);
  assert.match(caddy, /\{\n  tls \/etc\/caddy\/app-tls\/cert\.pem \/etc\/caddy\/app-tls\/key\.pem\n/);
  assert.match(caddy, /@internal path \/internal\/\*\s+handle @internal \{\s+respond 404\s+\}/);
  assert.ok(caddy.indexOf('handle @internal') < caddy.indexOf('handle {'));
  const proxies = [...caddy.matchAll(/reverse_proxy (\S+) \{\s+header_up X-Forwarded-For \{client_ip\}\s+header_up X-Forwarded-Host \{host\}\s+header_up X-Forwarded-Proto https\s+\}/g)]
    .map(match => match[1]);
  assert.deepEqual(proxies, ['share-web:1790']);
  assert.equal((caddy.match(/reverse_proxy /g) ?? []).length, 1);
  // Caddy keeps the incoming Host header. Nothing here rewrites it or reaches sign-in or the relay.
  assert.doesNotMatch(caddy, /workspace-api|sync-relay|header_up Host|DOHC_PUBLIC_HOST/);
  assert.match(read('tools/self-host/Caddyfile.cloudflare'), /^\{\$DOHC_PUBLIC_HOST\} \{$/m);
  const compose = load(read('docker-compose.self-host.yml'), { schema: YAML11_SCHEMA });
  assert.equal(compose.services['share-web'].environment.DOHC_SHARE_WEB_PUBLIC_HOSTS, '${DOHC_PUBLIC_HOST:?Set DOHC_PUBLIC_HOST}');
  assert.equal(compose.services['sync-relay'].environment.DOHC_RELAY_NAMED_LIVE_HOSTS, '${DOHC_PUBLIC_HOST:?Set DOHC_PUBLIC_HOST},sync-relay:1788');
});

// Not run by test:repo: it needs a Linux Docker host, the pinned Caddy and Node images, and openssl.
const gatewaySkip = process.env.DOHC_GATEWAY_DOCKER_TEST === '1' ? false : 'Set DOHC_GATEWAY_DOCKER_TEST=1 on a Linux host with Docker and openssl.';
const nodeImage = 'node:24.16.0-bookworm-slim';
const echoServer = "const http=require('node:http');for(const [port,service] of [[1786,'workspace-api'],[1788,'sync-relay'],[1790,'share-web']])" +
  "http.createServer((q,s)=>{s.setHeader('content-type','application/json');s.end(JSON.stringify({service,path:q.url,host:q.headers.host," +
  "xff:q.headers['x-forwarded-for'],xfh:q.headers['x-forwarded-host'],xfp:q.headers['x-forwarded-proto']}));}).listen(port);";
// Sends each request with its own SNI and Host, trusting only the local CA and Caddy's internal root. The first request waits for the gateway.
const gatewayClient = "const https=require('node:https'),fs=require('node:fs');const [address,spec]=process.argv.slice(1);" +
  "const ca=[fs.readFileSync('/certs/ca.pem'),fs.readFileSync('/certs/viewer-root.pem')];" +
  "const one=r=>new Promise(done=>{const q=https.request({host:address,port:443,path:r.path,servername:r.host,headers:{host:r.host,...r.headers},ca,agent:false},s=>{" +
  "const cert=s.socket.getPeerCertificate().fingerprint256;let body='';s.on('data',d=>body+=d);s.on('end',()=>{let echo;try{echo=JSON.parse(body)}catch{}" +
  "done({status:s.statusCode,location:s.headers.location,echo,cert})})});q.on('error',e=>done({error:e.code||e.message}));q.end();});" +
  "(async()=>{const out=[];const deadline=Date.now()+60000;for(const [i,r] of JSON.parse(spec).entries()){let result=await one(r);" +
  "while(i===0&&result.error&&Date.now()<deadline){await new Promise(next=>setTimeout(next,250));result=await one(r);}out.push(result);}" +
  "console.log(JSON.stringify(out));})();";

test('the pinned Caddy image loads the app gateway and routes app hosts, viewer paths and client addresses', { skip: gatewaySkip, timeout: 600_000 }, () => {
  const owner = `dohc-gateway-${randomUUID().slice(0, 8)}`, scratch = mkdtempSync(join(tmpdir(), `${owner}-`));
  const containers = [], network = `${owner}-net`, subnet = `10.236.${100 + Math.floor(Math.random() * 100)}`;
  const run = (command, args, allowFailure = false) => {
    const result = spawnSync(command, args, { encoding: 'utf8', timeout: 300_000, maxBuffer: 16 * 1024 * 1024 });
    if (!allowFailure) assert.equal(result.status, 0, `${command} ${args.slice(0, 3).join(' ')}: ${result.stderr}`);
    return result;
  };
  const docker = (args, allowFailure) => run('docker', args, allowFailure);
  let networkCreated = false;
  try {
    // A local CA signs the app certificate, and clients trust that CA explicitly.
    const file = name => join(scratch, name);
    run('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-days', '2', '-subj', '/CN=dohc gateway test CA',
      '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign', '-keyout', file('ca.key'), '-out', file('ca.pem')]);
    run('openssl', ['req', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-subj', '/CN=*.apps.test', '-keyout', file('app.key'), '-out', file('app.csr')]);
    writeFileSync(file('app.ext'), 'subjectAltName=DNS:*.apps.test\nextendedKeyUsage=serverAuth\n');
    run('openssl', ['x509', '-req', '-in', file('app.csr'), '-CA', file('ca.pem'), '-CAkey', file('ca.key'), '-CAcreateserial', '-days', '2',
      '-extfile', file('app.ext'), '-out', file('app.pem')]);
    const appCertificate = new X509Certificate(readFileSync(file('app.pem'))).fingerprint256;

    const values = { ...settings(), DOHC_DEPLOYMENT_NAME: owner, DOHC_PUBLIC_ORIGIN: 'https://viewer.localhost', DOHC_PUBLIC_HOST: 'viewer.localhost',
      DOHC_BEHIND_CLOUDFLARE: '1', DOHC_SHARE_WEB_APP_DOMAIN: 'apps.test', DOHC_APP_TLS_CERT_FILE: file('app.pem'), DOHC_APP_TLS_KEY_FILE: file('app.key') };
    assert.deepEqual(validateSettings(values), []);
    const envFile = (name, content) => {
      writeFileSync(file(name), Object.entries(content).filter(([, value]) => value !== undefined).map(([key, value]) => `${key}=${value}\n`).join(''), { mode: 0o600 });
      return file(name);
    };
    // Compose itself refuses the overlay without the key file setting.
    const partial = docker(composeArgs(envFile('partial', { ...values, DOHC_APP_TLS_KEY_FILE: undefined }), values, 'config', '--format', 'json'), true);
    assert.notEqual(partial.status, 0);
    assert.match(partial.stderr, /Set DOHC_APP_TLS_KEY_FILE/);
    const config = JSON.parse(docker(composeArgs(envFile('settings', values), values, 'config', '--format', 'json')).stdout);
    const gateway = config.services.gateway, mounts = Object.fromEntries(gateway.volumes.map(volume => [volume.target, volume]));
    assert.equal(gateway.environment.DOHC_SHARE_WEB_APP_DOMAIN, 'apps.test');
    assert.equal(config.services['share-web'].environment.DOHC_SHARE_WEB_PUBLIC_HOSTS, 'viewer.localhost');
    assert.deepEqual(Object.keys(mounts).sort(), ['/config', '/data', '/etc/caddy/Caddyfile', '/etc/caddy/Caddyfile.cloudflare',
      '/etc/caddy/app-tls/cert.pem', '/etc/caddy/app-tls/key.pem', '/etc/caddy/cloudflare-proxies.caddy']);
    assert.equal(mounts['/etc/caddy/Caddyfile'].source, join(process.cwd(), 'tools/self-host/Caddyfile.cloudflare-apps'));
    for (const [target, mount] of Object.entries(mounts)) {
      if (!target.startsWith('/etc/')) assert.equal(mount.type, 'volume', target);
      else assert.deepEqual([mount.type, mount.read_only, mount.bind?.create_host_path === true], ['bind', true, false], target);
    }

    // Only the test edge's address is a trusted proxy here. The shipped range list stays unchanged.
    writeFileSync(file('trusted.caddy'), `trusted_proxies static ${subnet}.10/32\n`);
    const gatewayArgs = [...gateway.volumes.flatMap(volume => volume.type !== 'bind' ? ['--tmpfs', volume.target] : ['--mount',
      `type=bind,source=${volume.target === '/etc/caddy/cloudflare-proxies.caddy' ? file('trusted.caddy') : volume.source},target=${volume.target},readonly`]),
    ...Object.entries(gateway.environment).flatMap(([key, value]) => ['--env', `${key}=${value}`])];
    docker(['run', '--rm', '--network', 'none', ...gatewayArgs, gateway.image, 'caddy', 'validate', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile']);

    docker(['network', 'create', '--subnet', `${subnet}.0/24`, network]);
    networkCreated = true;
    const start = (name, args) => { containers.push(`${owner}-${name}`); docker(['run', '-d', '--name', `${owner}-${name}`, '--network', network, ...args]); };
    start('upstream', ['--ip', `${subnet}.3`, ...['workspace-api', 'sync-relay', 'share-web'].flatMap(alias => ['--network-alias', alias]),
      nodeImage, 'node', '-e', echoServer]);
    start('gateway', ['--ip', `${subnet}.2`, ...gatewayArgs, gateway.image]);
    // Caddy writes its internal root when it issues the viewer's local certificate.
    const deadline = Date.now() + 60_000;
    let root;
    do { root = docker(['exec', `${owner}-gateway`, 'cat', '/data/caddy/pki/authorities/local/root.crt'], true); }
    while (root.status !== 0 && Date.now() < deadline);
    assert.equal(root.status, 0, 'Caddy wrote no internal root for the viewer host.');
    writeFileSync(file('viewer-root.pem'), root.stdout);
    const send = (ip, requests) => JSON.parse(docker(['run', '--rm', '--network', network, '--ip', ip, '--mount', `type=bind,source=${scratch},target=/certs,readonly`,
      nodeImage, 'node', '-e', gatewayClient, `${subnet}.2`, JSON.stringify(requests)]).stdout);

    const app = `${'0123456789abcdef'.repeat(3)}.apps.test`;
    const forged = { 'cf-connecting-ip': '203.0.113.9', 'x-forwarded-for': '198.51.100.1', 'x-forwarded-host': 'forged.invalid', 'x-forwarded-proto': 'http' };
    const edge = send(`${subnet}.10`, [
      { host: app, path: '/launch?grant=1', headers: forged }, { host: app, path: '/internal/state' }, { host: app, path: '/api/auth/get-session' },
      { host: app, path: '/sync/ready' }, { host: 'viewer.localhost', path: '/api/auth/get-session', headers: forged },
      { host: 'viewer.localhost', path: '/sync/ready' }, { host: 'viewer.localhost', path: '/s/link' }, { host: 'viewer.localhost', path: '/' },
      { host: 'viewer.localhost', path: '/internal/state' }, { host: `a.${app}`, path: '/' }, { host: 'apps.test', path: '/' },
    ]);
    assert.deepEqual(edge[0], { status: 200, cert: appCertificate,
      echo: { service: 'share-web', path: '/launch?grant=1', host: app, xff: '203.0.113.9', xfh: app, xfp: 'https' } });
    assert.deepEqual([edge[1].status, edge[1].echo], [404, undefined]);
    assert.deepEqual(edge.slice(2, 4).map(result => [result.echo?.service, result.echo?.host]), [['share-web', app], ['share-web', app]]);
    assert.deepEqual(edge.slice(4, 7).map(result => result.echo?.service), ['workspace-api', 'sync-relay', 'share-web']);
    assert.equal(edge[4].echo.xff, '203.0.113.9');
    assert.notEqual(edge[4].cert, appCertificate);
    assert.deepEqual([edge[7].status, edge[7].location], [302, '/account']);
    assert.deepEqual([edge[8].status, edge[8].echo], [404, undefined]);
    // No site serves a deeper host or the app domain's apex, so the TLS handshake fails.
    assert.ok(edge[9].error && edge[10].error, JSON.stringify(edge.slice(9)));
    // From an untrusted peer, Caddy ignores every client-address header and forwards the peer's own address.
    const stranger = send(`${subnet}.11`, [{ host: app, path: '/', headers: forged }, { host: 'viewer.localhost', path: '/api/auth/get-session', headers: forged }]);
    assert.deepEqual(stranger.map(result => [result.echo?.service, result.echo?.xff, result.echo?.xfh]),
      [['share-web', `${subnet}.11`, app], ['workspace-api', `${subnet}.11`, 'viewer.localhost']]);
  } finally {
    if (containers.length) docker(['rm', '-f', ...containers], true);
    if (networkCreated) docker(['network', 'rm', network], true);
    rmSync(scratch, { recursive: true, force: true });
  }
});
