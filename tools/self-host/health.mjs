import { get } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

export function automationReadiness(value, enabled) {
  const expected = enabled ? 'on' : 'off';
  if (value?.automations === expected) return {
    ok: true,
    detail: enabled ? 'engine daemon up; replica pass completed' : 'off by configuration',
  };
  return { ok: false, detail: enabled
    ? 'engine daemon or replica pass unavailable; inspect sync-relay logs'
    : 'expected automations off; restart the deployment to apply its configuration' };
}

async function checkAutomations() {
  const enabled = process.env.DOHC_RELAY_AUTOMATIONS !== '0';
  const deadline = Date.now() + 60_000;
  let result;
  do {
    try {
      const response = await fetch('http://127.0.0.1:1788/ready', { signal: AbortSignal.timeout(4000) });
      result = automationReadiness(await response.json(), enabled);
      if (!response.ok) result = { ok: false, detail: 'relay not ready; inspect sync-relay logs' };
    } catch {
      result = { ok: false, detail: 'relay readiness unavailable; inspect sync-relay logs' };
    }
    if (result.ok || Date.now() >= deadline) break;
    await delay(1000);
  } while (Date.now() < deadline);
  console.log(`Server automations: ${result.detail}.`);
  if (!result.ok) process.exitCode = 1;
}

function checkService(service) {
  const viewer = service === 'share-web';
  const request = get({ hostname: '127.0.0.1', port: viewer ? 1790 : service === 'workspace-api' ? 1786 : 1788,
    path: viewer ? '/s/' : '/ready', headers: viewer ? { Host: process.env.DOHC_SHARE_WEB_PUBLIC_HOSTS.split(',')[0] } : {},
    signal: AbortSignal.timeout(4000),
  }, response => {
    response.resume();
    if (response.statusCode !== 200) process.exitCode = 1;
  });
  request.on('error', () => { process.exitCode = 1; });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === 'sync-relay' && process.argv.includes('--automations')) await checkAutomations();
  else checkService(process.argv[2]);
}
