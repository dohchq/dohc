import { expect, it, vi } from "vitest";
import { createHistoryLabels, rosterAuthorLabel } from "./shareRoster";
import { listEngineMomentsForIpc } from "../ipc/engineHistoryIpc";

const roster = { grants: [], links: [], formerGrants: [], endedGrants: [] };
const author = { kind: "named" as const, userId: "ben", grantId: "holder", grantGeneration: 1 };
const moment = { id: "m", workspaceId: "ws", versionId: "main", objectId: "o", path: "a.md", recordedAtMs: 1,
  operation: "write" as const, metadata: { origin: "sync" as const }, momentOrder: 1, protected: false, authors: [author] };

it("renders History while the relay request has not answered", async () => {
  let finish!: (value: null) => void;
  const pending = new Promise<null>(resolve => { finish = resolve; });
  const labels = createHistoryLabels({ snapshot: () => ({ roster, owner: true, context: 1, inventory: 1 }), lookupAccounts: () => pending });
  let rendered = false;
  const reading = listEngineMomentsForIpc(async () => ({ moments: [moment], nextBeforeMomentOrder: null, latestMomentOrder: 1, activeVersionId: "main", protectedTruncated: false }),
    { prepare: () => labels.prepare("ws", [author]), named: person => labels.author("ws", person), agent: () => undefined, person: () => undefined, automation: () => null });
  void reading.then(() => { rendered = true; });
  await new Promise<void>(resolve => setImmediate(resolve));
  try { expect(rendered).toBe(true); } finally { finish(null); await reading; }
});

it("backs off after an unavailable relay instead of retrying on every open", async () => {
  const lookupAccounts = vi.fn(async () => null);
  const labels = createHistoryLabels({ snapshot: () => ({ roster, owner: true, context: 1, inventory: 1 }), lookupAccounts });
  await labels.prepare("ws", [author]);
  await new Promise<void>(resolve => setImmediate(resolve));
  await labels.prepare("ws", [author]);
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(lookupAccounts).toHaveBeenCalledTimes(1);
});

it("keeps a named invite on a link share as an account email", () => {
  const grant = { granterUserId: "owner", granterEmail: "owner@test.example", subjectName: null, sharerName: null, shareId: "same-share", generation: 1,
    status: "active" as const, grantId: "invite", recipientUserId: "ben", recipientEmail: "ben@test.example", access: "edit" as const, selector: { paths: ["a.md"], versionId: null } };
  const listing = { grants: [grant], links: [{ grant: { ...grant, grantId: "link", recipientUserId: null, recipientEmail: null }, ended: false, automationsGeneration: null }], formerGrants: [], endedGrants: [] };
  expect(rosterAuthorLabel(listing, { userId: "ben", grantId: "invite" })).toBe("ben@test.example (Edit)");
});

it("retries only after the failure backoff expires", async () => {
  let time = 0;
  const lookupAccounts = vi.fn(async () => null);
  const labels = createHistoryLabels({ snapshot: () => ({ roster, owner: true, context: 1, inventory: 1 }), lookupAccounts, nowMs: () => time });
  labels.prepare("ws", [author]);
  await new Promise<void>(resolve => setImmediate(resolve));
  time = 59_999;
  labels.prepare("ws", [author]);
  expect(lookupAccounts).toHaveBeenCalledTimes(1);
  time = 60_000;
  labels.prepare("ws", [author]);
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(lookupAccounts).toHaveBeenCalledTimes(2);
});

it("does not publish a late answer after the workspace cache is invalidated", async () => {
  let finish!: (value: Array<{ grantId: string; recipientUserId: string; recipientEmail: string; parentGrantId: string }>) => void;
  const pending = new Promise<Array<{ grantId: string; recipientUserId: string; recipientEmail: string; parentGrantId: string }>>(resolve => { finish = resolve; });
  const ready = vi.fn();
  const labels = createHistoryLabels({ snapshot: () => ({ roster, owner: true, context: 1, inventory: 1 }), lookupAccounts: () => pending, ready });
  labels.prepare("ws", [author]);
  await new Promise<void>(resolve => setImmediate(resolve));
  labels.invalidate("ws");
  finish([{ grantId: "holder", recipientUserId: "ben", recipientEmail: "ben@test.example", parentGrantId: "link" }]);
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(ready).not.toHaveBeenCalled();
  expect(labels.author("other-workspace", author)).toBe("Someone you shared with");
});
