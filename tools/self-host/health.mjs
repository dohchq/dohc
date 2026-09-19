import { get } from 'node:http';
const service = process.argv[2], viewer = service === 'share-web';
const request = get({ hostname: '127.0.0.1', port: viewer ? 1790 : service === 'workspace-api' ? 1786 : 1788,
  path: viewer ? '/s/' : '/ready', headers: viewer ? { Host: process.env.DOHC_SHARE_WEB_PUBLIC_HOSTS.split(',')[0] } : {},
  signal: AbortSignal.timeout(4000),
}, response => {
  response.resume();
  if (response.statusCode !== 200) process.exitCode = 1;
});
request.on('error', () => { process.exitCode = 1; });
