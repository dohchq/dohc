import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { spawnSyncRelay } from "../../e2e/helpers/syncRelay";
import { createTestScratch } from "../workspaces/testTemp";

// Allow the helper's 120 s listening wait, 15 s shutdown guard, and scratch cleanup.
// A loaded relay must report its own readiness or startup failure before the test ends.
it("starts an isolated desktop E2E relay with inherited device-delivery configuration", async () => {
  // The relay's deployment refuses a path through a symlink, such as macOS's /var.
  const root = await createTestScratch("dohc-desktop-relay-env-");
  vi.stubEnv("DOHC_RELAY_DEVICE_DELIVERY_CONFIG", "inherited-device-delivery-must-not-open.json");
  let relay: Awaited<ReturnType<typeof spawnSyncRelay>> | undefined;
  try {
    relay = await spawnSyncRelay({ dbPath: join(root, "relay", "relay.sqlite") });
    expect(relay.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:/);
    expect(existsSync(`${relay.dbPath}-wal`)).toBe(true);
    await relay.stop();
    // SQLite removes its WAL when its last connection closes normally.
    expect(existsSync(`${relay.dbPath}-wal`)).toBe(false);
    expect(existsSync(`${relay.dbPath}-shm`)).toBe(false);
  } finally {
    vi.unstubAllEnvs();
    await relay?.stop();
    await rm(root, { recursive: true, force: true });
  }
}, 180_000);
