import { join } from "node:path";
import { readStoredRoster, type RosterListing } from "@dohc/automation-executor/roster-listing";
import { z } from "zod";
import type { ShareRoster } from "../automations/shareRoster";
import type { RegistryEntry } from "./registryStore";
import { observationKey, readObservationFile, removeObservationFile, writeObservationFile } from "./shareObservationFile";

const Metadata = z.object({ version: z.number().int().positive(), listedAtMs: z.number().int().nonnegative(), pulledAfter: z.literal(true).optional() });

export function createShareRosterStore(directory: string) {
  const file = (entry: RegistryEntry) => join(directory, `${observationKey([
    entry.workspaceId, entry.rootPath, entry.remote?.ownerUserId ?? "", entry.remote?.serverUrl ?? "",
  ])}.json`);
  const cache = new Map<string, ShareRoster | undefined>();
  return {
    file,
    read(entry: RegistryEntry): ShareRoster | undefined {
      const path = file(entry);
      if (cache.has(path)) return cache.get(path);
      const raw = readObservationFile(path);
      const metadata = Metadata.safeParse(raw);
      const listing = readStoredRoster(raw);
      const roster = metadata.success && listing ? { ...listing, ...metadata.data } : undefined;
      cache.set(path, roster);
      return roster;
    },
    save(entry: RegistryEntry, listing: RosterListing, pulledAfter: boolean, listedAtMs: number): ShareRoster {
      const previous = entry.shareRoster;
      const unchanged = previous !== undefined && JSON.stringify(readStoredRoster(previous)) === JSON.stringify(listing);
      if (unchanged && (previous.pulledAfter === true) === pulledAfter) return previous;
      const next: ShareRoster = { ...listing, version: (previous?.version ?? 0) + (unchanged ? 0 : 1),
        listedAtMs, ...(pulledAfter ? { pulledAfter: true as const } : {}) };
      try { writeObservationFile(file(entry), next); } catch (error) { cache.delete(file(entry)); throw error; }
      cache.set(file(entry), next);
      return next;
    },
    markPulled(entry: RegistryEntry): ShareRoster | undefined {
      if (!entry.shareRoster || entry.shareRoster.pulledAfter) return entry.shareRoster;
      const next = { ...entry.shareRoster, pulledAfter: true as const };
      writeObservationFile(file(entry), next);
      return next;
    },
    remove(entry: RegistryEntry): void { removeObservationFile(file(entry)); cache.delete(file(entry)); },
  };
}
