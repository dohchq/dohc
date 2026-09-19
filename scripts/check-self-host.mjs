import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { composeArgs, readSettings, validateSettings } from '../tools/self-host/config.mjs';

const { values } = parseArgs({ options: { start: { type: 'boolean' }, running: { type: 'boolean' }, 'env-file': { type: 'string', default: '.env.self-host' } } });
const envFile = values['env-file'];
const checks = [];
const record = (name, ok, detail = '') => { checks.push(ok); console.log(`[${ok ? 'ok' : 'missing'}] ${name}${detail ? ` - ${detail}` : ''}`); };
if (!existsSync(envFile)) record('self-host env file', false, `${envFile} is missing. Run: node tools/self-host/bootstrap.mjs init --origin https://HOST`);
else {
  let settings;
  try { settings = readSettings(envFile); } catch (error) { record('self-host env file', false, error.message); settings = null; }
  if (settings) {
    const errors = validateSettings(settings);
    record('self-host env values', errors.length === 0, errors.join(' '));
    const compose = spawnSync('docker', composeArgs(envFile, settings, 'config', '--services'), { encoding: 'utf8' });
    const services = new Set((compose.stdout ?? '').trim().split(/\r?\n/).filter(Boolean));
    for (const service of ['postgres', 'postgres-migrate', 'relay-initialize', 'workspace-api', 'sync-relay', 'share-web', 'gateway']) record(`compose service:${service}`, compose.status === 0 && services.has(service));
    if ((values.start || values.running) && compose.status === 0 && errors.length === 0) {
      let upOk = true;
      if (values.start) {
        const up = spawnSync('docker', composeArgs(envFile, settings, 'up', '-d', '--wait', '--wait-timeout', '180'), { stdio: 'inherit' });
        upOk = up.status === 0;
        record('compose startup', upOk);
      }
      if (upOk) {
        const ready = spawnSync('docker', composeArgs(envFile, settings, 'ps', '--status', 'running', '--services'), { encoding: 'utf8' });
        const running = new Set((ready.stdout ?? '').trim().split(/\r?\n/).filter(Boolean));
        for (const service of ['workspace-api', 'sync-relay', 'share-web', 'gateway']) record(`running service:${service}`, ready.status === 0 && running.has(service));
        for (const service of ['workspace-api', 'sync-relay', 'share-web']) {
          const health = spawnSync('docker', composeArgs(envFile, settings, 'exec', '-T', service, 'node', '/app/tools/self-host/health.mjs', service), {stdio: 'inherit'});
          record(`ready service:${service}`, health.status === 0);
        }
      }
    }
    if ((values.start || values.running) && checks.every(Boolean)) {
      let lastError = 'The public server did not respond.';
      const deadline = Date.now() + 60_000;
      let ok = false;
      do {
        try {
          const response = await fetch(`${settings.DOHC_PUBLIC_ORIGIN}/.well-known/dohc-server`, { signal: AbortSignal.timeout(5000), redirect: 'error' });
          if (!response.ok) throw new Error(`Connection descriptor returned HTTP ${response.status}.`);
          const descriptor = await response.json();
          if (descriptor.version !== 1 || ['authUrl', 'relayUrl', 'shareUrl'].some(key => descriptor[key] !== settings.DOHC_PUBLIC_ORIGIN)) throw new Error('The connection descriptor does not match the configured origin.');
          const page = await fetch(`${settings.DOHC_PUBLIC_ORIGIN}/device`, { signal: AbortSignal.timeout(5000), redirect: 'manual' });
          if (page.status !== 200 || !(page.headers.get('content-type') ?? '').includes('text/html')) throw new Error('The device approval page is unavailable.');
          ok = true;
        } catch (error) { lastError = error.message; }
        if (!ok && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 2000));
      } while (!ok && Date.now() < deadline);
      record('public HTTPS connection and device approval', ok, ok ? settings.DOHC_PUBLIC_ORIGIN : lastError);
      if (!ok && settings.DOHC_SERVER_NETWORK_ACCESS === 'private') console.log('Configure the private route with: node tools/self-host/bootstrap.mjs network');
      const hairpinScript = `
        const {accessSync,constants} = require('node:fs');
        accessSync(process.env.DOHC_RELAY_ENGINE_EXECUTABLE,constants.X_OK);
        (async()=>{const response=await fetch(process.env.DOHC_RELAY_PUBLIC_ORIGIN+'/.well-known/dohc-server',{signal:AbortSignal.timeout(15000),redirect:'error'});
        if(!response.ok)throw Error('HTTP '+response.status);const value=await response.json();
        if(value.version!==1||value.relayUrl!==process.env.DOHC_RELAY_PUBLIC_ORIGIN)throw Error('Unexpected descriptor');})().catch(()=>{console.error('Relay cannot verify its public HTTPS origin. Check DNS, TLS, and host routing.');process.exitCode=1;});`;
      const hairpin = spawnSync('docker', composeArgs(envFile, settings, 'exec', '-T', 'sync-relay', 'node', '-e', hairpinScript), {stdio: 'inherit'});
      record('native executable and relay HTTPS reachability', hairpin.status === 0);
    }
  }
}
if (checks.some(ok => !ok)) process.exitCode = 1;
console.log(`Self-host check summary: ${checks.filter(Boolean).length}/${checks.length} checks passed.`);
