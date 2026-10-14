import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isIP } from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';

const sources = ['https://www.cloudflare.com/ips-v4', 'https://www.cloudflare.com/ips-v6'];
const rangesFile = new URL('../../tools/self-host/cloudflare-proxies.caddy', import.meta.url);

function hasZeroHostBits(address, prefix, family) {
  let value;
  if (family === 4) {
    value = address.split('.').reduce((result, octet) => (result << 8n) | BigInt(octet), 0n);
  } else {
    const normalized = new URL('http://[' + address + ']').hostname.slice(1, -1);
    const [left, right] = normalized.split('::').map(part => part ? part.split(':') : []);
    const groups = right === undefined ? left : [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
    value = groups.reduce((result, group) => (result << 16n) | BigInt('0x' + group), 0n);
  }
  const hostMask = (1n << BigInt((family === 4 ? 32 : 128) - prefix)) - 1n;
  return (value & hostMask) === 0n;
}

export function parseCloudflareRanges(text, family) {
  const entries = text.trim().split(/\s+/);
  for (const entry of entries) {
    const match = /^([^\s/%]+)\/([1-9]\d*)$/.exec(entry);
    if (!match || isIP(match[1]) !== family || Number(match[2]) < (family === 4 ? 8 : 24) ||
        Number(match[2]) > (family === 4 ? 32 : 128) || !hasZeroHostBits(match[1], Number(match[2]), family)) {
      throw new Error('Cloudflare returned an invalid IPv' + family + ' CIDR: ' + (entry || '(empty)') + '. Keep the previous ranges file.');
    }
  }
  return entries;
}

export async function refreshCloudflareRanges({ fetch: fetchSource = fetch, output = rangesFile } = {}) {
  const ranges = [];
  for (const [index, source] of sources.entries()) {
    const response = await fetchSource(source, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error('Cloudflare ranges request failed (' + response.status + '). Keep the previous ranges file and try again.');
    ranges.push(...parseCloudflareRanges(await response.text(), index === 0 ? 4 : 6));
  }
  const content = '# Cloudflare ranges: ' + sources.join(' and ') + '\n' +
    '# Refreshed ' + new Date().toISOString().slice(0, 10) + '. Run node scripts/self-host/refresh-cloudflare-ranges.mjs to update.\n' +
    'trusted_proxies static ' + ranges.join(' ') + '\n';
  const destination = output instanceof URL ? fileURLToPath(output) : output;
  const temporary = await mkdtemp(join(dirname(destination), '.cloudflare-ranges-'));
  try {
    const staged = join(temporary, 'ranges.caddy');
    await writeFile(staged, content, { flag: 'wx' });
    await rename(staged, destination);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await refreshCloudflareRanges(); console.log('Updated tools/self-host/cloudflare-proxies.caddy. Restart the gateway to apply it.'); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
