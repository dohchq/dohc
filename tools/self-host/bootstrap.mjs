import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs, parseEnv } from 'node:util';
import { pathToFileURL } from 'node:url';
import { composeArgs, readSettings, validateSettings } from './config.mjs';

export function initialSettings({ origin, mode = 'public', name = 'dohc', image = 'dohc-self-host:local' }) {
  const url = new URL(origin);
  if (url.protocol !== 'https:' || url.origin !== origin || url.username || url.password) throw new Error('Use an HTTPS origin without a path.');
  if (!['public', 'private'].includes(mode)) throw new Error('Choose public or private mode.');
  if (mode === 'public' && url.port) throw new Error('Public mode uses HTTPS port 443. Remove the custom port.');
  if (mode === 'private' && !url.hostname.endsWith('.ts.net')) throw new Error('Use your Tailscale HTTPS hostname for private mode.');
  if (!name.trim() || name.length > 80 || /[\r\n'\x00]/.test(name)) throw new Error('Use a server name of 1 to 80 characters without quotes or newlines.');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9./_:@-]+$/.test(image)) throw new Error('Use a valid release image name.');
  return {
    DOHC_PUBLIC_ORIGIN: origin, DOHC_PUBLIC_HOST: url.host, DOHC_IMAGE: image,
    DOHC_SERVER_NETWORK_ACCESS: mode, DOHC_SERVER_NAME: name,
    ...Object.fromEntries(['POSTGRES_PASSWORD', 'BETTER_AUTH_SECRET', 'DOHC_RELAY_LINK_KEY', 'DOHC_RELAY_EXCHANGE_KEY']
      .map(key => [key, randomBytes(32).toString('base64url')])),
  };
}

export function privateRouteInstructions(settings) {
  const url = new URL(settings.DOHC_PUBLIC_ORIGIN), port = url.port || '443';
  const backend = `http://127.0.0.1:${settings.DOHC_PRIVATE_PORT || '1791'}`;
  return [
    'On the deployment host, run: tailscale serve status --json',
    `Confirm HTTPS port ${port} has no existing route. Preserve other applications' routes.`,
    `Confirm tailscale status --json reports the hostname ${url.hostname}.`,
    `Then add this private route: tailscale serve --bg --https=${port} ${backend}`,
    `To remove it, first confirm this port still points to ${backend}.`,
    `Then run: tailscale serve --https=${port} off`,
    'Do not enable Funnel. Each recipient must belong to the tailnet and have network access.',
  ];
}

export function updateImageSetting(original, image) {
  const before = parseEnv(original);
  const assignment = /^[ \t]*(?:export[ \t]+)?DOHC_IMAGE[ \t]*=.*$/gm;
  if (!assignment.test(original)) throw new Error('Add a DOHC_IMAGE assignment before upgrading.');
  if (/[\r\n]/.test(before.DOHC_IMAGE ?? '')) throw new Error('Use a single-line DOHC_IMAGE assignment before upgrading.');
  const updated = original.replace(assignment, () => `DOHC_IMAGE='${image}'`);
  const after = parseEnv(updated);
  if (after.DOHC_IMAGE !== image || Object.keys(before).length !== Object.keys(after).length ||
      Object.entries(before).some(([key, value]) => key !== 'DOHC_IMAGE' && after[key] !== value)) {
    throw new Error('Use a single-line DOHC_IMAGE assignment outside quoted multiline values before upgrading.');
  }
  return updated;
}

function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    origin: { type: 'string' }, mode: { type: 'string' }, name: { type: 'string' }, image: { type: 'string' },
    'env-file': { type: 'string', default: '.env.self-host' }, help: { type: 'boolean' },
  } });
  if (values.help || !positionals.length) {
    console.log('init --origin https://HOST [--mode public|private] [--name NAME] [--image IMAGE] [--env-file PATH]\nnetwork | start | stop [--env-file PATH]\nupgrade --image IMAGE [--env-file PATH]\nInitialization never replaces an existing file or network route. Stop preserves every data volume.');
    return;
  }
  if (positionals[0] === 'network') {
    const settings = readSettings(values['env-file']);
    console.log(settings.DOHC_SERVER_NETWORK_ACCESS === 'private' ? privateRouteInstructions(settings).join('\n') :
      `Point DNS for ${settings.DOHC_PUBLIC_HOST} to this host. Permit inbound TCP 80 and 443. Caddy obtains TLS certificates at startup.`);
    return;
  }
  if (['start', 'stop', 'upgrade'].includes(positionals[0])) {
    const action = positionals[0], envFile = values['env-file'], settings = readSettings(envFile);
    if (action === 'upgrade') {
      if (!values.image || !/^[a-zA-Z0-9][a-zA-Z0-9./_:@-]+$/.test(values.image)) throw new Error('Use upgrade --image RELEASE_IMAGE.');
      const errors = validateSettings({ ...settings, DOHC_IMAGE: values.image });
      if (errors.length) throw new Error(errors.join('\n'));
      const original = readFileSync(envFile, 'utf8');
      const updated = updateImageSetting(original, values.image);
      const previous = `${envFile}.previous-${Date.now()}`;
      writeFileSync(previous, original, {flag: 'wx', mode: 0o600});
      console.log(`Previous configuration saved to ${previous}. Keep it private with your deployment secrets.`);
      console.log('Upgrade can apply database migrations. This configuration copy is not a data rollback.');
      const stopped = spawnSync('docker', composeArgs(envFile, settings, 'stop'), {stdio: 'inherit'});
      if (stopped.error || stopped.status !== 0) throw new Error('Could not stop the deployment. Its configuration was not changed.');
      writeFileSync(envFile, updated, {mode: 0o600});
    }
    const result = action === 'stop'
      ? spawnSync('docker', composeArgs(envFile, settings, 'stop'), {stdio: 'inherit'})
      : spawnSync(process.execPath, ['scripts/check-self-host.mjs', '--start', '--env-file', envFile], {stdio: 'inherit'});
    if (result.error || result.status !== 0) throw new Error(action === 'upgrade'
      ? 'Upgrade did not become ready. Preserve the current data and inspect logs; no rollback was attempted.'
      : `${action} failed. Inspect the reported service error.`);
    return;
  }
  if (positionals[0] !== 'init' || !values.origin) throw new Error('Use init --origin https://HOST.');
  const settings = initialSettings(values);
  let content = readFileSync(new URL('../../.env.self-host.example', import.meta.url), 'utf8');
  for (const [key, value] of Object.entries(settings)) content = content.replace(new RegExp(`^${key}=.*$`, 'm'), () => `${key}='${value}'`);
  writeFileSync(values['env-file'], content, { flag: 'wx', mode: 0o600 });
  console.log(`Created ${values['env-file']}. Restrict access to this file and preserve its secrets during upgrades.`);
  console.log('Set the SMTP values before starting the server. No network or containers were changed.');
  console.log(`Connection URL: ${values.origin}`);
  if (settings.DOHC_SERVER_NETWORK_ACCESS === 'private') console.log(privateRouteInstructions(settings).join('\n'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
