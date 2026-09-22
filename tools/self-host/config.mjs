import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
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
  for (const name of ['DOHC_RELAY_APP_PUBLICATIONS']) {
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
  return errors;
}

export function composeArgs(envFile, settings, ...args) {
  return ['compose', '--env-file', resolve(envFile), '-f', 'docker-compose.self-host.yml',
    ...(settings.DOHC_SERVER_NETWORK_ACCESS === 'private' ? ['-f', 'tools/self-host/compose.private.yml'] : []), ...args];
}
