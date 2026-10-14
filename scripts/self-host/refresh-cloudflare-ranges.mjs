import { writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { pathToFileURL } from 'node:url';

const sources = ['https://www.cloudflare.com/ips-v4', 'https://www.cloudflare.com/ips-v6'];
const rangesFile = new URL('../../tools/self-host/cloudflare-proxies.caddy', import.meta.url);

export function parseCloudflareRanges(text, family) {
  const entries = text.trim().split(/\s+/);
  for (const entry of entries) {
    const match = /^([^\s/%]+)\/([1-9]\d*)$/.exec(entry);
    if (!match || isIP(match[1]) !== family || Number(match[2]) > (family === 4 ? 32 : 128)) {
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
  await writeFile(output, content);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await refreshCloudflareRanges(); console.log('Updated tools/self-host/cloudflare-proxies.caddy. Restart the gateway to apply it.'); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
