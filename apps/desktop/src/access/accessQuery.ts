import { createHash } from "node:crypto";
import { z } from "zod";
import { visibleSharePath } from "@dohc/security-contract/share-selector";
import { AccessShareRow, type AccessAnswer, type AccessObjectRef } from "@dohc/workspace-contracts/access";
import type { RosterListing } from "@dohc/automation-executor/roster-listing";
import type { RosterObservation } from "../automations/shareRoster";
import type { ReceivedObservation } from "../workspaces/receivedShareStore";

const Cursor = z.object({ version: z.literal(1), query: z.string().regex(/^[a-f0-9]{64}$/), after: z.string().max(1024) }).strict();
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const key = (row: AccessShareRow) => `${row.shareId}\0${row.grantId}\0${row.via}`;
const version = (id: string | null) => id ?? "main";

export function encodeAccessCursor(query: string, after: string): string {
  return Buffer.from(JSON.stringify({ version: 1, query, after })).toString("base64url");
}
export function decodeAccessCursor(cursor: string, query: string): string | null {
  try {
    const decoded = Cursor.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
    return decoded.query === query ? decoded.after : null;
  } catch { return null; }
}

export type AccessRosterObservation = RosterObservation & { unknownReason?: NonNullable<AccessAnswer["unknownReason"]> };

export function unknownAccess(ref: AccessObjectRef | null, unknownReason: NonNullable<AccessAnswer["unknownReason"]>, visibility: AccessAnswer["visibility"] = "unknown"): AccessAnswer {
  return { ref, rows: [], visibility, unknownReason, coverage: { kind: "unavailable", complete: false, observation: "interval" },
    checkedAtMs: null, freshness: "unknown", nextCursor: null };
}

export function accessPage<Row>(rows: readonly Row[], rowKey: (row: Row) => string, query: string, cursor?: string): { rows: Row[]; nextCursor: string | null } | null {
  let after = "";
  if (cursor !== undefined) {
    const decoded = decodeAccessCursor(cursor, query);
    if (decoded === null) return null;
    after = decoded;
  }
  let lo = 0, hi = rows.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (rowKey(rows[mid]!) <= after) lo = mid + 1; else hi = mid; }
  const selected = rows.slice(lo, lo + 100);
  return { rows: selected, nextCursor: lo + selected.length < rows.length
    ? encodeAccessCursor(query, rowKey(selected.at(-1)!)) : null };
}

/** A parsed observation owns one index. Queries walk slash-delimited ancestors, not all grants. */
export function createAccessIndex(input: readonly AccessShareRow[]) {
  const rows = [...input].sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
  const fingerprint = digest(JSON.stringify(rows));
  const paths = new Map<string, AccessShareRow[]>(), whole = new Map<string, AccessShareRow[]>(), chats = new Map<string, AccessShareRow[]>();
  function add(map: Map<string, AccessShareRow[]>, id: string, row: AccessShareRow) {
    const bucket = map.get(id); if (bucket) bucket.push(row); else map.set(id, [row]);
  }
  for (const row of rows) {
    const selector = row.selector;
    if (!selector || row.status !== "active") continue;
    if (selector.kind === "chat" || selector.kind === "group") add(chats, selector.channelWireId, row);
    if (selector.kind === "chat" || selector.kind === "group" && row.fileScope !== "served") continue;
    if (selector.paths.length === 0) add(whole, version(selector.versionId), row);
    for (const path of selector.paths) add(paths, `${version(selector.versionId)}\0${path}`, row);
  }
  const matched = new Map<string, AccessShareRow[]>();
  return {
    rows, fingerprint,
    forPath(input: { versionId: string | null; path: string }): AccessShareRow[] {
      const cacheKey = `${version(input.versionId)}\0${input.path}`;
      const cached = matched.get(cacheKey); if (cached) return cached;
      // Use the relay's matcher to enforce its tracked/secret path boundary even for whole-version grants.
      if (visibleSharePath({ paths: [], versionId: version(input.versionId) }, input.path) !== input.path) return [];
      const found = new Map<string, AccessShareRow>();
      const collect = (bucket: readonly AccessShareRow[] | undefined) => {
        for (const row of bucket ?? []) {
          const selector = row.selector;
          if (selector && selector.kind !== "chat" && visibleSharePath(selector, input.path) !== null) found.set(key(row), row);
        }
      };
      collect(whole.get(version(input.versionId)));
      let path = input.path;
      while (path) { collect(paths.get(`${version(input.versionId)}\0${path}`)); const slash = path.lastIndexOf("/"); if (slash < 0) break; path = path.slice(0, slash); }
      const result = [...found.values()].sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
      if (matched.size === 256) matched.delete(matched.keys().next().value!);
      matched.set(cacheKey, result);
      return result;
    },
    forChat(channelWireId: string): AccessShareRow[] { return chats.get(channelWireId) ?? []; },
  };
}

function grantedRows(listing: RosterListing): AccessShareRow[] {
  if (listing.grants === null) return [];
  const linkShares = new Set(listing.links.map(link => link.grant.shareId));
  const rows = new Map<string, AccessShareRow>();
  const add = (grant: unknown, via: AccessShareRow["via"]) => {
    const row = AccessShareRow.parse({ ...(grant as object), kind: "share", via });
    if (!rows.has(key(row))) rows.set(key(row), row);
  };
  for (const grant of listing.grants) add(grant, linkShares.has(grant.shareId) ? "dependent" : "named");
  for (const link of listing.links) add({ ...link.grant, status: link.ended ? "revoked" : link.grant.status }, "link");
  for (const former of listing.formerGrants) add(former.grant, linkShares.has(former.grant.shareId) ? "dependent" : "named");
  for (const ended of listing.endedGrants) add({ ...ended, selector: null, access: null }, "named");
  return [...rows.values()];
}

function receivedRows(observation: ReceivedObservation, recipientUserId: string): AccessShareRow[] {
  if (!observation.inventory) return [];
  return [
    ...observation.inventory.received.map(row => AccessShareRow.parse({ ...row, kind: "share", via: "received",
      status: "damaged" in row ? "damaged" : "active", recipientUserId, recipientEmail: null,
      access: "damaged" in row ? null : row.access, subjectName: row.subjectName ?? null, sharerName: row.sharerName ?? null })),
    ...observation.inventory.removed.map(row => AccessShareRow.parse({ ...row, kind: "share", via: "received", status: "removed", removalMessage: row.message,
      granterUserId: null, granterEmail: null, recipientUserId, recipientEmail: null, subjectName: null, sharerName: null,
      selector: null, access: null, generation: null })),
  ];
}

export function createAccessQuery() {
  const granted = new WeakMap<RosterListing, ReturnType<typeof createAccessIndex>>();
  const received = new WeakMap<NonNullable<ReceivedObservation["inventory"]>, Map<string, ReturnType<typeof createAccessIndex>>>();
  function indexFor(observation: AccessRosterObservation | ReceivedObservation, recipientUserId: string) {
    if ("listing" in observation) {
      if (!observation.listing || observation.listing.grants === null) return null;
      let index = granted.get(observation.listing);
      if (!index) { index = createAccessIndex(grantedRows(observation.listing)); granted.set(observation.listing, index); }
      return index;
    }
    if (!observation.inventory) return null;
    let accounts = received.get(observation.inventory);
    if (!accounts) { accounts = new Map(); received.set(observation.inventory, accounts); }
    let index = accounts.get(recipientUserId);
    if (!index) { index = createAccessIndex(receivedRows(observation, recipientUserId)); accounts.set(recipientUserId, index); }
    return index;
  }
  return {
    answer(input: { observation: AccessRosterObservation | ReceivedObservation; recipientUserId: string; cursorScope: string;
      ref: AccessObjectRef | null; coverage: "granted" | "received-own-grant" | "received-account"; shareId?: string; shareRoot?: boolean; cursor?: string }): AccessAnswer {
      const index = indexFor(input.observation, input.recipientUserId);
      if (!index) {
        const reason = "listing" in input.observation
          ? input.observation.unknownReason ?? (input.observation.listing ? "unreadable" : "not-listed-yet")
          : "not-listed-yet";
        return unknownAccess(input.ref, reason, input.ref === null ? "unknown" : "visible");
      }
      let rows = input.shareRoot ? index.rows : input.ref?.kind === "path" ? index.forPath(input.ref)
        : input.ref?.kind === "chat" ? index.forChat(input.ref.channelWireId) : index.rows;
      if (input.shareId) {
        const matching = new Set(rows.map(key));
        rows = index.rows.filter(row => row.shareId === input.shareId && (matching.has(key(row)) || row.status === "removed" || row.status === "damaged"));
      }
      const query = digest(JSON.stringify([index.fingerprint, input.cursorScope, input.ref, input.coverage, input.shareId, input.shareRoot]));
      const page = accessPage(rows, key, query, input.cursor);
      if (!page) return unknownAccess(input.ref, "changed");
      return { ref: input.ref, ...page, visibility: "visible", unknownReason: null,
        coverage: { kind: input.coverage, complete: true, observation: "interval" },
        checkedAtMs: input.observation.checkedAtMs, freshness: input.observation.freshness };
    },
  };
}
