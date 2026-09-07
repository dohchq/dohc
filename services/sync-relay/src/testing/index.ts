// The one test harness for the relay suites: temp storage, sqlite inspection,
// the test-auth request shape, a handler with test defaults, and the op
// builders every route suite appends. Every relay test file imports from here.
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnauthorizedError } from "@dohc/workspace-auth/session";
import { expect } from "vitest";
import {
  createSyncRelayHandler,
  type CreateSyncRelayHandlerOptions,
  type SyncRelayHandler,
} from "../server";
import {
  openSyncRelayStorage,
  type OpenSyncRelayStorageOptions,
  type SyncRelayShareGrantRow,
  type SyncRelayStorage,
} from "../storage";

export const LINK_KEY = "test-link-key-with-at-least-thirty-two-bytes";
export const RELAY_EXCHANGE_KEY = "share-web-relay-exchange-key-at-least-32";
export const SHARE_WEB_ORIGIN = "https://share.example.test";
export const TEST_CLIENT_IP = "192.0.2.10";
export const TEST_EMAIL_SUFFIX = "@dohc.test";

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

// --- storage lifecycle -------------------------------------------------------

const roots: string[] = [];
const storages: SyncRelayStorage[] = [];
const storagePaths = new WeakMap<SyncRelayStorage, string>();
const inspections: InspectionDatabase[] = [];

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
  for (const inspection of inspections.splice(0)) {
    if (inspection.isOpen) inspection.close();
  }
  for (const storage of storages.splice(0)) storage.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
}

// --- raw sqlite inspection ---------------------------------------------------

export interface InspectionStatement {
  all(...params: unknown[]): Array<Record<string, unknown>>;
  get(...params: unknown[]): Record<string, unknown> | undefined;
  iterate(...params: unknown[]): IterableIterator<Record<string, unknown>>;
  run(...params: unknown[]): { changes: number | bigint };
}

export interface InspectionDatabase {
  readonly isOpen: boolean;
  prepare(sql: string): InspectionStatement;
  exec(sql: string): void;
  close(): void;
}

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => InspectionDatabase;
};

/**
 * A raw connection to a relay database, closed by `closeTestStorages` if the
 * test does not close it first. Writable connections wait on the relay write
 * lock instead of failing SQLITE_BUSY.
 */
export function inspectDatabase(
  dbPath: string,
  options: { readOnly?: boolean; foreignKeys?: boolean } = {},
): InspectionDatabase {
  const database = new DatabaseSync(dbPath, { readOnly: options.readOnly });
  if (!options.readOnly) database.exec("PRAGMA busy_timeout = 5000");
  if (options.foreignKeys) database.exec("PRAGMA foreign_keys = ON");
  inspections.push(database);
  return database;
}

/** Runs `query` on a read-only connection and closes it. */
export function inspect<T>(dbPath: string, query: (db: InspectionDatabase) => T): T {
  const db = inspectDatabase(dbPath, { readOnly: true });
  try {
    return query(db);
  } finally {
    db.close();
  }
}

export function countRows(dbPath: string, table: string): number {
  return inspect(dbPath, (db) =>
    Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count ?? 0),
  );
}

// --- storage interception ----------------------------------------------------

export type StorageMethod = {
  [K in keyof SyncRelayStorage]: SyncRelayStorage[K] extends (...args: never[]) => unknown
    ? K
    : never;
}[keyof SyncRelayStorage];

export type StorageOverrides = {
  [M in StorageMethod]?: (
    target: SyncRelayStorage,
    ...args: Parameters<SyncRelayStorage[M]>
  ) => ReturnType<SyncRelayStorage[M]>;
};

/**
 * A storage whose overridden methods run the replacement instead, with the
 * real storage as its first argument. Every other member is the real one. This
 * is how a test lands a concurrent change inside a route, counts a storage
 * call, or makes one call throw.
 */
export function interceptStorage(
  storage: SyncRelayStorage,
  overrides: StorageOverrides,
): SyncRelayStorage {
  return new Proxy(storage, {
    get(target, property, receiver) {
      const override =
        typeof property === "string" ? overrides[property as StorageMethod] : undefined;
      if (override) {
        return (...args: unknown[]) =>
          (override as (target: SyncRelayStorage, ...input: unknown[]) => unknown)(target, ...args);
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** Counts calls to one storage method; the calls themselves go through. */
export function countStorageCalls<M extends StorageMethod>(
  storage: SyncRelayStorage,
  method: M,
): { storage: SyncRelayStorage; calls: Array<Parameters<SyncRelayStorage[M]>> } {
  const calls: Array<Parameters<SyncRelayStorage[M]>> = [];
  return {
    calls,
    storage: interceptStorage(storage, {
      [method]: (target: SyncRelayStorage, ...args: Parameters<SyncRelayStorage[M]>) => {
        calls.push(args);
        const real = target[method] as (
          this: SyncRelayStorage,
          ...input: Parameters<SyncRelayStorage[M]>
        ) => ReturnType<SyncRelayStorage[M]>;
        return real.call(target, ...args);
      },
    } as StorageOverrides),
  };
}

// --- handler -----------------------------------------------------------------

/** The relay test-auth seam: `Bearer user:<id>` is the identity. */
export function resolveTestActor(
  request: Request,
  workspaceId: string,
): { userId: string; workspaceId: string } {
  const match = /^Bearer user:([^ ]+)$/u.exec(request.headers.get("authorization") ?? "");
  if (!match) throw new UnauthorizedError();
  return { userId: match[1]!, workspaceId };
}

// Minted ids (credentials, sessions, proposals) are unique across handlers so two
// handlers on one storage never collide; share and grant ids restart per handler.
let mintedId = 0;

export type HandlerOverrides = Partial<CreateSyncRelayHandlerOptions>;

/**
 * A relay handler over `storage` with test defaults: the bearer seam, emails
 * as `<userId>@dohc.test`, a fixed clock, sequential minted ids, and the test
 * link key and share-web origin. Pass `overrides` for what a test pins.
 */
export function testHandler(
  storage: SyncRelayStorage,
  overrides: HandlerOverrides = {},
): SyncRelayHandler {
  let shareId = 0;
  let grantId = 0;
  return createSyncRelayHandler({
    storage,
    resolveActor: resolveTestActor,
    nowMs: () => 2_000,
    resolveUserIdByEmail: (email) =>
      email.endsWith(TEST_EMAIL_SUFFIX) && email.length > TEST_EMAIL_SUFFIX.length
        ? email.slice(0, -TEST_EMAIL_SUFFIX.length)
        : null,
    lookupUserEmail: (userId) => `${userId}${TEST_EMAIL_SUFFIX}`,
    lookupVerifiedUserEmail: (userId) => `${userId}${TEST_EMAIL_SUFFIX}`,
    newShareId: () => `share-${shareId++}`,
    newGrantId: () => `grant-${grantId++}`,
    newId: () => `id-${mintedId++}`,
    linkKey: LINK_KEY,
    shareWebOrigin: SHARE_WEB_ORIGIN,
    ...overrides,
  });
}

// --- requests ----------------------------------------------------------------

/** A relay request as the test-auth seam sees it: `Bearer user:<id>` and a fixed client address. */
export function request(userId: string | null, path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  if (userId !== null) headers.set("authorization", `Bearer user:${userId}`);
  headers.set("x-dohc-relay-client-ip", TEST_CLIENT_IP);
  return new Request(`http://relay.test${path}`, { ...init, headers });
}

/** An accountless request carrying a link capability token. */
export function linkRequest(capability: string, path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("authorization", `LinkCapability ${capability}`);
  return request(null, path, { ...init, headers });
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

/**
 * A denial as comparable bytes. Every unauthorized probe must be
 * indistinguishable from a share that never existed, so the proof is a string
 * comparison, not a status check.
 */
export async function denialBytes(response: Response): Promise<string> {
  expect(response.status).toBe(404);
  return `${response.status}:${await response.text()}`;
}

export function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// --- routes every suite drives -----------------------------------------------

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

/** Uploads `content` to the owner blob store and returns its sha. */
export async function putBlob(
  h: SyncRelayHandler,
  owner: string,
  workspaceId: string,
  content: string | Uint8Array,
): Promise<string> {
  const sha = sha256(content);
  const response = await h(
    request(owner, `/sync/${workspaceId}/blobs/${sha}`, {
      method: "PUT",
      body: typeof content === "string" ? content : Buffer.from(content),
    }),
  );
  expect(response.status, await response.clone().text()).toBe(200);
  return sha;
}

/** Appends `ops` to the owner log under one origin. */
export async function appendLog(
  h: SyncRelayHandler,
  owner: string,
  workspaceId: string,
  ops: unknown[],
  body: Record<string, unknown> = {},
): Promise<void> {
  const response = await h(
    request(owner, `/sync/${workspaceId}/log`, jsonBody({ originId: "origin-a", ops, ...body })),
  );
  expect(response.status, await response.clone().text()).toBe(200);
}

// --- op builders -------------------------------------------------------------

export interface LogOp extends Record<string, unknown> {
  originSeq: number;
  opKind: string;
  payload: Record<string, unknown>;
  recordedAtMs: number;
}

export type MomentOptions = {
  originSeq?: number;
  recordedAtMs?: number;
  momentId?: string;
  versionId?: string;
  objectId?: string | null;
  operation?: "write" | "rename" | "delete";
  beforePath?: string | null;
  beforeContent?: string | null;
  afterPath?: string | null;
  afterContent?: string | null;
  payload?: Record<string, unknown>;
};

let opSeq = 0;

/** A log op at the next origin sequence, recorded one ms per sequence. */
export function logOp(opKind: string, payload: Record<string, unknown>): LogOp {
  const originSeq = opSeq++;
  return { originSeq, opKind, payload, recordedAtMs: 1000 + originSeq };
}

/** Restarts the shared origin sequence; call when a test needs `originSeq` 0. */
export function resetOpSeq(): void {
  opSeq = 0;
}

/** The next origin sequence, for a raw op written inline. */
export function nextOpSeq(): number {
  return opSeq++;
}

/**
 * A `moment.append` op writing `content` at `path`. The default is a fresh
 * write of a new object at the next origin sequence; options name the other
 * shapes (rename, delete, a version fork) and `payload` overrides any field.
 */
export function moment(path: string, content: string, options: MomentOptions = {}): LogOp {
  const originSeq = options.originSeq ?? opSeq++;
  const recordedAtMs = options.recordedAtMs ?? 1000 + originSeq;
  const beforeContent = options.beforeContent ?? null;
  const afterContent = options.afterContent === undefined ? content : options.afterContent;
  const beforePath = options.beforePath ?? null;
  const afterPath = options.afterPath === undefined ? path : options.afterPath;
  return {
    originSeq,
    opKind: "moment.append",
    payload: {
      momentId: options.momentId ?? `moment-${originSeq}`,
      versionId: options.versionId ?? "main",
      objectId: options.objectId === undefined ? `object-${originSeq}` : options.objectId,
      path,
      recordedAtMs,
      operation: options.operation ?? "write",
      payloadBeforeBlobSha256: beforeContent === null ? null : sha256(beforeContent),
      payloadBeforePath: beforePath,
      payloadAfterBlobSha256: afterContent === null ? null : sha256(afterContent),
      payloadAfterPath: afterPath,
      metadata: { origin: "user" },
      beforePresent: beforeContent === null ? "null" : "present",
      ...options.payload,
    },
    recordedAtMs,
  };
}

export interface ChatOp extends Record<string, unknown> {
  opKind: string;
  payload: Record<string, unknown>;
}

export function chatChannelCreate(
  wireId: string,
  options: {
    name?: string;
    slug?: string;
    kind?: string;
    channelId?: string;
  } & Record<string, unknown> = {},
): ChatOp {
  const { name, slug, kind, channelId, ...extra } = options;
  return {
    opKind: "chat.channel.create",
    payload: {
      channelId: channelId ?? `channel-${wireId}`,
      name: name ?? `name-${wireId}`,
      slug: slug ?? `slug-${wireId}`,
      kind: kind ?? "channel",
      createdAtMs: 1,
      wireId,
      ...extra,
    },
  };
}

export function chatThreadCreate(
  threadId: string,
  wireId: string,
  options: { slug?: string; title?: string } & Record<string, unknown> = {},
): ChatOp {
  const { slug, title, ...extra } = options;
  return {
    opKind: "chat.thread.create",
    payload: {
      threadId,
      title: title ?? "",
      createdAtMs: 2,
      channelSlug: slug ?? `slug-${wireId}`,
      channelWireId: wireId,
      ...extra,
    },
  };
}

export function chatMessageAppend(
  messageId: string,
  threadId: string,
  body: string,
  options: { authorUserId?: string; authorDisplayName?: string } & Record<string, unknown> = {},
): ChatOp {
  const { authorUserId, authorDisplayName, ...extra } = options;
  return {
    opKind: "chat.message.append",
    payload: {
      messageId,
      threadId,
      authorKind: "human",
      authorDisplayName: authorDisplayName ?? "Someone",
      ...(authorUserId === undefined ? {} : { authorUserId }),
      body,
      createdAtMs: 3,
      ...extra,
    },
  };
}

/** Stamps dense origin sequences and recorded times onto raw ops from `firstSeq`. */
export function sequenced(ops: ChatOp[], firstSeq = 0, recordedAtBase = 1000): LogOp[] {
  return ops.map((op, index) => ({
    ...op,
    originSeq: firstSeq + index,
    recordedAtMs: recordedAtBase + firstSeq + index,
  }));
}

// --- storage-level seeds -----------------------------------------------------

/** Inserts an active link grant with one current credential. */
export function seedLinkGrant(
  storage: SyncRelayStorage,
  input: {
    grantId: string;
    shareId: string;
    secretHash: string;
    access?: "view" | "comment" | "edit";
    createdAtMs?: number;
    credentialId?: string;
  },
): void {
  const createdAtMs = input.createdAtMs ?? 2_001;
  expect(
    storage.createLinkGrant({
      grant: {
        grantId: input.grantId,
        shareId: input.shareId,
        principalKind: "link",
        principalUserId: null,
        principalEmail: null,
        access: input.access ?? "view",
        generation: 1,
        status: "active",
        createdAtMs,
        revokedAtMs: null,
        parentGrantId: null,
      },
      credential: {
        credentialId: input.credentialId ?? `${input.grantId}-credential`,
        grantId: input.grantId,
        secretHash: input.secretHash,
        generation: 1,
        mintedAtMs: createdAtMs,
        retiredAtMs: null,
      },
    }),
  ).toBe(true);
}

/** Inserts a live accountless session on a link grant. */
export function seedLinkSession(
  storage: SyncRelayStorage,
  input: {
    grantId: string;
    capabilityHash: string;
    sessionId?: string;
    generation?: number;
    mintedAtMs?: number;
    expiresAtMs?: number;
  },
): void {
  expect(
    storage.mintLinkSession({
      session: {
        sessionId: input.sessionId ?? `${input.grantId}-session`,
        capabilityHash: input.capabilityHash,
        grantId: input.grantId,
        generation: input.generation ?? 1,
        mintedAtMs: input.mintedAtMs ?? 2_002,
        expiresAtMs: input.expiresAtMs ?? 1_000_000,
      },
    }),
  ).toBe(true);
}

/**
 * Inserts a named dependent grant under an active link grant at the link's
 * current access, the row the handoff redeem route writes. Returns the same
 * shape as the storage transitions so a test can assert on it.
 */
export function seedDependentGrant(
  storage: SyncRelayStorage,
  input: {
    shareId: string;
    parentGrantId: string;
    grantId: string;
    principalUserId: string;
    createdAtMs: number;
  },
): { ok: true; grant: SyncRelayShareGrantRow } | { ok: false } {
  const parent = storage.getShareGrant(input.parentGrantId);
  if (
    !parent ||
    parent.shareId !== input.shareId ||
    parent.principalKind !== "link" ||
    parent.status !== "active" ||
    parent.revokedAtMs !== null ||
    !input.principalUserId
  ) {
    return { ok: false };
  }
  const db = inspectDatabase(storagePath(storage));
  try {
    db.prepare(
      `INSERT INTO sync_relay_share_grants (
         grant_id, share_id, principal_kind, principal_user_id, principal_email,
         access, generation, status, created_at_ms, revoked_at_ms, parent_grant_id
       ) VALUES (?, ?, 'user', ?, NULL, ?, 1, 'active', ?, NULL, ?)`,
    ).run(
      input.grantId,
      input.shareId,
      input.principalUserId,
      parent.access,
      Math.trunc(input.createdAtMs),
      parent.grantId,
    );
  } finally {
    db.close();
  }
  const grant = storage.getShareGrant(input.grantId);
  if (!grant) throw new Error("dependent grant did not insert");
  return { ok: true, grant };
}

/** When the owner paused link discussion writes on `shareId`, or null. */
export function linkWritesPausedAtMs(dbPath: string, shareId: string): number | null {
  return inspect(dbPath, (db) => {
    const row = db
      .prepare("SELECT link_writes_paused_at_ms FROM sync_relay_shares WHERE share_id = ?")
      .get(shareId);
    const value = row?.link_writes_paused_at_ms;
    return value === null || value === undefined ? null : Number(value);
  });
}

/** The replaced key envelopes of a workspace, oldest first. */
export function keyEnvelopeHistory(
  dbPath: string,
  workspaceId: string,
): Array<{ envelopeJson: string; sha256: string; replacedAtMs: number; replacedBySha256: string }> {
  return inspect(dbPath, (db) =>
    db
      .prepare(
        `SELECT envelope_json, envelope_sha256, replaced_at_ms, replaced_by_sha256
         FROM sync_relay_key_envelope_history
         WHERE workspace_id = ?
         ORDER BY history_seq`,
      )
      .all(workspaceId)
      .map((row) => ({
        envelopeJson: String(row.envelope_json),
        sha256: String(row.envelope_sha256),
        replacedAtMs: Number(row.replaced_at_ms),
        replacedBySha256: String(row.replaced_by_sha256),
      })),
  );
}
