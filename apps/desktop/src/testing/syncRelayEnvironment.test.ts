import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { spawnSyncRelay } from "../../e2e/helpers/syncRelay";

it("starts an isolated desktop E2E relay with inherited device-delivery configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "dohc-desktop-relay-env-"));
  vi.stubEnv("DOHC_RELAY_DEVICE_DELIVERY_CONFIG", "inherited-device-delivery-must-not-open.json");
  let relay: Awaited<ReturnType<typeof spawnSyncRelay>> | undefined;
  try {
    relay = await spawnSyncRelay({ dbPath: join(root, "relay.sqlite") });
    expect(relay.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:/);
  } finally {
    vi.unstubAllEnvs();
    await relay?.stop();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
