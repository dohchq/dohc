import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
export async function readReservationBounds(checkout) {
  const { selfHostLiveProfile } = await import(
    pathToFileURL(join(checkout, 'services/sync-relay/src/selfHostLiveProfile.ts')).href
  );
  const profile = selfHostLiveProfile();
  const rust = await readFile(join(checkout, 'crates/dohc-engine-storage/src/limits.rs'), 'utf8');
  const match = rust.match(/MAX_LIVE_ACCEPTED_HEADER_BYTES: usize = ([\d_]+);/);
  if (!match) throw Error('Cannot read native accepted header bound');
  return {
    maxEvents: profile.service.restore.maxEvents,
    headerBytes: Number(match[1].replaceAll('_', '')),
    reserveBytes: profile.service.ingress.applicationWorkingReserveBytes,
    relayAggregateBytes: profile.service.restore.aggregateBytes,
    nativeAggregateBytes: profile.service.ingress.aggregateBytes,
  };
}
