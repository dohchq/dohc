import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AUTOMATION_PRESS_RETENTION_MS,
  type RelayAutomationPress,
} from "@dohc/workspace-contracts/relay";

import { BUTTON_INSPECTION_HOST_LIVE_MS } from "./automationButtonInspections";
import { SHARED_BUTTON_DENIED } from "@dohc/automation-executor/button-presser";
import type { SyncRelayHandler } from "./server";
import type { SyncRelayStorage } from "./storage";

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

async function relay(
  options: {
    paths?: string[];
    access?: "view" | "comment" | "edit";
    overrides?: HandlerOverrides;
  } = {},
): Promise<Relay> {
  clock = 10_000;
  const storage = await testStorage();
  let ids = 0;
  const h = testHandler(storage, {
    nowMs: () => clock,
    newId: () => `relay-id-${++ids}`,
    ...options.overrides,
  });
  await claimWorkspace(h, OWNER, WORKSPACE);
  const shareId = await createShare(h, OWNER, WORKSPACE, {
    recipientUserId: RECIPIENT,
    paths: options.paths ?? ["trip"],
    access: options.access ?? "edit",
  });
  const grantId = storage.listActiveShareGrantsForRecipient(shareId, RECIPIENT)[0]!.grantId;
  return { h, storage, shareId, grantId };
}

async function press(
  r: Relay,
  body: Record<string, unknown> = {},
  as = RECIPIENT,
): Promise<Response> {
  return r.h(
    request(
      as,
      `/sync/shares/${r.shareId}/automation-presses`,
      jsonBody({
        pressId: "press-1",
        automationId: AUTOMATION,
        collectionPath: "trip/packing",
        definitionHash: HASH,
        recordId: "rec-12",
        confirmed: [],
        ...body,
      }),
    ),
  );
}

async function host(r: Relay, installId = "laptop"): Promise<void> {
  const response = await r.h(
    request(
      OWNER,
      `/sync/${WORKSPACE}/automation-host/check-in`,
      jsonBody({ installId, label: installId, claim: true }),
    ),
  );
  expect(response.status).toBe(200);
}

async function list(
  r: Relay,
  installId = "laptop",
  as = OWNER,
  waitMs?: number,
): Promise<RelayAutomationPress[]> {
  const query = new URLSearchParams({
    installId,
    ...(waitMs === undefined ? {} : { waitMs: String(waitMs) }),
  });
  const response = await r.h(request(as, `/sync/${WORKSPACE}/automation-presses?${query}`));
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { presses: RelayAutomationPress[] }).presses;
}

async function post(
  r: Relay,
  action: "accept" | "settle",
  body: Record<string, unknown>,
  as = OWNER,
): Promise<Response> {
  const generation = action === "accept" ? { generation: 1 } : {};
  return r.h(
    request(
      as,
      `/sync/${WORKSPACE}/automation-presses/${action}`,
      jsonBody({ installId: "laptop", ...generation, ...body }),
    ),
  );
}

// Rows written straight into the relay's database, for the bounds.

async function expectCode(response: Response, status: number, code: string): Promise<void> {
  expect(response.status, await response.clone().text()).toBe(status);
  expect(((await response.json()) as { code: string }).code).toBe(code);
}

describe("relayed Button presses", () => {
  it("answers unchecked immediately for a sleeping host and a stale parked poll", async () => {
    const r = await relay();
    await host(r);
    const inspect = () =>
      r.h(
        request(
          RECIPIENT,
          `/sync/shares/${r.shareId}/automation-presses?inspect=true`,
          jsonBody({
            targets: [
              { automationId: "mark-packed", collectionPath: "trip/packing", definitionHash: HASH },
            ],
          }),
        ),
      );
    expect(await (await inspect()).json()).toMatchObject({ inspections: [{ kind: "unchecked" }] });
    const scope = { workspaceId: WORKSPACE, ownerUserId: OWNER, installId: "laptop" };
    const release = r.storage.parkButtonInspectionHost(scope);
    const at = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(at + BUTTON_INSPECTION_HOST_LIVE_MS + 1);
    try {
      expect(await (await inspect()).json()).toMatchObject({
        inspections: [{ kind: "unchecked" }],
      });
    } finally {
      clock.mockRestore();
      release();
    }
    expect(r.storage.listButtonInspections(scope)).toEqual([]);
  });
  it.each(["private host diagnostic"])(
    "forwards only a public inspection reason: %s",
    async (reason) => {
      const r = await relay();
      await host(r);
      const scope = { workspaceId: WORKSPACE, ownerUserId: OWNER, installId: "laptop" };
      const release = r.storage.parkButtonInspectionHost(scope);
      try {
        const inspection = r.h(
          request(
            RECIPIENT,
            `/sync/shares/${r.shareId}/automation-presses?inspect=true`,
            jsonBody({
              targets: [
                {
                  automationId: "mark-packed",
                  collectionPath: "trip/packing",
                  definitionHash: HASH,
                },
              ],
            }),
          ),
        );
        await vi.waitFor(() => expect(r.storage.listButtonInspections(scope)).toHaveLength(1));
        const inspectionId = r.storage.listButtonInspections(scope)[0]!.inspectionId;
        expect(
          (
            await r.h(
              request(
                OWNER,
                `/sync/${WORKSPACE}/automation-presses/inspection-answer`,
                jsonBody({
                  installId: "laptop",
                  generation: 1,
                  inspectionId,
                  inspection: { kind: "denied", reason },
                }),
              ),
            )
          ).status,
        ).toBe(200);
        expect(await (await inspection).json()).toMatchObject({
          inspections: [
            {
              kind: "denied",
              reason: reason === "private host diagnostic" ? SHARED_BUTTON_DENIED : reason,
            },
          ],
        });
      } finally {
        release();
      }
    },
  );

  it("resolves only accepted stored identity at the current host fence and rechecks source access", async () => {
    const r = await relay();
    await host(r);
    await press(r, { confirmed: ["dataset/send"] });
    const scope = {
      workspaceId: WORKSPACE,
      ownerUserId: OWNER,
      installId: "laptop",
      generation: 1,
      hostPressId: "relay-id-1",
      nowMs: clock,
    };
    expect(() => r.storage.resolveAutomationPress(scope)).toThrow();
    await post(r, "accept", { hostPressIds: [scope.hostPressId] });
    expect(r.storage.resolveAutomationPress(scope)).toMatchObject({
      workspaceId: WORKSPACE,
      userId: RECIPIENT,
      grantId: r.grantId,
      confirmed: ["dataset/send"],
      hostGeneration: 1,
      recordId: "rec-12",
      principals: [{ userId: RECIPIENT, grantId: r.grantId, access: "edit" }],
    });
    expect(() => r.storage.resolveAutomationPress({ ...scope, ownerUserId: RECIPIENT })).toThrow();
    expect(() => r.storage.resolveAutomationPress({ ...scope, workspaceId: "forged" })).toThrow();
    expect(() => r.storage.resolveAutomationPress({ ...scope, generation: 2 })).toThrow();
    const response = await r.h(
      request(
        OWNER,
        `/sync/${WORKSPACE}/automation-presses/authority`,
        jsonBody({ ...scope, userId: OWNER }),
      ),
    );
    expect(response.status).toBe(400);
    await expectCode(
      await r.h(
        request(RECIPIENT, `/sync/${WORKSPACE}/automation-presses/authority`, jsonBody(scope)),
      ),
      404,
      "not_found",
    );
    await claimWorkspace(r.h, OWNER, "workspace-b");
    await r.h(
      request(
        OWNER,
        "/sync/workspace-b/automation-host/check-in",
        jsonBody({ installId: "laptop", label: "Host", claim: true }),
      ),
    );
    await expectCode(
      await r.h(
        request(
          OWNER,
          "/sync/workspace-b/automation-presses/authority",
          jsonBody({
            installId: "laptop",
            generation: 1,
            hostPressId: scope.hostPressId,
          }),
        ),
      ),
      404,
      "not_found",
    );
    await expectCode(await press(r, { confirmed: ["other/send"] }), 409, "conflict");
    r.storage.revokeShare(r.shareId, ++clock);
    expect(() => r.storage.resolveAutomationPress(scope)).toThrow();
  });

  it("forwards authorized inspections, keeps unknown separate, and rechecks access before the answer", async () => {
    const r = await relay();
    await host(r);
    const release = r.storage.parkButtonInspectionHost({
      workspaceId: WORKSPACE,
      ownerUserId: OWNER,
      installId: "laptop",
    });
    const inspection = r.h(
      request(
        RECIPIENT,
        `/sync/shares/${r.shareId}/automation-presses?inspect=true`,
        jsonBody({
          targets: [
            {
              automationId: "mark-packed",
              collectionPath: "trip/packing",
              definitionHash: HASH,
            },
          ],
        }),
      ),
    );
    await vi.waitFor(() =>
      expect(
        r.storage.listButtonInspections({
          workspaceId: WORKSPACE,
          ownerUserId: OWNER,
          installId: "laptop",
        }),
      ).toHaveLength(1),
    );
    const [query] = r.storage.listButtonInspections({
      workspaceId: WORKSPACE,
      ownerUserId: OWNER,
      installId: "laptop",
    });
    const scope = {
      workspaceId: WORKSPACE,
      ownerUserId: OWNER,
      installId: "laptop",
      generation: 1,
      inspectionId: query!.inspectionId,
    };
    expect(r.storage.resolveButtonInspection(scope).userId).toBe(RECIPIENT);
    expect(() => r.storage.resolveButtonInspection({ ...scope, workspaceId: "forged" })).toThrow();
    await claimWorkspace(r.h, OWNER, "workspace-b");
    await expectCode(
      await r.h(
        request(
          OWNER,
          "/sync/workspace-b/automation-presses/inspection-authority",
          jsonBody({
            installId: "laptop",
            generation: 1,
            inspectionId: scope.inspectionId,
          }),
        ),
      ),
      404,
      "not_found",
    );
    r.storage.answerButtonInspection(scope, { kind: "unchecked", reason: "Host unavailable" });
    expect(await (await inspection).json()).toMatchObject({ inspections: [{ kind: "unchecked" }] });
    expect(() => r.storage.resolveButtonInspection(scope)).toThrow();
    const next = r.h(
      request(
        RECIPIENT,
        `/sync/shares/${r.shareId}/automation-presses?inspect=true`,
        jsonBody({
          targets: [
            {
              automationId: "mark-packed",
              collectionPath: "trip/packing",
              definitionHash: HASH,
            },
          ],
        }),
      ),
    );
    await vi.waitFor(() =>
      expect(
        r.storage.listButtonInspections({
          workspaceId: WORKSPACE,
          ownerUserId: OWNER,
          installId: "laptop",
        }),
      ).toHaveLength(1),
    );
    const [pending] = r.storage.listButtonInspections({
      workspaceId: WORKSPACE,
      ownerUserId: OWNER,
      installId: "laptop",
    });
    r.storage.revokeShare(r.shareId, ++clock);
    expect(() =>
      r.storage.answerButtonInspection(
        { ...scope, inspectionId: pending!.inspectionId },
        {
          kind: "ready",
          automationId: AUTOMATION,
          definitionHash: HASH,
          irreversible: [{ name: "dataset/send", label: "Send" }],
        },
      ),
    ).toThrow();
    const reply = await next;
    expect(await reply.json()).toMatchObject({ inspections: [{ kind: "denied" }] });
    release();
  });
  it("records a recipient's press and offers it to the running host as the verified user's", async () => {
    const r = await relay();
    await host(r);
    const response = await press(r, { pressedBy: "someone-else" });
    // A field the relay does not know is not read, and never names who pressed.
    expect(response.status).toBe(400);
    const accepted = await press(r);
    expect(accepted.status, await accepted.clone().text()).toBe(200);
    expect(await accepted.json()).toEqual({
      ok: true,
      pressId: "press-1",
      state: "pending",
      outcome: null,
      createdAtMs: 10_000,
    });
    const presses = await list(r);
    expect(presses).toEqual([
      {
        hostPressId: "relay-id-1",
        definitionHash: HASH,
        state: "pending",
        automationId: AUTOMATION,
        collectionPath: "trip/packing",
        recordId: "rec-12",
        pressedBy: RECIPIENT,
        createdAtMs: 10_000,
        confirmed: [],
      },
    ]);

    expect(await (await post(r, "accept", { hostPressIds: ["relay-id-1"] })).json()).toEqual({
      ok: true,
      accepted: ["relay-id-1"],
    });
    expect(await list(r)).toMatchObject([{ hostPressId: "relay-id-1", state: "accepted" }]);
    const settled = await post(r, "settle", {
      hostPressId: "relay-id-1",
      outcome: "done",
      error: null,
    });
    expect(await settled.json()).toMatchObject({ ok: true, state: "settled", outcome: "done" });
    expect(await list(r)).toEqual([]);

    // The same press sent again answers the same press; another target is refused.
    expect(await (await press(r)).json()).toMatchObject({
      pressId: "press-1",
      state: "settled",
      outcome: "done",
    });
    await expectCode(await press(r, { recordId: "rec-13" }), 409, "conflict");
  });

  it.each([["a View grant", { access: "view" as const }, 403, "share_read_only"]])(
    "refuses a press through %s",
    async (_name, options, status, code) => {
      const r = await relay(options);
      await host(r);
      await expectCode(await press(r), status, code);
      expect(await list(r)).toEqual([]);
    },
  );

  it("refuses someone without a grant, and a grant opened from a public link", async () => {
    const r = await relay();
    await expectCode(await press(r, {}, "stranger"), 404, "not_found");
    seedLinkGrant(r.storage, {
      grantId: "link-1",
      shareId: r.shareId,
      secretHash: sha256("secret"),
      access: "edit",
    });
    seedDependentGrant(r.storage, {
      shareId: r.shareId,
      parentGrantId: "link-1",
      grantId: "from-link",
      principalUserId: "linked",
      createdAtMs: clock,
    });
    await expectCode(await press(r, {}, "linked"), 403, "share_read_only");
    await expectCode(
      await r.h(
        request(
          "linked",
          `/sync/shares/${r.shareId}/automation-presses`,
          jsonBody({
            inspect: true,
            automationId: AUTOMATION,
            collectionPath: "trip/packing",
            definitionHash: HASH,
          }),
        ),
      ),
      403,
      "share_read_only",
    );
  });

  it("settles a waiting press as failed when its grant ends, so the host never runs it", async () => {
    const r = await relay();
    await host(r);
    await press(r);
    expect(
      r.storage.revokeShareGrant({ shareId: r.shareId, grantId: r.grantId, revokedAtMs: clock }).ok,
    ).toBe(true);
    expect(await list(r)).toEqual([]);
    const db = inspectDatabase(storagePath(r.storage), { readOnly: true });
    const row = {
      ...db.prepare("SELECT state, outcome, error FROM sync_relay_automation_presses").get(),
    };
    db.close();
    expect(row).toEqual({
      state: "settled",
      outcome: "failed",
      error: "Your access to this Collection changed before the button ran.",
    });
  });

  it.each(["trip/../private"])(
    "refuses an invalid or non-normalized Collection path: %s",
    async (collectionPath) => {
      const r = await relay();
      await host(r);
      await expectCode(await press(r, { collectionPath }), 403, "share_op_rejected");
      expect(await list(r)).toEqual([]);
    },
  );

  it("keeps the host's routes to the owner", async () => {
    const r = await relay();
    await host(r);
    await press(r);
    const response = await r.h(
      request(RECIPIENT, `/sync/${WORKSPACE}/automation-presses?installId=laptop`),
    );
    expect(response.status).toBe(404);
    await expectCode(
      await post(r, "accept", { hostPressIds: ["relay-id-1"] }, RECIPIENT),
      404,
      "not_found",
    );
    await expectCode(
      await post(
        r,
        "settle",
        { hostPressId: "relay-id-1", outcome: "done", error: null },
        RECIPIENT,
      ),
      404,
      "not_found",
    );
  });

  it("settles only an accepted press, once", async () => {
    const r = await relay();
    await host(r);
    await press(r);
    await expectCode(
      await post(r, "settle", { hostPressId: "relay-id-1", outcome: "done", error: null }),
      409,
      "conflict",
    );
    await post(r, "accept", { hostPressIds: ["relay-id-1"] });
    expect(
      (
        await post(r, "settle", {
          hostPressId: "relay-id-1",
          outcome: "failed",
          error: "Total is not a number.",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await post(r, "settle", {
          hostPressId: "relay-id-1",
          outcome: "failed",
          error: "Total is not a number.",
        })
      ).status,
    ).toBe(200);
    await expectCode(
      await post(r, "settle", { hostPressId: "relay-id-1", outcome: "done", error: null }),
      409,
      "conflict",
    );
  });

  it("treats a press past retention as gone everywhere: the wait, the list, and accept", async () => {
    const r = await relay();
    await host(r);
    await press(r);
    const [listed] = await list(r);
    clock += AUTOMATION_PRESS_RETENTION_MS + 1;
    expect(await (await post(r, "accept", { hostPressIds: [listed!.hostPressId] })).json()).toEqual(
      { ok: true, accepted: [] },
    );
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

  it("ends a press another computer accepted once a new host runs the workspace", async () => {
    const r = await relay();
    await host(r, "laptop");
    await press(r);
    await post(r, "accept", { hostPressIds: ["relay-id-1"] });
    await r.h(
      request(
        OWNER,
        `/sync/${WORKSPACE}/automation-host/check-in`,
        jsonBody({ installId: "desktop", label: "desktop", claim: false }),
      ),
    );
    expect(
      (
        await r.h(
          request(
            OWNER,
            `/sync/${WORKSPACE}/automation-host/choose`,
            jsonBody({ installId: "desktop", generation: 1 }),
          ),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await r.h(
          request(
            OWNER,
            `/sync/${WORKSPACE}/automation-host/take-over`,
            jsonBody({ generation: 2 }),
          ),
        )
      ).status,
    ).toBe(200);
    expect(await list(r, "desktop")).toEqual([]);
    expect(await (await press(r)).json()).toMatchObject({ state: "settled", outcome: "ended" });
    // The old computer's late answer is refused rather than taken.
    await expectCode(
      await post(r, "settle", {
        installId: "laptop",
        hostPressId: "relay-id-1",
        outcome: "done",
        error: null,
      }),
      409,
      "conflict",
    );
  });

  it("does not read a relay failure as lost access", async () => {
    const r = await relay();
    await host(r);
    await press(r);
    const spy = vi.spyOn(r.storage, "getShareGrant").mockImplementation(() => {
      throw new Error("disk I/O error");
    });
    const response = await r.h(
      request(OWNER, `/sync/${WORKSPACE}/automation-presses?installId=laptop`),
    );
    expect(response.status).toBe(500);
    spy.mockRestore();
    expect(await list(r)).toMatchObject([{ hostPressId: "relay-id-1", state: "pending" }]);
  });

  it("accepts nothing at a host generation a handover replaced", async () => {
    const r = await relay();
    await host(r, "laptop");
    await press(r);
    await r.h(
      request(
        OWNER,
        `/sync/${WORKSPACE}/automation-host/check-in`,
        jsonBody({ installId: "desktop", label: "desktop", claim: false }),
      ),
    );
    await r.h(
      request(
        OWNER,
        `/sync/${WORKSPACE}/automation-host/choose`,
        jsonBody({ installId: "desktop", generation: 1 }),
      ),
    );
    // The owner chose the laptop back, so it runs again, at a new generation.
    await r.h(
      request(
        OWNER,
        `/sync/${WORKSPACE}/automation-host/choose`,
        jsonBody({ installId: "laptop", generation: 2 }),
      ),
    );
    await expectCode(
      await post(r, "accept", { hostPressIds: ["relay-id-1"], generation: 1 }),
      409,
      "conflict",
    );
    expect(
      await (await post(r, "accept", { hostPressIds: ["relay-id-1"], generation: 3 })).json(),
    ).toEqual({ ok: true, accepted: ["relay-id-1"] });
  });

  it("checks the grant again when a restarted host asks for a press it accepted", async () => {
    const r = await relay();
    await host(r);
    await press(r);
    await post(r, "accept", { hostPressIds: ["relay-id-1"] });
    expect(await (await post(r, "accept", { hostPressIds: ["relay-id-1"] })).json()).toEqual({
      ok: true,
      accepted: ["relay-id-1"],
    });
    expect(
      r.storage.revokeShareGrant({ shareId: r.shareId, grantId: r.grantId, revokedAtMs: clock }).ok,
    ).toBe(true);
    expect(await (await post(r, "accept", { hostPressIds: ["relay-id-1"] })).json()).toEqual({
      ok: true,
      accepted: [],
    });
    expect(await list(r)).toEqual([]);
  });
});
