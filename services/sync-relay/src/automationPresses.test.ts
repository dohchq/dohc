import { afterEach, describe, expect, it, vi } from "vitest";
import { TokenBucketLimiter } from "@dohc/service-http";
import {
  AUTOMATION_PRESS_MAX_BODY_BYTES,
  AUTOMATION_PRESS_RETENTION_MS,
  type RelayAutomationPress,
} from "@dohc/workspace-contracts/relay";
import { createAutomationPressRateLimiters, isAutomationPressPath, pruneAutomationPresses } from "./automationPressRoutes";
import type { SyncRelayHandler } from "./server";
import type { SyncRelayStorage } from "./storage";
import {
  AUTOMATION_PRESS_LIST_LIMIT,
  AUTOMATION_PRESS_PRUNE_BATCH,
  AUTOMATION_PRESSES_PER_GRANT,
  AUTOMATION_PRESSES_UNSETTLED_PER_GRANT,
} from "./storage/automationPresses";
import {
  claimWorkspace,
  closeTestStorages,
  createShare,
  inspectDatabase,
  jsonBody,
  request,
  seedDependentGrant,
  seedLinkGrant,
  sha256,
  storagePath,
  testHandler,
  testStorage,
  type HandlerOverrides,
} from "./testing";

// A shared view's Button press, through the real routes: the recipient's
// named Edit grant records it, and only the workspace's running host is
// offered it, as the relay-verified user's press.

afterEach(closeTestStorages);

const OWNER = "owner";
const RECIPIENT = "recipient";
const WORKSPACE = "workspace-a";
const AUTOMATION = "collection:object-packing#mark-packed";
const HASH = "0123456789abcdef";
let clock = 10_000;

interface Relay {
  h: SyncRelayHandler;
  storage: SyncRelayStorage;
  shareId: string;
  grantId: string;
}

async function relay(options: { paths?: string[]; access?: "view" | "comment" | "edit"; overrides?: HandlerOverrides } = {}): Promise<Relay> {
  clock = 10_000;
  const storage = await testStorage();
  let ids = 0;
  const h = testHandler(storage, { nowMs: () => clock, newId: () => `relay-id-${++ids}`, ...options.overrides });
  await claimWorkspace(h, OWNER, WORKSPACE);
  const shareId = await createShare(h, OWNER, WORKSPACE, {
    recipientUserId: RECIPIENT, paths: options.paths ?? ["trip"], access: options.access ?? "edit",
  });
  const grantId = storage.listActiveShareGrantsForRecipient(shareId, RECIPIENT)[0]!.grantId;
  return { h, storage, shareId, grantId };
}

async function press(r: Relay, body: Record<string, unknown> = {}, as = RECIPIENT): Promise<Response> {
  return r.h(request(as, `/sync/shares/${r.shareId}/automation-presses`, jsonBody({
    pressId: "press-1", automationId: AUTOMATION, collectionPath: "trip/packing", definitionHash: HASH, recordId: "rec-12", ...body,
  })));
}

async function host(r: Relay, installId = "laptop"): Promise<void> {
  const response = await r.h(request(OWNER, `/sync/${WORKSPACE}/automation-host/check-in`, jsonBody({ installId, label: installId, claim: true })));
  expect(response.status).toBe(200);
}

async function list(r: Relay, installId = "laptop", as = OWNER, waitMs?: number): Promise<RelayAutomationPress[]> {
  const query = new URLSearchParams({ installId, ...(waitMs === undefined ? {} : { waitMs: String(waitMs) }) });
  const response = await r.h(request(as, `/sync/${WORKSPACE}/automation-presses?${query}`));
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { presses: RelayAutomationPress[] }).presses;
}

async function post(r: Relay, action: "accept" | "settle", body: Record<string, unknown>, as = OWNER): Promise<Response> {
  const generation = action === "accept" ? { generation: 1 } : {};
  return r.h(request(as, `/sync/${WORKSPACE}/automation-presses/${action}`, jsonBody({ installId: "laptop", ...generation, ...body })));
}

// Rows written straight into the relay's database, for the bounds.
function seed(r: Relay, rows: number, options: { state: "settled" | "accepted"; createdAtMs: number; grantId?: string }): void {
  const db = inspectDatabase(storagePath(r.storage));
  db.exec("BEGIN");
  const insert = db.prepare(
    `INSERT INTO sync_relay_automation_presses (host_press_id, workspace_id, share_id, grant_id, grant_generation, press_id, user_id,
       automation_id, collection_path, definition_hash, record_id, state, accepted_by, outcome, error, created_at_ms, updated_at_ms)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?, 'trip/packing', '${HASH}', 'rec-12', ?, ?, ?, NULL, ?, ?)`,
  );
  for (let index = 0; index < rows; index += 1) {
    insert.run(`seeded-${options.state}-${index}`, WORKSPACE, r.shareId, options.grantId ?? r.grantId, `seeded-${options.state}-${index}`, RECIPIENT, AUTOMATION,
      options.state, options.state === "accepted" ? "laptop" : null, options.state === "settled" ? "done" : null, options.createdAtMs, options.createdAtMs);
  }
  db.exec("COMMIT");
  db.close();
}

async function expectCode(response: Response, status: number, code: string): Promise<void> {
  expect(response.status, await response.clone().text()).toBe(status);
  expect(((await response.json()) as { code: string }).code).toBe(code);
}

describe("relayed Button presses", () => {
  it("records a recipient's press and offers it to the running host as the verified user's", async () => {
    const r = await relay();
    await host(r);
    const response = await press(r, { pressedBy: "someone-else" });
    // A field the relay does not know is not read, and never names who pressed.
    expect(response.status).toBe(400);
    const accepted = await press(r);
    expect(accepted.status, await accepted.clone().text()).toBe(200);
    expect(await accepted.json()).toEqual({ ok: true, pressId: "press-1", state: "pending", outcome: null, createdAtMs: 10_000 });
    const presses = await list(r);
    expect(presses).toEqual([{ hostPressId: "relay-id-1", definitionHash: HASH, state: "pending", automationId: AUTOMATION, collectionPath: "trip/packing", recordId: "rec-12", pressedBy: RECIPIENT, createdAtMs: 10_000 }]);

    // The host's engine takes it. The list still names it until it settles,
    // so a host that restarts before pressing it finds it again.
    expect(await (await post(r, "accept", { hostPressIds: ["relay-id-1"] })).json()).toEqual({ ok: true, accepted: ["relay-id-1"] });
    expect(await list(r)).toMatchObject([{ hostPressId: "relay-id-1", state: "accepted" }]);
    const settled = await post(r, "settle", { hostPressId: "relay-id-1", outcome: "done", error: null });
    expect(await settled.json()).toMatchObject({ ok: true, state: "settled", outcome: "done" });
    expect(await list(r)).toEqual([]);

    // The same press sent again answers the same press; another target is refused.
    expect(await (await press(r)).json()).toMatchObject({ pressId: "press-1", state: "settled", outcome: "done" });
    await expectCode(await press(r, { recordId: "rec-13" }), 409, "conflict");
  });

  it("offers presses only to the running host, and to no one during a handover", async () => {
    const r = await relay();
    await press(r);
    // No host yet: the press waits.
    expect(await list(r)).toEqual([]);
    await host(r, "laptop");
    expect(await list(r, "desktop")).toEqual([]);
    await expectCode(await post(r, "accept", { installId: "desktop", hostPressIds: ["relay-id-1"] }), 409, "conflict");
    expect(await list(r, "laptop")).toHaveLength(1);
    await r.h(request(OWNER, `/sync/${WORKSPACE}/automation-host/check-in`, jsonBody({ installId: "desktop", label: "desktop", claim: false })));
    const chosen = await r.h(request(OWNER, `/sync/${WORKSPACE}/automation-host/choose`, jsonBody({ installId: "desktop", generation: 1 })));
    expect(chosen.status).toBe(200);
    expect(await list(r, "laptop")).toEqual([]);
    expect(await list(r, "desktop")).toEqual([]);
  });

  it.each([
    ["a View grant", { access: "view" as const }, 403, "share_read_only"],
    ["a Comment grant", { access: "comment" as const }, 403, "share_read_only"],
    ["Edit on one record's file only", { paths: ["trip/packing/12.md"] }, 403, "share_read_only"],
    ["Edit on a folder beside the Collection", { paths: ["notes"] }, 403, "share_read_only"],
  ])("refuses a press through %s", async (_name, options, status, code) => {
    const r = await relay(options);
    await host(r);
    await expectCode(await press(r), status, code);
    expect(await list(r)).toEqual([]);
  });

  it("accepts Edit on the Collection folder itself", async () => {
    const r = await relay({ paths: ["trip/packing"] });
    expect((await press(r)).status).toBe(200);
  });

  it("refuses someone without a grant, and a grant opened from a public link", async () => {
    const r = await relay();
    await expectCode(await press(r, {}, "stranger"), 404, "not_found");
    seedLinkGrant(r.storage, { grantId: "link-1", shareId: r.shareId, secretHash: sha256("secret"), access: "edit" });
    seedDependentGrant(r.storage, { shareId: r.shareId, parentGrantId: "link-1", grantId: "from-link", principalUserId: "linked", createdAtMs: clock });
    await expectCode(await press(r, {}, "linked"), 403, "share_read_only");
  });

  it("refuses an automation id that names no Collection", async () => {
    const r = await relay();
    for (const automationId of ["plugin:x/y", "collection:#id", "collection:object-packing#", "collection:object-packing", "collection:trip/packing#mark-packed"]) {
      await expectCode(await press(r, { automationId }), 403, "share_op_rejected");
    }
  });

  it.each([
    "trip/../private",
    "trip/%2e%2e/private",
    "trip/.dohc/engine",
    "/trip/packing",
    "trip//packing",
    "trip/./packing",
    "trip/packing/",
    "trip/packing\\nested",
    "trip/packing%2fnested",
  ])("refuses an invalid or non-normalized Collection path: %s", async (collectionPath) => {
    const r = await relay();
    await host(r);
    await expectCode(await press(r, { collectionPath }), 403, "share_op_rejected");
    expect(await list(r)).toEqual([]);
  });

  it("settles a waiting press as failed when its grant ends, so the host never runs it", async () => {
    const r = await relay();
    await host(r);
    await press(r);
    expect(r.storage.revokeShareGrant({ shareId: r.shareId, grantId: r.grantId, revokedAtMs: clock }).ok).toBe(true);
    expect(await list(r)).toEqual([]);
    const db = inspectDatabase(storagePath(r.storage), { readOnly: true });
    const row = { ...db.prepare("SELECT state, outcome, error FROM sync_relay_automation_presses").get() };
    db.close();
    expect(row).toEqual({ state: "settled", outcome: "failed", error: "Your access to this Collection changed before the button ran." });
  });

  it("checks the grant again at accept, not only when it listed", async () => {
    const r = await relay();
    await host(r);
    await press(r);
    expect(await list(r)).toHaveLength(1);
    expect(r.storage.revokeShareGrant({ shareId: r.shareId, grantId: r.grantId, revokedAtMs: clock }).ok).toBe(true);
    expect(await (await post(r, "accept", { hostPressIds: ["relay-id-1"] })).json()).toEqual({ ok: true, accepted: [] });
  });

  it("keeps the host's routes to the owner", async () => {
    const r = await relay();
    await host(r);
    await press(r);
    const response = await r.h(request(RECIPIENT, `/sync/${WORKSPACE}/automation-presses?installId=laptop`));
    expect(response.status).toBe(404);
    await expectCode(await post(r, "accept", { hostPressIds: ["relay-id-1"] }, RECIPIENT), 404, "not_found");
    await expectCode(await post(r, "settle", { hostPressId: "relay-id-1", outcome: "done", error: null }, RECIPIENT), 404, "not_found");
  });

  it("settles only an accepted press, once", async () => {
    const r = await relay();
    await host(r);
    await press(r);
    await expectCode(await post(r, "settle", { hostPressId: "relay-id-1", outcome: "done", error: null }), 409, "conflict");
    await post(r, "accept", { hostPressIds: ["relay-id-1"] });
    expect((await post(r, "settle", { hostPressId: "relay-id-1", outcome: "failed", error: "Total is not a number." })).status).toBe(200);
    expect((await post(r, "settle", { hostPressId: "relay-id-1", outcome: "failed", error: "Total is not a number." })).status).toBe(200);
    await expectCode(await post(r, "settle", { hostPressId: "relay-id-1", outcome: "done", error: null }), 409, "conflict");
  });

  it("limits presses per grant, and how many wait unsettled", async () => {
    const r = await relay({ overrides: { automationPressRateLimiters: { ...createAutomationPressRateLimiters(), press: new TokenBucketLimiter(2, 0.0001, 10) } } });
    expect((await press(r, { pressId: "a" })).status).toBe(200);
    expect((await press(r, { pressId: "b" })).status).toBe(200);
    await expectCode(await press(r, { pressId: "c" }), 429, "automation_press_rate_limited");

    const s = await relay();
    for (let index = 0; index < AUTOMATION_PRESSES_UNSETTLED_PER_GRANT; index += 1) {
      s.storage.recordAutomationPress({
        shareId: s.shareId, grantId: s.grantId, grantGeneration: 1, userId: RECIPIENT, pressId: `p-${index}`,
        automationId: AUTOMATION, collectionPath: "trip/packing", definitionHash: HASH, recordId: "rec-12", nowMs: clock, newId: () => `seed-${index}`,
      });
    }
    await expectCode(await press(s, { pressId: "one-more" }), 429, "automation_press_rate_limited");
  });

  it("drops a press the host never ran once it is past retention", async () => {
    const r = await relay();
    await press(r, { pressId: "old" });
    clock += AUTOMATION_PRESS_RETENTION_MS + 1;
    await press(r, { pressId: "new" });
    const db = inspectDatabase(storagePath(r.storage), { readOnly: true });
    const ids = db.prepare("SELECT press_id FROM sync_relay_automation_presses ORDER BY press_id").all().map((row) => row.press_id);
    db.close();
    expect(ids).toEqual(["new"]);
  });

  it("holds an empty list until a press arrives", async () => {
    const r = await relay();
    await host(r);
    let answered = false;
    const waiting = list(r, "laptop", OWNER, 20_000).then((presses) => {
      answered = true;
      return presses;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(answered).toBe(false);
    await press(r);
    expect(await waiting).toHaveLength(1);
  });

  it("gives every spelling of these paths the small body limit", () => {
    expect(AUTOMATION_PRESS_MAX_BODY_BYTES).toBeLessThan(16 * 1024);
    for (const path of ["/sync/shares/s1/automation-presses", "/sync/w1/automation-presses", "/sync/w1/automation-presses/accept", "/sync/w1/%61utomation-presses/settle"]) {
      expect(isAutomationPressPath(path), path).toBe(true);
    }
    for (const path of ["/sync/shares/s1/collection-writes", "/sync/notices/automation-presses", "/sync/w1/automation-host"]) {
      expect(isAutomationPressPath(path), path).toBe(false);
    }
  });

  it("keeps every press for the whole retention window, so an old press id never runs twice", async () => {
    const roomy = () => new TokenBucketLimiter(10_000, 1, 10);
    const r = await relay({ overrides: { automationPressRateLimiters: { press: roomy(), host: roomy() } } });
    await host(r);
    for (let index = 0; index < 250; index += 1) {
      await press(r, { pressId: `p-${index}` });
      const [listed] = await list(r);
      await post(r, "accept", { hostPressIds: [listed!.hostPressId] });
      await post(r, "settle", { hostPressId: listed!.hostPressId, outcome: "done", error: null });
    }
    expect(await (await press(r, { pressId: "p-0" })).json()).toMatchObject({ pressId: "p-0", state: "settled", outcome: "done" });
    expect(await list(r)).toEqual([]);
  });

  it("refuses new presses past a grant's bound instead of forgetting old ones", async () => {
    const r = await relay();
    seed(r, AUTOMATION_PRESSES_PER_GRANT, { state: "settled", createdAtMs: clock });
    await expectCode(await press(r, { pressId: "one-more" }), 429, "automation_press_rate_limited");
    expect(await (await press(r, { pressId: "seeded-settled-0" })).json()).toMatchObject({ pressId: "seeded-settled-0", state: "settled" });
  });

  it("treats a press past retention as gone everywhere: the wait, the list, and accept", async () => {
    const r = await relay();
    await host(r);
    await press(r);
    const [listed] = await list(r);
    clock += AUTOMATION_PRESS_RETENTION_MS + 1;
    expect(await (await post(r, "accept", { hostPressIds: [listed!.hostPressId] })).json()).toEqual({ ok: true, accepted: [] });
    // The expired press does not wake a held list: it waits until a new press arrives.
    let answered = false;
    const waiting = list(r, "laptop", OWNER, 20_000).then((presses) => {
      answered = true;
      return presses;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(answered).toBe(false);
    await press(r, { pressId: "fresh" });
    expect((await waiting).map((entry) => entry.createdAtMs)).toEqual([clock]);
  });

  it("prunes presses past retention on a timer, with no new press or list", async () => {
    const r = await relay();
    await press(r);
    expect(r.storage.pruneExpiredAutomationPresses(clock)).toBe(0);
    expect(r.storage.pruneExpiredAutomationPresses(clock + AUTOMATION_PRESS_RETENTION_MS + 1)).toBe(1);
  });

  it("ends a press another computer accepted once a new host runs the workspace", async () => {
    const r = await relay();
    await host(r, "laptop");
    await press(r);
    await post(r, "accept", { hostPressIds: ["relay-id-1"] });
    await r.h(request(OWNER, `/sync/${WORKSPACE}/automation-host/check-in`, jsonBody({ installId: "desktop", label: "desktop", claim: false })));
    expect((await r.h(request(OWNER, `/sync/${WORKSPACE}/automation-host/choose`, jsonBody({ installId: "desktop", generation: 1 })))).status).toBe(200);
    expect((await r.h(request(OWNER, `/sync/${WORKSPACE}/automation-host/take-over`, jsonBody({ generation: 2 })))).status).toBe(200);
    expect(await list(r, "desktop")).toEqual([]);
    expect(await (await press(r)).json()).toMatchObject({ state: "settled", outcome: "ended" });
    // The old computer's late answer is refused rather than taken.
    await expectCode(await post(r, "settle", { installId: "laptop", hostPressId: "relay-id-1", outcome: "done", error: null }), 409, "conflict");
  });

  it("does not read a relay failure as lost access", async () => {
    const r = await relay();
    await host(r);
    await press(r);
    const spy = vi.spyOn(r.storage, "getShareGrant").mockImplementation(() => {
      throw new Error("disk I/O error");
    });
    const response = await r.h(request(OWNER, `/sync/${WORKSPACE}/automation-presses?installId=laptop`));
    expect(response.status).toBe(500);
    spy.mockRestore();
    expect(await list(r)).toMatchObject([{ hostPressId: "relay-id-1", state: "pending" }]);
  });

  it("answers a computer that is not the host at once, without holding its list", async () => {
    const r = await relay();
    await host(r, "laptop");
    await press(r);
    expect(await list(r, "desktop", OWNER, 20_000)).toEqual([]);
  });

  it("prunes an expired backlog bigger than one batch, all of it", async () => {
    const r = await relay();
    seed(r, AUTOMATION_PRESS_PRUNE_BATCH * 2 + 5, { state: "settled", createdAtMs: 1 });
    let pauses = 0;
    expect(await pruneAutomationPresses(r.storage, clock + AUTOMATION_PRESS_RETENTION_MS, async () => { pauses += 1; }))
      .toBe(AUTOMATION_PRESS_PRUNE_BATCH * 2 + 5);
    expect(pauses).toBe(2);
    expect(r.storage.pruneExpiredAutomationPresses(clock + AUTOMATION_PRESS_RETENTION_MS)).toBe(0);
  });

  it("still offers a new press when older accepted presses fill a list", async () => {
    const r = await relay();
    await host(r);
    // Another grant's presses, so this grant may still press.
    seed(r, AUTOMATION_PRESS_LIST_LIMIT, { state: "accepted", createdAtMs: clock - 1, grantId: "another-grant" });
    await press(r, { pressId: "newest" });
    const listed = await list(r);
    expect(listed.filter((entry) => entry.state === "accepted")).toHaveLength(AUTOMATION_PRESS_LIST_LIMIT);
    expect(listed.filter((entry) => entry.state === "pending").map((entry) => entry.hostPressId)).toHaveLength(1);
  });

  it("carries the automation as the recipient saw it, and refuses the same press id for another version", async () => {
    const r = await relay();
    await host(r);
    await press(r);
    expect((await list(r))[0]?.definitionHash).toBe(HASH);
    await expectCode(await press(r, { definitionHash: "fedcba9876543210" }), 409, "conflict");
    for (const definitionHash of [undefined, "short", "0123456789ABCDEF"]) {
      const response = await press(r, { pressId: "p-bad", definitionHash });
      expect(response.status).toBe(400);
    }
  });

  it("accepts nothing at a host generation a handover replaced", async () => {
    const r = await relay();
    await host(r, "laptop");
    await press(r);
    await r.h(request(OWNER, `/sync/${WORKSPACE}/automation-host/check-in`, jsonBody({ installId: "desktop", label: "desktop", claim: false })));
    await r.h(request(OWNER, `/sync/${WORKSPACE}/automation-host/choose`, jsonBody({ installId: "desktop", generation: 1 })));
    // The owner chose the laptop back, so it runs again, at a new generation.
    await r.h(request(OWNER, `/sync/${WORKSPACE}/automation-host/choose`, jsonBody({ installId: "laptop", generation: 2 })));
    await expectCode(await post(r, "accept", { hostPressIds: ["relay-id-1"], generation: 1 }), 409, "conflict");
    expect(await (await post(r, "accept", { hostPressIds: ["relay-id-1"], generation: 3 })).json()).toEqual({ ok: true, accepted: ["relay-id-1"] });
  });

  it("checks the grant again when a restarted host asks for a press it accepted", async () => {
    const r = await relay();
    await host(r);
    await press(r);
    await post(r, "accept", { hostPressIds: ["relay-id-1"] });
    expect(await (await post(r, "accept", { hostPressIds: ["relay-id-1"] })).json()).toEqual({ ok: true, accepted: ["relay-id-1"] });
    expect(r.storage.revokeShareGrant({ shareId: r.shareId, grantId: r.grantId, revokedAtMs: clock }).ok).toBe(true);
    expect(await (await post(r, "accept", { hostPressIds: ["relay-id-1"] })).json()).toEqual({ ok: true, accepted: [] });
    expect(await list(r)).toEqual([]);
  });
});
