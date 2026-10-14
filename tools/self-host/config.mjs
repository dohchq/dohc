import { readFileSync } from 'node:fs';
import { isDeepStrictEqual, parseEnv } from 'node:util';
import { resolve } from 'node:path';

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
  for (const name of ['DOHC_RELAY_APP_PUBLICATIONS', 'DOHC_RELAY_AUTOMATIONS', 'DOHC_BEHIND_CLOUDFLARE']) {
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
  // The bootstrap generates the bundled database's password. An external database keeps its provider's password.
  for (const name of [...(settings.DOHC_POSTGRES_HOST ? [] : ['POSTGRES_PASSWORD']), 'BETTER_AUTH_SECRET', 'DOHC_RELAY_LINK_KEY', 'DOHC_RELAY_EXCHANGE_KEY']) {
    if ((settings[name]?.length ?? 0) < 32) errors.push(`${name} must contain at least 32 characters.`);
  }
  if (settings.DOHC_POSTGRES_HOST) {
    if (!/^(?=.{1,253}$)[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*$/.test(settings.DOHC_POSTGRES_HOST) ||
      /(^|\.)example\.(com|net|org)$/i.test(settings.DOHC_POSTGRES_HOST)) {
      errors.push('Set DOHC_POSTGRES_HOST to your database host name or IPv4 address, or leave it empty to use the bundled database.');
    }
    if (!/^[1-9]\d*$/.test(settings.DOHC_POSTGRES_PORT ?? '') || Number(settings.DOHC_POSTGRES_PORT) < 1 || Number(settings.DOHC_POSTGRES_PORT) > 65535) {
      errors.push('Set DOHC_POSTGRES_PORT to your database port.');
    }
    if (!/^(\/(?!\.\.?(\/|$))[a-zA-Z0-9._-]+)+$/.test(settings.DOHC_POSTGRES_CA_FILE ?? '')) {
      errors.push("Set DOHC_POSTGRES_CA_FILE to the absolute path of your database provider's CA certificate.");
    }
  } else if (settings.DOHC_POSTGRES_PORT || settings.DOHC_POSTGRES_CA_FILE) {
    errors.push('Set DOHC_POSTGRES_HOST to use an external database, or leave DOHC_POSTGRES_PORT and DOHC_POSTGRES_CA_FILE empty.');
  }
  // Services connect through a URL. A dot segment or reserved character would come back as another database name.
  for (const name of ['POSTGRES_DB', 'POSTGRES_USER']) {
    if (!settings[name]) { if (settings.DOHC_POSTGRES_HOST) errors.push(`Set ${name} for the external database.`); }
    else if (!/^(?=.*[^.])[a-zA-Z0-9_.-]+$/.test(settings[name])) {
      errors.push(`Use only letters, digits, underscores, hyphens and dots in ${name}, with at least one character that is not a dot.`);
    }
  }
  try {
    const origin = new URL(settings.DOHC_PUBLIC_ORIGIN);
    if (origin.protocol !== 'https:' || origin.origin !== settings.DOHC_PUBLIC_ORIGIN || origin.username || origin.password ||
      origin.host !== settings.DOHC_PUBLIC_HOST || /(^|\.)example\.(com|net|org)$/.test(origin.hostname)) throw new Error();
  } catch { errors.push('Set DOHC_PUBLIC_ORIGIN to your HTTPS origin and DOHC_PUBLIC_HOST to its exact host.'); }
  if (!['public', 'private'].includes(settings.DOHC_SERVER_NETWORK_ACCESS)) errors.push('Set DOHC_SERVER_NETWORK_ACCESS to public or private.');
  if (settings.DOHC_BEHIND_CLOUDFLARE === '1' && settings.DOHC_SERVER_NETWORK_ACCESS !== 'public') {
    errors.push('Cloudflare requires public mode. Set DOHC_SERVER_NETWORK_ACCESS to public or DOHC_BEHIND_CLOUDFLARE to 0.');
  }
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

/** Refuses invalid settings, so a command stops before any Docker or database operation uses them. */
export function readValidSettings(path) {
  const settings = readSettings(path), errors = validateSettings(settings);
  if (errors.length) throw new Error(errors.join('\n'));
  return settings;
}

export function composeArgs(envFile, settings, ...args) {
  return ['compose', '--env-file', resolve(envFile), '-f', 'docker-compose.self-host.yml',
    ...(settings.DOHC_SERVER_NETWORK_ACCESS === 'private' ? ['-f', 'tools/self-host/compose.private.yml'] : []),
    ...(settings.DOHC_DATA_DIRECTORY ? ['-f', 'tools/self-host/compose.data-disk.yml'] : []),
    ...(settings.DOHC_POSTGRES_HOST ? ['-f', 'tools/self-host/compose.external-postgres.yml'] : []),
    ...(settings.DOHC_BEHIND_CLOUDFLARE === '1' ? ['-f', 'tools/self-host/compose.cloudflare.yml'] : []), ...args];
}

// Reads through the relay's own volumes, so it checks the folders Docker mounts. Any other exit status means the check failed.
const relayDeployment = { found: 0, missingFile: 3, empty: 4 };
export const relayDeploymentCheck = "const fs=require('node:fs');const exists=path=>fs.statSync(path,{throwIfNoEntry:false})!==undefined;" +
  "const missing=['/continuity/deployment.json','/data/sync-relay.sqlite'].filter(path=>!exists(path));" +
  "if(missing.length){console.error('Missing '+missing.join(', '));" +
  `process.exitCode=['/continuity','/data'].every(folder=>fs.readdirSync(folder).length===0)?${relayDeployment.empty}:${relayDeployment.missingFile};}`;

/** `docker(args)` returns `{status, stdout, stderr}`. */
export function composeConfig(envFile, settings, docker) {
  const result = docker(composeArgs(envFile, settings, 'config', '--format', 'json'));
  // Compose config contains secrets. Never include its output in errors.
  if (result.status !== 0) throw new Error('Docker Compose could not read the deployment configuration.');
  return JSON.parse(result.stdout);
}

/** Returns undefined only when Docker reports that the volume does not exist. */
function inspectVolume(name, docker) {
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

/** A first start needs empty relay storage. Every later start needs the deployment on the data disk. */
export function relayDeploymentError(envFile, settings, docker, firstStart) {
  const { status } = docker(composeArgs(envFile, settings, 'run', '--rm', '--no-deps', '-T',
    '--entrypoint', 'node', 'relay-initialize', '-e', relayDeploymentCheck));
  const directory = settings.DOHC_DATA_DIRECTORY;
  if (![relayDeployment.found, relayDeployment.missingFile, relayDeployment.empty].includes(status)) {
    return directory ? `Could not check the data disk in ${directory}. Check that the disk is mounted there and Docker is running, then try again.`
      : "Could not check the relay's Docker volumes. Check that Docker is running, then try again.";
  }
  if (firstStart) {
    if (status === relayDeployment.empty) return '';
    return `${directory ? `${directory} already holds` : "The relay's Docker volumes already hold"} relay data. Start without --first-start.`;
  }
  if (status === relayDeployment.empty) {
    return `No relay deployment found in ${directory}. Mount the data disk there and try again. ` +
      'Never recreate its folders: setup would create a new deployment.';
  }
  if (status === relayDeployment.missingFile) {
    return `The relay deployment in ${directory} is missing its record or its database. Keep the disk unchanged and check that it is this deployment's disk.`;
  }
  return '';
}

const lostAccounts = 'Without it, people sign up again as new accounts that cannot open their workspaces.';

/** An external database must hold dohc's schema. The bundled accounts volume is inspected before a container mounts it: mounting a missing volume would create an empty one. */
export function accountsDatabaseError(envFile, settings, config, docker) {
  // Each check prints its result, because Docker exits 1 for some of its own failures too.
  if (settings.DOHC_POSTGRES_HOST) {
    const { status, stdout } = docker(composeArgs(envFile, settings, 'run', '--rm', '--no-deps', '-T', 'postgres-migrate', 'check-accounts'));
    const result = status === 0 ? stdout?.trim() : undefined, database = `${settings.POSTGRES_DB} on ${settings.DOHC_POSTGRES_HOST}`;
    if (result === 'present') return '';
    if (result === 'missing') return `Database ${database} holds no dohc accounts. Check DOHC_POSTGRES_HOST and POSTGRES_DB, or restore the database from your provider's backup. ${lostAccounts}`;
    return `Could not check database ${database}. Check that Docker is running and that its host, port, user, password and DOHC_POSTGRES_CA_FILE are correct, then try again.`;
  }
  const accounts = config.volumes.dohc_self_host_postgres.name;
  const missing = `Docker volume ${accounts} holds no accounts database. Restore it from the old host or your backup before you start. ${lostAccounts}`;
  if (!inspectVolume(accounts, docker)) return missing;
  const { status, stdout } = docker(['run', '--rm', '--network', 'none', '--mount', `type=volume,source=${accounts},target=/pg,readonly`,
    '--entrypoint', 'sh', config.services.postgres.image, '-c', 'if test -s /pg/PG_VERSION; then echo present; else echo missing; fi']);
  const result = status === 0 ? stdout?.trim() : undefined;
  if (result === 'present') return '';
  if (result === 'missing') return missing;
  return `Could not check Docker volume ${accounts} for the accounts database. Check that Docker is running and the image ${config.services.postgres.image} is available, then try again.`;
}

/** Returns `[name, problem]` pairs to check before Compose mounts any volume. An empty problem passes; the first problem ends the checks. */
export function deploymentChecks(envFile, settings, docker, { start, firstStart }) {
  const checks = [];
  let config;
  if (settings.DOHC_DATA_DIRECTORY) {
    let problems;
    try {
      config = composeConfig(envFile, settings, docker);
      problems = dataDiskVolumeErrors(config, docker);
    } catch (error) { problems = [error.message]; }
    checks.push(['data disk volumes', problems.join(' ')]);
    if (problems.length) return checks;
  }
  // A first start with an external database creates its accounts, which would not own an existing relay deployment's workspaces.
  if (start && (settings.DOHC_DATA_DIRECTORY || firstStart && settings.DOHC_POSTGRES_HOST)) {
    const problem = relayDeploymentError(envFile, settings, docker, firstStart);
    checks.push([settings.DOHC_DATA_DIRECTORY ? 'relay deployment on the data disk' : 'relay deployment', problem]);
    if (problem) return checks;
  }
  // Every start after the first needs the accounts that own the deployment's workspaces.
  if (start && !firstStart && (settings.DOHC_DATA_DIRECTORY || settings.DOHC_POSTGRES_HOST)) {
    let problem;
    try { problem = accountsDatabaseError(envFile, settings, config, docker); } catch (error) { problem = error.message; }
    checks.push(['accounts database', problem]);
  }
  return checks;
}
