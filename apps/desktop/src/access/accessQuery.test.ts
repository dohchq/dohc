import { expect, it } from "vitest";
import { AccessShareRow } from "@dohc/workspace-contracts/access";
import { readStoredRoster } from "@dohc/automation-executor/roster-listing";
import { createAccessIndex, createAccessQuery } from "./accessQuery";
import { parseReceivedInventory } from "../workspaces/receivedShareStore";

const grant = (id: string, patch: object = {}) => ({ shareId: id, grantId: id, granterUserId: "owner", granterEmail: "owner@test.dev",
  recipientUserId: "friend", recipientEmail: "friend@test.dev", subjectName: "Notes", sharerName: null,
  generation: 1, status: "active" as const, selector: { paths: ["Notes"], versionId: null }, access: "view" as const, ...patch });
const row = (id: string, patch: object = {}) => AccessShareRow.parse({ ...grant(id, patch), kind: "share", via: "named" });
const listing = (grants = [grant("g")]) => readStoredRoster({ grants, links: [], formerGrants: [], endedGrants: [] })!;
const ref = { kind: "path" as const, path: "Notes/a.md", versionId: null };
const input = (source = listing()) => ({ observation: { listing: source, checkedAtMs: 100, freshness: "fresh" as const },
  recipientUserId: "owner", cursorScope: "account-attachment-1", ref, coverage: "granted" as const });

it("matches exact paths and slash-delimited ancestors once despite overlapping roots", () => {
  const index = createAccessIndex([row("a", { selector: { paths: ["Notes", "Notes/a.md"], versionId: null } }), row("b", { selector: { paths: ["Note"], versionId: null } })]);
  expect(index.forPath(ref).map(row => row.grantId)).toEqual(["a"]);
  expect(index.forPath({ ...ref, path: "Notes-old/a.md" })).toEqual([]);
  expect(index.forPath({ ...ref, path: "Notes" }).map(row => row.grantId)).toEqual(["a"]);
});
it("matches exact versions, including a whole tracked version and null selecting main", () => {
  const index = createAccessIndex([row("main"), row("other", { selector: { paths: ["Notes"], versionId: "draft" } }),
    row("whole", { selector: { paths: [], versionId: "draft" } })]);
  expect(index.forPath(ref).map(row => row.grantId)).toEqual(["main"]);
  expect(index.forPath({ ...ref, versionId: "draft" }).map(row => row.grantId)).toEqual(["other", "whole"]);
  expect(index.forPath({ ...ref, versionId: "main" }).map(row => row.grantId)).toEqual(["main"]);
});
it.each(["Notes/.env", "Notes/.dohc/state", "Notes/node_modules/x", "Notes/../.env", ".git/config"])("excludes secret or untracked path %s", path => {
  expect(createAccessIndex([row("whole", { selector: { paths: [], versionId: "main" } })]).forPath({ ...ref, path })).toEqual([]);
});
it("keeps Group chat coverage while withholding file coverage for a non-ordinary Group", () => {
  const index = createAccessIndex([row("group", { selector: { kind: "group", channelWireId: "group", paths: ["Notes"], versionId: null }, access: "read-only", fileScope: "not-served" })]);
  expect(index.forPath(ref)).toEqual([]);
  expect(index.forChat("group")).toHaveLength(1);
  expect(index.rows[0]?.selector).toMatchObject({ kind: "group" });
});
it("retains every link level and its own dependents, separately from Collection capabilities", () => {
  for (const access of ["view", "comment", "edit"] as const) {
    const source = readStoredRoster({ grants: [grant("share", { grantId: "dependent", access })],
      links: [{ grant: grant("share", { grantId: "link", recipientUserId: null, recipientEmail: null, access }), ended: false, automationsGeneration: null }], formerGrants: [], endedGrants: [] })!;
    expect(createAccessQuery().answer(input(source)).rows.map(row => row.kind === "share" ? row.via : row.kind)).toEqual(["dependent", "link"]);
  }
});
it("pages more than 1,000 grants in immutable order and rejects damaged or foreign cursors", () => {
  const query = createAccessQuery(), source = listing(Array.from({ length: 1001 }, (_, n) => grant(String(n).padStart(4, "0"))));
  const base = input(source); let cursor: string | undefined; const ids: string[] = [];
  do { const page = query.answer({ ...base, cursor }); ids.push(...page.rows.map(row => row.kind === "share" ? row.shareId : "")); cursor = page.nextCursor ?? undefined; } while (cursor);
  expect(ids).toEqual(Array.from({ length: 1001 }, (_, n) => String(n).padStart(4, "0")));
  const first = query.answer(base);
  for (const changed of [{ cursorScope: "new-account" }, { ref: { ...ref, path: "Notes/b.md" } }, { observation: { ...base.observation, listing: listing() } }]) {
    expect(query.answer({ ...base, ...changed, cursor: first.nextCursor! })).toMatchObject({ freshness: "unknown", unknownReason: "changed", coverage: { complete: false }, rows: [] });
  }
  expect(query.answer({ ...base, cursor: "broken" })).toMatchObject({ freshness: "unknown", unknownReason: "changed" });
});
it("labels historical coverage and never turns missing observations into an absence claim", () => {
  const query = createAccessQuery();
  expect(query.answer({ ...input(), observation: { listing: null, checkedAtMs: null, freshness: "unknown" } }))
    .toMatchObject({ rows: [], freshness: "unknown", unknownReason: "not-listed-yet", coverage: { complete: false } });
  expect(query.answer({ ...input(), observation: { listing: listing(), checkedAtMs: 100, freshness: "stale" } }))
    .toMatchObject({ rows: [{ shareId: "g" }], checkedAtMs: 100, freshness: "stale", coverage: { complete: true, observation: "interval" } });
  expect(query.answer({ ...input(), ref: { ...ref, path: "Other/file" } }))
    .toMatchObject({ rows: [], coverage: { kind: "granted", complete: true }, freshness: "fresh" });
});
it("retains received Group validity and excludes secrets from the recipient's own answer", () => {
  const inventory = parseReceivedInventory({ received: [{ ...grant("received"), createdAtMs: 1, genericChatWritable: false,
    selector: { kind: "group", channelWireId: "group", paths: ["Notes"], versionId: null }, access: "read-only", fileScope: "not-served",
    bearerUrl: "secret", credentials: "secret", shareCode: "secret", browserInvitationUrl: "secret" }], removed: [] })!;
  expect(inventory.received[0]).toHaveProperty("fileScope", "not-served");
  const query = createAccessQuery(), base = { ...input(), observation: { inventory, checkedAtMs: 100, freshness: "fresh" as const },
    recipientUserId: "recipient", coverage: "received-own-grant" as const, shareId: "received" };
  expect(query.answer(base).rows).toEqual([]);
  const answer = query.answer({ ...base, ref: { kind: "chat", channelWireId: "group" } });
  expect(answer.rows[0]).toMatchObject({ recipientUserId: "recipient", via: "received" });
  expect(JSON.stringify(answer)).not.toMatch(/secret|bearer|credential|Invitation|shareCode/);
});
it("treats received Groups with missing file-scope facts as damaged copies", () => {
  expect(parseReceivedInventory({ received: [{ ...grant("g"), createdAtMs: 1, genericChatWritable: false,
    selector: { kind: "group", channelWireId: "group", paths: ["Notes"], versionId: null }, access: "read-only" }], removed: [] })).toBeNull();
});
it("shows the recipient's removal observation for an ended object's exact share", () => {
  const inventory = parseReceivedInventory({ received: [], removed: [{ shareId: "received", grantId: "own", removedAtMs: 2, message: "removed" }] })!;
  const answer = createAccessQuery().answer({ ...input(), observation: { inventory, checkedAtMs: 100, freshness: "fresh" },
    recipientUserId: "recipient", coverage: "received-own-grant", shareId: "received" });
  expect(answer.rows).toMatchObject([{ shareId: "received", grantId: "own", status: "removed", recipientUserId: "recipient", removalMessage: "removed" }]);
});
it("pages the account's full received inventory but confines an object's answer to its own share", () => {
  const inventory = parseReceivedInventory({ received: Array.from({ length: 1001 }, (_, n) => ({ ...grant(String(n).padStart(4, "0")),
    createdAtMs: 1, genericChatWritable: false })), removed: [] })!;
  const query = createAccessQuery(), base = { ...input(), observation: { inventory, checkedAtMs: 100, freshness: "fresh" as const },
    recipientUserId: "recipient", ref: null, coverage: "received-account" as const };
  let cursor: string | undefined; const ids: string[] = [];
  do { const page = query.answer({ ...base, cursor }); ids.push(...page.rows.map(row => row.kind === "share" ? row.shareId : "")); cursor = page.nextCursor ?? undefined; } while (cursor);
  expect(ids).toHaveLength(1001); expect(new Set(ids).size).toBe(1001);
  expect(query.answer({ ...base, ref, coverage: "received-own-grant", shareId: "0002" }).rows).toMatchObject([{ shareId: "0002" }]);
  const first = query.answer(base);
  expect(query.answer({ ...base, recipientUserId: "other-account", cursor: first.nextCursor! }).freshness).toBe("unknown");
});
it("excludes revoked named grants, former automation writers and ended links from object matching", () => {
  const revoked = grant("former", { status: "revoked", access: "edit" });
  const plain = grant("plain", { status: "revoked" });
  const { selector: _selector, access: _access, ...ended } = plain;
  const source = readStoredRoster({ grants: [grant("active")], formerGrants: [{ grant: revoked, automationsGeneration: 1 }], endedGrants: [ended],
    links: [{ grant: grant("ended-link", { recipientUserId: null, recipientEmail: null }), ended: true, automationsGeneration: 1 }] })!;
  const query = createAccessQuery();
  expect(query.answer(input(source)).rows).toMatchObject([{ shareId: "active" }]);
  const sharing = query.answer({ ...input(source), ref: null });
  expect(sharing.rows.map(row => row.kind === "share" ? [row.shareId, row.status] : [])).toEqual([
    ["active", "active"], ["ended-link", "revoked"], ["former", "revoked"], ["plain", "revoked"]]);
  const index = createAccessIndex([row("active", { selector: { kind: "chat", channelWireId: "channel" }, access: "read-only" }),
    row("revoked", { status: "revoked", selector: { kind: "chat", channelWireId: "channel" }, access: "read-only" })]);
  expect(index.forChat("channel").map(row => row.shareId)).toEqual(["active"]);
});

it("reports unreadable when a stored roster cannot establish grants", () => {
  const source = { ...listing(), grants: null, problem: { kind: "unusable-listing" as const } };
  expect(createAccessQuery().answer(input(source))).toMatchObject({ unknownReason: "unreadable", rows: [] });
});
it.each(["signed-out", "not-synced", "other-account", "other-server", "unreadable"] as const)("carries the owner's null-listing reason %s", unknownReason => {
  expect(createAccessQuery().answer({ ...input(), observation: { listing: null, checkedAtMs: null, freshness: "unknown", unknownReason } }))
    .toMatchObject({ unknownReason, rows: [] });
});
it("reports no received listing yet without claiming absence", () => {
  expect(createAccessQuery().answer({ ...input(), coverage: "received-account", observation: { inventory: null, checkedAtMs: null, freshness: "unknown" } }))
    .toMatchObject({ unknownReason: "not-listed-yet", rows: [] });
});
