import { readFileSync } from 'node:fs';
import { isDeepStrictEqual, parseEnv } from 'node:util';
import { posix, resolve } from 'node:path';

export function supportedComposeVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value.trim());
  if (!match) return false;
  const [major, minor, patch] = match.slice(1).map(Number);
  return major > 2 || (major === 2 && (minor > 24 || (minor === 24 && patch >= 4)));
}

export function readSettings(path = '.env.self-host') {
  return parseEnv(readFileSync(path, 'utf8'));
}

export function validateSettings(settings) {
  const errors = [];
  for (const name of ['DOHC_RELAY_APP_PUBLICATIONS', 'DOHC_RELAY_AUTOMATIONS']) {
    if (settings[name] !== undefined && !['0', '1'].includes(settings[name])) errors.push(`Set ${name} to 0 or 1.`);
  }
  const participants = settings.DOHC_RELAY_APP_BACKEND_MAX_PARTICIPANTS_PER_GRANT;
  if (participants !== undefined && (!/^[1-9]\d*$/.test(participants) || !Number.isSafeInteger(Number(participants)))) {
    errors.push('Set DOHC_RELAY_APP_BACKEND_MAX_PARTICIPANTS_PER_GRANT to a positive safe integer.');
  }
  for (const name of ['DOHC_IMAGE', 'POSTGRES_PASSWORD', 'BETTER_AUTH_SECRET', 'DOHC_RELAY_LINK_KEY',
    'DOHC_RELAY_EXCHANGE_KEY', 'DOHC_SMTP_HOST', 'DOHC_SMTP_FROM']) {
    if (!settings[name] || /change-me|example\.(com|net|org)/i.test(settings[name])) errors.push(`Set ${name}.`);
  }
  for (const name of ['POSTGRES_PASSWORD', 'BETTER_AUTH_SECRET', 'DOHC_RELAY_LINK_KEY', 'DOHC_RELAY_EXCHANGE_KEY']) {
    if ((settings[name]?.length ?? 0) < 32) errors.push(`${name} must contain at least 32 characters.`);
  }
  try {
    const origin = new URL(settings.DOHC_PUBLIC_ORIGIN);
    if (origin.protocol !== 'https:' || origin.origin !== settings.DOHC_PUBLIC_ORIGIN || origin.username || origin.password ||
      origin.host !== settings.DOHC_PUBLIC_HOST || /(^|\.)example\.(com|net|org)$/.test(origin.hostname)) throw new Error();
  } catch { errors.push('Set DOHC_PUBLIC_ORIGIN to your HTTPS origin and DOHC_PUBLIC_HOST to its exact host.'); }
  if (!['public', 'private'].includes(settings.DOHC_SERVER_NETWORK_ACCESS)) errors.push('Set DOHC_SERVER_NETWORK_ACCESS to public or private.');
  if (settings.DOHC_SERVER_NETWORK_ACCESS === 'public' && /:\d+$/.test(settings.DOHC_PUBLIC_HOST ?? '')) errors.push('Public mode uses HTTPS port 443. Remove the custom port from the origin.');
  if (settings.DOHC_SERVER_NETWORK_ACCESS === 'private' && !/^https:\/\/[^/]+\.ts\.net(?::[0-9]+)?$/.test(settings.DOHC_PUBLIC_ORIGIN ?? '')) {
    errors.push('Private mode requires your Tailscale HTTPS hostname ending in .ts.net.');
  }
  if (Boolean(settings.DOHC_SMTP_USER) !== Boolean(settings.DOHC_SMTP_PASSWORD)) errors.push('Set both DOHC_SMTP_USER and DOHC_SMTP_PASSWORD.');
  if (!['true', 'false'].includes(settings.DOHC_SMTP_SECURE)) errors.push('Set DOHC_SMTP_SECURE to true or false.');
  if (!/^\d+$/.test(settings.DOHC_SMTP_PORT ?? '') || Number(settings.DOHC_SMTP_PORT) < 1 || Number(settings.DOHC_SMTP_PORT) > 65535) errors.push('Set DOHC_SMTP_PORT to a valid port.');
  if (settings.DOHC_DATA_DIRECTORY && !/^(\/(?!\.\.?(\/|$))[a-zA-Z0-9._-]+)+$/.test(settings.DOHC_DATA_DIRECTORY)) {
    errors.push('Set DOHC_DATA_DIRECTORY to an absolute folder on the data disk, or leave it empty.');
  }
  return errors;
}

export function composeArgs(envFile, settings, ...args) {
  return ['compose', '--env-file', resolve(envFile), '-f', 'docker-compose.self-host.yml',
    ...(settings.DOHC_SERVER_NETWORK_ACCESS === 'private' ? ['-f', 'tools/self-host/compose.private.yml'] : []),
    ...(settings.DOHC_DATA_DIRECTORY ? ['-f', 'tools/self-host/compose.data-disk.yml'] : []), ...args];
}

// Reads through relay-initialize's volumes, so it checks the folders Docker mounts. It prints whether the deployment's
// record and database exist and which disk folders hold data. Any other result means the check failed.
const diskFolders = { '/data': 'sync-relay', '/continuity': 'continuity', '/host-data': 'host-data' };
export const relayDeploymentCheck = "const fs=require('node:fs');const exists=path=>fs.statSync(path,{throwIfNoEntry:false})!==undefined;" +
  "const missing=['/continuity/deployment.json','/data/sync-relay.sqlite'].filter(path=>!exists(path));" +
  "if(missing.length)console.error('Missing '+missing.join(', '));" +
  `const holding=Object.entries(${JSON.stringify(diskFolders)}).filter(([path])=>fs.readdirSync(path).length).map(([,folder])=>folder);` +
  "console.log(JSON.stringify({deployment:!missing.length,holding}));";

/** `docker(args)` returns `{status, stdout, stderr}`. */
export function composeConfig(envFile, settings, docker) {
  const result = docker(composeArgs(envFile, settings, 'config', '--format', 'json'));
  // Compose config contains secrets. Never include its output in errors.
  if (result.status !== 0) throw new Error('Docker Compose could not read the deployment configuration.');
  return JSON.parse(result.stdout);
}

/** Returns undefined only when Docker reports that the volume does not exist. */
export function inspectVolume(name, docker) {
  const result = docker(['volume', 'inspect', name]);
  if (result.status === 0) return JSON.parse(result.stdout)[0];
  if (/no such volume/i.test(result.stderr ?? '')) return undefined;
  throw new Error(`Docker could not inspect volume ${name}. Check that Docker is running, then try again.`);
}

/** Docker fixes a volume's storage when it creates it, and Compose reuses an existing volume unchanged. */
export function dataDiskVolumeErrors(config, docker) {
  return Object.values(config.volumes ?? {}).filter(volume => volume.driver_opts).flatMap(volume => {
    const actual = inspectVolume(volume.name, docker);
    if (!actual || actual.Driver === (volume.driver ?? 'local') && isDeepStrictEqual(actual.Options ?? {}, volume.driver_opts)) return [];
    return [`Docker volume ${volume.name} keeps its data in ${actual.Options?.device ?? 'Docker storage'}, not ${volume.driver_opts.device}. ` +
      'Restore the previous DOHC_DATA_DIRECTORY. Never remove the volume: it holds deployment data.'];
  });
}

/**
 * A first start needs all three disk folders empty. Every later start needs the relay deployment on the disk;
 * the session host and automations rebuild their copies from the relay when host-data is empty.
 */
export function relayDeploymentError(envFile, settings, docker, firstStart) {
  const { status, stdout } = docker(composeArgs(envFile, settings, 'run', '--rm', '--no-deps', '-T',
    '--entrypoint', 'node', 'relay-initialize', '-e', relayDeploymentCheck));
  const directory = settings.DOHC_DATA_DIRECTORY;
  let result;
  try { result = status === 0 ? JSON.parse(stdout.trim().split('\n').at(-1)) : undefined; } catch { result = undefined; }
  if (typeof result?.deployment !== 'boolean' || !Array.isArray(result.holding) ||
    !result.holding.every(folder => Object.values(diskFolders).includes(folder))) {
    return `Could not check the data disk in ${directory}. Check that the disk is mounted there and Docker is running, then try again.`;
  }
  const relayData = result.holding.some(folder => folder !== 'host-data');
  if (firstStart) {
    if (!result.holding.length) return '';
    const folders = result.holding.map(folder => `${directory}/${folder}`).join(', ');
    return `${folders} already ${result.holding.length === 1 ? 'holds' : 'hold'} data. A first start needs empty disk folders. ` +
      (relayData ? 'Start without --first-start.' : 'Check that DOHC_DATA_DIRECTORY names a new deployment folder.');
  }
  if (!relayData) {
    return `No relay deployment found in ${directory}. Mount the data disk there and try again. ` +
      'Never recreate its folders: setup would create a new deployment.';
  }
  if (!result.deployment) {
    return `The relay deployment in ${directory} is missing its record or its database. Keep the disk unchanged and check that it is this deployment's disk.`;
  }
  return '';
}

/** Inspects the accounts volume before a container mounts it: mounting a missing volume would create an empty one. */
export function accountsDatabaseError(config, docker) {
  const accounts = config.volumes.dohc_self_host_postgres.name;
  const missing = `Docker volume ${accounts} holds no accounts database. Restore it from the old host or your backup before you start. ` +
    'Without it, people sign up again as new accounts that cannot open their workspaces.';
  if (!inspectVolume(accounts, docker)) return missing;
  // The probe prints its result, because Docker exits 1 for some of its own failures too.
  const { status, stdout } = docker(['run', '--rm', '--network', 'none', '--mount', `type=volume,source=${accounts},target=/pg,readonly`,
    '--entrypoint', 'sh', config.services.postgres.image, '-c', 'if test -s /pg/PG_VERSION; then echo present; else echo missing; fi']);
  const result = status === 0 ? stdout?.trim() : undefined;
  if (result === 'present') return '';
  if (result === 'missing') return missing;
  return `Could not check Docker volume ${accounts} for the accounts database. Check that Docker is running and the image ${config.services.postgres.image} is available, then try again.`;
}

const normalizeDirectory = path => path ? posix.normalize(path).replace(/(.)\/+$/, '$1') : undefined;
const bindDirectory = options => options?.o?.split(',').some(option => option === 'bind' || option === 'rbind')
  ? normalizeDirectory(options.device) : undefined;
const inside = (path, folder) => path === folder || path.startsWith(folder.endsWith('/') ? folder : `${folder}/`);
const overlapping = (a, b) => inside(a, b) || inside(b, a);

/**
 * Returns a function that lists each running container's writable mount that reaches the deployment's storage.
 * `volumes` are the deployment's existing volumes as Docker inspects them. `run(args)` returns Docker's output and throws when Docker fails.
 */
export function storageWriters(config, volumes, run) {
  const volumeNames = new Set(Object.values(config.volumes ?? {}).map(volume => volume.name));
  // A writable mount of a deployment folder, or of a folder inside or above it, can change deployment data.
  // A bound volume that Docker has not created yet still names its folder.
  const storage = [...volumes.flatMap(volume => [bindDirectory(volume.Options), normalizeDirectory(volume.Mountpoint)]),
    ...Object.values(config.volumes ?? {}).map(volume => bindDirectory(volume.driver_opts))].filter(Boolean);
  return () => {
    const ids = run(['ps', '--quiet']).trim().split(/\r?\n/).filter(Boolean);
    if (!ids.length) return [];
    const writable = JSON.parse(run(['inspect', ...ids]))
      .flatMap(container => (container.Mounts ?? []).filter(mount => mount.RW).map(mount => ({ container, mount })));
    const others = [...new Set(writable.filter(({ mount }) => mount.Type === 'volume' && !volumeNames.has(mount.Name)).map(({ mount }) => mount.Name))];
    const devices = new Map(others.length ? JSON.parse(run(['volume', 'inspect', ...others])).map(volume => [volume.Name, bindDirectory(volume.Options)]) : []);
    return writable.filter(({ mount }) => mount.Type === 'volume' && volumeNames.has(mount.Name) ||
      [normalizeDirectory(mount.Source), devices.get(mount.Name)].some(path => path && storage.some(folder => overlapping(path, folder))));
  };
}

export const describeWriters = matches => [...new Set(matches.map(({ container, mount }) =>
  `${container.Name?.replace(/^\//, '') || container.Id} (${mount.Type === 'volume' ? mount.Name : mount.Source})`))].join(', ');
