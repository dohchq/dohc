import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import type { SyncRelayHandler } from "./server";
import {
  openSyncRelayStorage,
  type OpenSyncRelayStorageOptions,
  type SyncRelayStorage,
} from "./storage";

export function linkSecret(value: unknown): string {
  if (typeof value !== "string") {
    throw new TypeError("Minted link URL must be a string");
  }
  const url = new URL(value);
  if (url.pathname !== "/s/") {
    throw new TypeError("Minted link URL must use the /s/ path");
  }
  const fragmentMarker = value.indexOf("#");
  const queryEnd = fragmentMarker === -1 ? value.length : fragmentMarker;
  if (value.slice(0, queryEnd).includes("?")) {
    throw new TypeError("Minted link URL must not include a query");
  }
  const secret = url.hash.slice(1);
  if (!/^[A-Za-z0-9_-]{43}$/u.test(secret)) {
    throw new TypeError("Minted link URL must have a 43-character base64url fragment");
  }
  return secret;
}

const roots: string[] = [];
const storages: SyncRelayStorage[] = [];
const storagePaths = new WeakMap<SyncRelayStorage, string>();

/** A temp directory removed by `closeTestStorages`. */
export async function tempRoot(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `dohc-sync-relay-${label}-`));
  roots.push(root);
  return root;
}

/** Opens a fresh relay database that `closeTestStorages` closes and removes. */
export async function testStorage(
  options?: OpenSyncRelayStorageOptions,
): Promise<SyncRelayStorage> {
  const dbPath = join(await tempRoot("db"), "relay.sqlite");
  return reopenTestStorage(dbPath, options);
}

export function storagePath(storage: SyncRelayStorage): string {
  const dbPath = storagePaths.get(storage);
  if (!dbPath) throw new Error("storage was not opened by testStorage");
  return dbPath;
}

/** Closes a storage mid-test so its database can be inspected or reopened. */
export function closeTestStorage(storage: SyncRelayStorage): void {
  storage.close();
  const index = storages.indexOf(storage);
  if (index >= 0) storages.splice(index, 1);
}

/** Opens (again) the database at `dbPath` under the test registry. */
export function reopenTestStorage(
  dbPath: string,
  options?: OpenSyncRelayStorageOptions,
): SyncRelayStorage {
  const storage = openSyncRelayStorage(dbPath, options);
  storages.push(storage);
  storagePaths.set(storage, dbPath);
  return storage;
}

/** For `afterEach`: closes sqlite handles before removing their directories (Windows EBUSY otherwise). */
export async function closeTestStorages(): Promise<void> {
  for (const storage of storages.splice(0)) storage.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
}

/** A relay request as the test-auth seam sees it: `Bearer user:<id>` and a fixed client address. */
export function request(userId: string | null, path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  if (userId) headers.set("authorization", `Bearer user:${userId}`);
  headers.set("x-dohc-relay-client-ip", "192.0.2.10");
  return new Request(`http://relay.test${path}`, { ...init, headers });
}

export function jsonBody(value: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  };
}

export async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

export function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function claimWorkspace(
  h: SyncRelayHandler,
  userId: string,
  workspaceId: string,
): Promise<void> {
  const response = await h(request(userId, "/sync/workspaces", jsonBody({ workspaceId })));
  expect(response.status, await response.clone().text()).toBe(200);
}

/** Mints a share at the narrowest level unless `body` names one; returns its id. */
export async function createShare(
  h: SyncRelayHandler,
  owner: string,
  workspaceId: string,
  body: Record<string, unknown>,
): Promise<string> {
  const response = await h(
    request(owner, `/sync/${workspaceId}/shares`, jsonBody({ access: "view", ...body })),
  );
  expect(response.status, await response.clone().text()).toBe(200);
  return (await json(response)).shareId as string;
}
