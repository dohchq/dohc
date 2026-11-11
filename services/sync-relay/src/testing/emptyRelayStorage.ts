import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { openSyncRelayStorage, type OpenSyncRelayStorageOptions } from "../storage";

let emptyImage: Buffer | undefined;

/** Copies a closed empty schema; every consumer uses the production open path. */
export function openEmptyRelayTestStorage(path: string, options?: OpenSyncRelayStorageOptions) {
  if (existsSync(`${path}-wal`)) throw new Error(`Cannot create fresh relay test storage beside an existing WAL: ${path}-wal`);
  if (!emptyImage) {
    const root = mkdtempSync(join(tmpdir(), "dohc-empty-relay-"));
    const seed = join(root, "relay.sqlite");
    try {
      openSyncRelayStorage(seed).close();
      emptyImage = readFileSync(seed);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, emptyImage, { flag: "wx" });
  try { return openSyncRelayStorage(path, options); }
  catch (error) {
    try { rmSync(path); } catch {}
    throw error;
  }
}
