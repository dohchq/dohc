import { createHash } from "node:crypto";
import { UnauthorizedError, type ResolveAccountSession } from "@dohc/workspace-auth/session";
import {
  parseAutomationsFile,
  type AutomationHttpStep,
} from "@dohc/workspace-contracts/automations";
import {
  computeHttpStepApprovalDigest,
  workspaceSecretApprovalBindings,
} from "@dohc/workspace-contracts/http-step-approvals";
import { definitionDigest } from "@dohc/automation-executor/automation-plan";
import type { SafeOutboundDestination, SafeOutboundRequest } from "@dohc/service-http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fenceAccount,
  initializeAccountDeletion,
  purgeAccountRows,
} from "./storage/accountDeletion";
import {
  closeTestStorages,
  countRows,
  createShare,
  jsonBody,
  LINK_KEY,
  putBlob,
  request,
  sha256,
  storagePath,
  testHandler,
  testStorage,
  type HandlerOverrides,
} from "./testing";
import type { SyncRelayHandler } from "./server";
import type { SyncRelayStorage } from "./storage";
import type { StorageContext } from "./storage/context";

afterEach(async () => {
  await closeTestStorages();
});

const OWNER = "owner";
const WORKSPACE = "ws-hook-1";
const COLLECTION = "Tasks";
const COLLECTION_SCHEMA = "name: Tasks\nfields:\n  Title:\n    type: text\n";

const resolveDesktopOrOtherSession: ResolveAccountSession = async (req) => {
  const match = /^Bearer (user|browser|phone):([^ ]+)$/u.exec(
    req.headers.get("authorization") ?? "",
  );
  if (!match) throw new UnauthorizedError();
  const kind = match[1] === "browser" ? "browser" : match[1] === "phone" ? "phone" : "desktop";
  return {
    userId: match[2]!,
    sessionId: `${kind}:${match[2]!}`,
    expiresAtMs: Number.MAX_SAFE_INTEGER,
    clientKind: kind,
  };
};

function fakeDestination(rawUrl: string): SafeOutboundDestination {
  const url = new URL(rawUrl);
  return {
    href: url.href,
    url,
    canonicalHost: url.hostname.toLowerCase(),
    address: "93.184.216.34",
    family: 4,
  };
}

const commitStateByHandler = new WeakMap<
  SyncRelayHandler,
  { seq: number; blobs: Map<string, string> }
>();

async function commitFiles(
  handler: SyncRelayHandler,
  files: ReadonlyArray<{ objectId: string; path: string; text: string }>,
): Promise<void> {
  let state = commitStateByHandler.get(handler);
  if (!state) {
    state = { seq: 0, blobs: new Map() };
    commitStateByHandler.set(handler, state);
  }
  for (const file of files) {
    const blobSha256 = await putBlob(handler, OWNER, WORKSPACE, file.text);
    const previousBlobSha256 = state.blobs.get(file.path) ?? null;
    const originSeq = state.seq++;
    const response = await handler(
      request(
        OWNER,
        `/sync/${WORKSPACE}/log`,
        jsonBody({
          originId: "origin-owner",
          ops: [
            {
              originSeq,
              opKind: "moment.append",
              recordedAtMs: 1_000 + originSeq,
              payload: {
                momentId: `m-${originSeq}`,
                versionId: "main",
                objectId: file.objectId,
                path: file.path,
                recordedAtMs: 1_000 + originSeq,
                operation: "write",
                payloadAfterBlobSha256: blobSha256,
                payloadAfterPath: file.path,
                payloadAfterContentKind: "text",
                payloadAfterByteLength: Buffer.byteLength(file.text, "utf8"),
                metadata: { origin: "user" },
                payloadBeforeBlobSha256: previousBlobSha256,
                payloadBeforePath: previousBlobSha256 ? file.path : null,
                beforePresent: previousBlobSha256 ? "present" : "null",
              },
            },
          ],
        }),
      ),
    );
    expect(response.status, await response.clone().text()).toBe(200);
    state.blobs.set(file.path, blobSha256);
  }
}

const SAMPLE_YAML = `version: 1
automations:
  - id: notify-hook
    name: Notify webhook
    when: record-added
    do:
      - run-file: helper.js
        as: computed
      - http: https://api.resend.com/emails
        headers:
          X-Fixed: literal-value
          X-Dynamic: '=computed'
        secret-headers:
          Authorization:
            secret: RESEND_API_KEY
            prefix: 'Bearer '
        body:
          title: '=record.Title'
`;

const HELPER_JS = 'export default () => "computed-v1";';

function secretBindingsIn(storage: Pick<SyncRelayStorage, "listWorkspaceSecrets">) {
  return workspaceSecretApprovalBindings(storage.listWorkspaceSecrets(WORKSPACE));
}

function approvalFor(
  yamlText: string,
  helperText: string,
  stepOrdinal = 1,
  collectionId = "obj-schema",
  storage?: Pick<SyncRelayStorage, "listWorkspaceSecrets">,
): string {
  const parsed = parseAutomationsFile(yamlText);
  if (parsed.status !== "read" || parsed.entries[0]?.status !== "valid") {
    throw new Error("Invalid test YAML");
  }
  const automation = parsed.entries[0].automation;
  const httpStep = automation.do[stepOrdinal] as AutomationHttpStep;
  return computeHttpStepApprovalDigest({
    collectionId,
    collectionPath: COLLECTION,
    automationId: automation.id,
    stepOrdinal,
    step: httpStep,
    definitionDigest: definitionDigest(automation),
    codeFileHashes: [{ file: "helper.js", sha256: sha256(helperText) }],
    secretBindings: storage ? secretBindingsIn(storage) : new Map(),
  })!;
}

async function approveStep(
  handler: SyncRelayHandler,
  approvalDigest: string,
  automationId: string,
  stepOrdinal: number,
): Promise<void> {
  const response = await handler(
    request(
      OWNER,
      `/sync/${WORKSPACE}/webhooks/http-approvals`,
      jsonBody({
        approvalDigest,
        collectionId: "obj-schema",
        collectionPath: COLLECTION,
        automationId,
        stepOrdinal,
      }),
    ),
  );
  expect(response.status, await response.clone().text()).toBe(200);
}

async function setup(overrides: HandlerOverrides = {}) {
  const storage = (await testStorage()) as StorageContext;
  storage.claimWorkspace({ workspaceId: WORKSPACE, ownerUserId: OWNER, createdAtMs: 1 });
  const sent: SafeOutboundRequest[] = [];
  const handler = testHandler(storage, {
    resolvePhoneCapableAccountSession: resolveDesktopOrOtherSession,
    resolveOutboundDestination: async (rawUrl) => fakeDestination(rawUrl),
    sendOutboundRequest: async (req) => {
      sent.push(req);
      return 200;
    },
    ...overrides,
  });
  return { storage, handler, sent };
}

describe("outbound webhook relay routes (Model E1)", () => {
  it("enforces desktop-only Bearer auth, refuses unapproved or unsynced definitions, verifies committed files + secrets + host pinning, and deduplicates by deliveryId", async () => {
    const { storage, handler, sent } = await setup();

    const browserReq = new Request(`http://relay.test/sync/${WORKSPACE}/webhooks/http-approvals`, {
      headers: { authorization: `Bearer browser:${OWNER}` },
    });
    expect((await handler(browserReq)).status).toBe(404);

    const phoneReq = new Request(`http://relay.test/sync/${WORKSPACE}/webhooks/http-approvals`, {
      headers: { authorization: `Bearer phone:${OWNER}` },
    });
    expect((await handler(phoneReq)).status).toBe(404);

    const otherOwner = await handler(
      request("other", `/sync/${WORKSPACE}/webhooks/http-approvals`),
    );
    expect(otherOwner.status).toBe(404);

    const cookieReq = new Request(`http://relay.test/sync/${WORKSPACE}/webhooks/http-approvals`, {
      headers: { cookie: "better-auth.session_token=abc" },
    });
    expect((await handler(cookieReq)).status).toBe(404);

    const digest = approvalFor(SAMPLE_YAML, HELPER_JS);
    const deliveryId = createHash("sha256").update("delivery-1").digest("hex");
    const dispatchPayload = {
      collectionId: "obj-schema",
      collectionPath: COLLECTION,
      automationId: "notify-hook",
      stepOrdinal: 1,
      approvalDigest: digest,
      deliveryId,
      chainDepth: 0,
      evaluatedSafeHeaders: [
        { name: "X-Fixed", value: "spoofed-by-caller" },
        { name: "X-Dynamic", value: "computed-v1" },
      ],
      evaluatedBody: JSON.stringify({ title: "Hello" }),
      defaultContentType: "application/json" as const,
    };

    const unsynced = await handler(
      request(OWNER, `/sync/${WORKSPACE}/webhooks/outbound-dispatch`, jsonBody(dispatchPayload)),
    );
    expect(unsynced.status).toBe(409);
    expect(await unsynced.json()).toMatchObject({
      ok: false,
      error: "definition_not_synced",
      beforeSend: true,
    });

    await commitFiles(handler, [
      { objectId: "obj-schema", path: `${COLLECTION}/collection.yaml`, text: COLLECTION_SCHEMA },
      { objectId: "obj-auto", path: `${COLLECTION}/automations.yaml`, text: SAMPLE_YAML },
      { objectId: "obj-helper", path: `${COLLECTION}/helper.js`, text: HELPER_JS },
    ]);

    const unapproved = await handler(
      request(OWNER, `/sync/${WORKSPACE}/webhooks/outbound-dispatch`, jsonBody(dispatchPayload)),
    );
    expect(unapproved.status).toBe(403);
    expect(await unapproved.json()).toMatchObject({
      ok: false,
      error: "approval_required",
      beforeSend: true,
    });
    expect(sent).toHaveLength(0);

    const approveRes = await handler(
      request(
        OWNER,
        `/sync/${WORKSPACE}/webhooks/http-approvals`,
        jsonBody({
          approvalDigest: digest,
          collectionId: "obj-schema",
          collectionPath: COLLECTION,
          automationId: "notify-hook",
          stepOrdinal: 1,
        }),
      ),
    );
    expect(approveRes.status).toBe(200);
    expect(
      await (await handler(request(OWNER, `/sync/${WORKSPACE}/webhooks/http-approvals`))).json(),
    ).toEqual({
      ok: true,
      approvals: [digest],
      secrets: [],
    });

    // Mismatched approvalDigest (caller evaluated a different revision than committed) must be refused before sending.
    const mismatchedDigestRes = await handler(
      request(
        OWNER,
        `/sync/${WORKSPACE}/webhooks/outbound-dispatch`,
        jsonBody({
          ...dispatchPayload,
          approvalDigest: "0".repeat(64),
          deliveryId: createHash("sha256").update("delivery-mismatch").digest("hex"),
        }),
      ),
    );
    expect(mismatchedDigestRes.status).toBe(409);
    expect(await mismatchedDigestRes.json()).toMatchObject({
      ok: false,
      error: "definition_not_synced",
      beforeSend: true,
    });
    expect(sent).toHaveLength(0);

    // Put a secret pinned to a DIFFERENT host first -> must fail with secret_host_denied and beforeSend: true.
    const wrongHostSecret = await handler(
      request(OWNER, `/sync/${WORKSPACE}/secrets/RESEND_API_KEY`, {
        ...jsonBody({
          mode: "create",
          usage: "http-header",
          value: "re_live_top_secret_token",
          allowedHosts: ["other.example.com"],
        }),
        method: "PUT",
      }),
    );
    expect(wrongHostSecret.status).toBe(200);

    const approvedBeforeSecret = await handler(
      request(
        OWNER,
        `/sync/${WORKSPACE}/webhooks/outbound-dispatch`,
        jsonBody({
          ...dispatchPayload,
          deliveryId: createHash("sha256").update("delivery-before-secret").digest("hex"),
        }),
      ),
    );
    expect(approvedBeforeSecret.status).toBe(409);
    expect(await approvedBeforeSecret.json()).toMatchObject({
      ok: false,
      error: "definition_not_synced",
      reason: expect.stringContaining("A secret this step uses changed"),
    });
    dispatchPayload.approvalDigest = approvalFor(SAMPLE_YAML, HELPER_JS, 1, "obj-schema", storage);
    await approveStep(handler, dispatchPayload.approvalDigest, "notify-hook", 1);

    const wrongHostDelivery = createHash("sha256").update("delivery-wrong-host").digest("hex");
    const hostDenied = await handler(
      request(
        OWNER,
        `/sync/${WORKSPACE}/webhooks/outbound-dispatch`,
        jsonBody({ ...dispatchPayload, deliveryId: wrongHostDelivery }),
      ),
    );
    expect(hostDenied.status).toBe(200);
    const hostDeniedJson = (await hostDenied.json()) as {
      ok: boolean;
      error: string;
      reason: string;
      beforeSend?: boolean;
    };
    expect(hostDeniedJson).toMatchObject({
      ok: false,
      error: "secret_host_denied",
      beforeSend: true,
    });
    expect(hostDeniedJson.reason).not.toContain("re_live_top_secret_token");
    expect(sent).toHaveLength(0);

    // Replace secret with api.resend.com pinned.
    const fixedSecret = await handler(
      request(OWNER, `/sync/${WORKSPACE}/secrets/RESEND_API_KEY`, {
        ...jsonBody({
          mode: "replace",
          usage: "http-header",
          value: "re_live_top_secret_token",
          allowedHosts: ["api.resend.com"],
        }),
        method: "PUT",
      }),
    );
    expect(fixedSecret.status).toBe(200);
    dispatchPayload.approvalDigest = approvalFor(SAMPLE_YAML, HELPER_JS, 1, "obj-schema", storage);
    await approveStep(handler, dispatchPayload.approvalDigest, "notify-hook", 1);

    // Retrying the same wrongHostDelivery ID after fixing the secret now succeeds because the prior failure was beforeSend.
    const retriedDelivery = await handler(
      request(
        OWNER,
        `/sync/${WORKSPACE}/webhooks/outbound-dispatch`,
        jsonBody({ ...dispatchPayload, deliveryId: wrongHostDelivery }),
      ),
    );
    expect(retriedDelivery.status).toBe(200);
    expect(await retriedDelivery.json()).toEqual({ ok: true, status: 200 });
    expect(sent).toHaveLength(1);
    sent.length = 0;

    // Spoofed undeclared header must be refused.
    const extraHeader = await handler(
      request(
        OWNER,
        `/sync/${WORKSPACE}/webhooks/outbound-dispatch`,
        jsonBody({
          ...dispatchPayload,
          evaluatedSafeHeaders: [{ name: "X-Evil", value: "nope" }],
        }),
      ),
    );
    expect(extraHeader.status).toBe(400);
    expect(await extraHeader.json()).toMatchObject({ ok: false, error: "invalid_headers" });

    // Valid dispatch succeeds, restores literal X-Fixed over caller spoof, injects secret + standard headers.
    const dispatched = await handler(
      request(OWNER, `/sync/${WORKSPACE}/webhooks/outbound-dispatch`, jsonBody(dispatchPayload)),
    );
    expect(dispatched.status).toBe(200);
    expect(await dispatched.json()).toEqual({ ok: true, status: 200 });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.headers["X-Fixed"]).toBe("literal-value");
    expect(sent[0]!.headers["X-Dynamic"]).toBe("computed-v1");
    expect(sent[0]!.headers["Authorization"]).toBe("Bearer re_live_top_secret_token");
    expect(sent[0]!.headers["User-Agent"]).toBe("dohc-automation/1");
    expect(sent[0]!.headers["X-Dohc-Delivery-Id"]).toBe(deliveryId);
    expect(sent[0]!.headers["X-Dohc-Chain-Depth"]).toBe("1");

    // Atomic deduplication by deliveryId: second call never sends again.
    const duplicate = await handler(
      request(OWNER, `/sync/${WORKSPACE}/webhooks/outbound-dispatch`, jsonBody(dispatchPayload)),
    );
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toEqual({ ok: true, status: 200, deduplicated: true });
    expect(sent).toHaveLength(1);

    const rotated = await handler(
      request(OWNER, `/sync/${WORKSPACE}/secrets/RESEND_API_KEY`, {
        ...jsonBody({
          mode: "replace",
          usage: "http-header",
          value: "re_live_rotated_token",
          allowedHosts: ["api.resend.com"],
        }),
        method: "PUT",
      }),
    );
    expect(rotated.status).toBe(200);
    const afterRotation = await handler(
      request(
        OWNER,
        `/sync/${WORKSPACE}/webhooks/outbound-dispatch`,
        jsonBody({
          ...dispatchPayload,
          deliveryId: createHash("sha256").update("delivery-after-rotation").digest("hex"),
        }),
      ),
    );
    expect(await afterRotation.json()).toEqual({ ok: true, status: 200 });
    expect(sent).toHaveLength(2);
    expect(sent[1]!.headers["Authorization"]).toBe("Bearer re_live_rotated_token");

    // A workspace member stops dispatch too, until they are removed.
    const invitedMember = await handler(
      request(
        OWNER,
        `/sync/${WORKSPACE}/members/invites`,
        jsonBody({ email: "member@dohc.test", workspaceName: "Community" }),
      ),
    );
    expect(invitedMember.status, await invitedMember.clone().text()).toBe(200);
    const members = (await invitedMember.json()) as {
      people: Array<{ email: string | null; memberId: string }>;
    };
    const memberId = members.people.find((person) => person.email === "member@dohc.test")?.memberId;
    expect(memberId).toBeDefined();
    const afterMember = await handler(
      request(
        OWNER,
        `/sync/${WORKSPACE}/webhooks/outbound-dispatch`,
        jsonBody({
          ...dispatchPayload,
          deliveryId: createHash("sha256").update("delivery-after-member").digest("hex"),
        }),
      ),
    );
    expect(afterMember.status).toBe(403);
    expect(await afterMember.json()).toMatchObject({ ok: false, error: "reach_stopped" });
    expect(sent).toHaveLength(2);
    expect(
      (await handler(request(OWNER, `/sync/${WORKSPACE}/members/${memberId}/remove`, jsonBody({}))))
        .status,
    ).toBe(200);

    // Sharing Collection with Edit access immediately stops dispatch authoritatively.
    await createShare(handler, OWNER, WORKSPACE, {
      recipientUserId: "collaborator",
      paths: [COLLECTION],
      access: "edit",
    });
    const afterShare = await handler(
      request(
        OWNER,
        `/sync/${WORKSPACE}/webhooks/outbound-dispatch`,
        jsonBody({
          ...dispatchPayload,
          deliveryId: createHash("sha256").update("delivery-after-share").digest("hex"),
        }),
      ),
    );
    expect(afterShare.status).toBe(403);
    expect(await afterShare.json()).toMatchObject({ ok: false, error: "reach_stopped" });
    expect(sent).toHaveLength(2);

    // Account deletion cascade purges approvals and dispatches.
    const dbPath = storagePath(storage);
    expect(countRows(dbPath, "sync_relay_http_approvals")).toBe(1);
    expect(countRows(dbPath, "sync_relay_http_dispatches")).toBe(3);
    initializeAccountDeletion(storage, LINK_KEY);
    const fenced = fenceAccount(storage, LINK_KEY, OWNER, "owner@dohc.test");
    expect(fenced.manifest).not.toBeNull();
    purgeAccountRows(storage, OWNER, "owner@dohc.test", fenced.manifest!);
    expect(countRows(dbPath, "sync_relay_http_approvals")).toBe(0);
    expect(countRows(dbPath, "sync_relay_http_dispatches")).toBe(0);
  });

  it("enforces per-account concurrency cap of 2 and rejects chainDepth >= 4", async () => {
    const releases: Array<() => void> = [];
    const sendSpy = vi.fn(
      () =>
        new Promise<number>((resolve) => {
          releases.push(() => resolve(204));
        }),
    );
    const { handler } = await setup({
      sendOutboundRequest: sendSpy,
    });
    const simpleYaml = `version: 1
automations:
  - id: ping
    name: Ping
    when: record-added
    do:
      - http: https://hooks.example.com/ping
`;
    await commitFiles(handler, [
      { objectId: "obj-schema", path: `${COLLECTION}/collection.yaml`, text: COLLECTION_SCHEMA },
      { objectId: "obj-auto", path: `${COLLECTION}/automations.yaml`, text: simpleYaml },
    ]);
    const parsed = parseAutomationsFile(simpleYaml);
    if (parsed.status !== "read" || parsed.entries[0]?.status !== "valid") throw new Error("bad");
    const automation = parsed.entries[0].automation;
    const digest = computeHttpStepApprovalDigest({
      collectionId: "obj-schema",
      collectionPath: COLLECTION,
      automationId: automation.id,
      stepOrdinal: 0,
      step: automation.do[0] as AutomationHttpStep,
      definitionDigest: definitionDigest(automation),
      codeFileHashes: [],
      secretBindings: null,
    })!;
    await handler(
      request(
        OWNER,
        `/sync/${WORKSPACE}/webhooks/http-approvals`,
        jsonBody({
          approvalDigest: digest,
          collectionId: "obj-schema",
          collectionPath: COLLECTION,
          automationId: "ping",
          stepOrdinal: 0,
        }),
      ),
    );

    const makeReq = (id: string, chainDepth = 0, evaluatedBody: string | null = null) =>
      request(
        OWNER,
        `/sync/${WORKSPACE}/webhooks/outbound-dispatch`,
        jsonBody({
          collectionId: "obj-schema",
          collectionPath: COLLECTION,
          automationId: "ping",
          stepOrdinal: 0,
          approvalDigest: digest,
          deliveryId: createHash("sha256").update(id).digest("hex"),
          chainDepth,
          evaluatedSafeHeaders: [],
          evaluatedBody,
          defaultContentType: null,
        }),
      );

    // Extra body when step declared none must fail 400.
    const unexpectedBody = await handler(makeReq("body-unexpected", 0, '{"evil":true}'));
    expect(unexpectedBody.status).toBe(400);
    expect(await unexpectedBody.json()).toMatchObject({ ok: false, error: "invalid_body" });

    // Chain depth >= 4 refused.
    const deep = await handler(makeReq("deep", 4));
    expect(deep.status).toBe(422);
    expect(await deep.json()).toMatchObject({ ok: false, error: "chain_depth_exceeded" });

    // Start 2 in-flight requests; 3rd must get 429 concurrency_limit.
    const p1 = handler(makeReq("c1"));
    const p2 = handler(makeReq("c2"));
    await vi.waitFor(() => expect(releases).toHaveLength(2));

    const third = await handler(makeReq("c3"));
    expect(third.status).toBe(429);
    expect(await third.json()).toMatchObject({ ok: false, error: "concurrency_limit" });

    releases.forEach((release) => release());
    expect((await p1).status).toBe(200);
    expect((await p2).status).toBe(200);
  });

  it("rechecks account fence and solo reach after DNS, redacts secret URL hostname on host-pin denial, and accepts JSON-expanded 64 KiB bodies", async () => {
    let duringDns: (() => Promise<void>) | null = null;
    const { storage, handler, sent } = await setup({
      resolveOutboundDestination: async (rawUrl) => {
        if (duringDns) {
          const action = duringDns;
          duringDns = null;
          await action();
        }
        return fakeDestination(rawUrl);
      },
    });
    const secretUrlYaml = `version: 1
automations:
  - id: secret-hook
    name: Secret hook
    when: record-added
    do:
      - http:
          secret: PRIVATE_HOOK_URL
        secret-headers:
          Authorization:
            secret: HEADER_KEY
            prefix: 'Bearer '
        body: 'payload'
`;
    await commitFiles(handler, [
      { objectId: "obj-schema", path: `${COLLECTION}/collection.yaml`, text: COLLECTION_SCHEMA },
      { objectId: "obj-auto", path: `${COLLECTION}/automations.yaml`, text: secretUrlYaml },
    ]);
    const parsed = parseAutomationsFile(secretUrlYaml);
    if (parsed.status !== "read" || parsed.entries[0]?.status !== "valid") throw new Error("bad");
    const automation = parsed.entries[0].automation;
    const secretHookDigest = (store: Pick<SyncRelayStorage, "listWorkspaceSecrets">) =>
      computeHttpStepApprovalDigest({
        collectionId: "obj-schema",
        collectionPath: COLLECTION,
        automationId: automation.id,
        stepOrdinal: 0,
        step: automation.do[0] as AutomationHttpStep,
        definitionDigest: definitionDigest(automation),
        codeFileHashes: [],
        secretBindings: secretBindingsIn(store),
      })!;
    await handler(
      request(OWNER, `/sync/${WORKSPACE}/secrets/PRIVATE_HOOK_URL`, {
        ...jsonBody({
          mode: "create",
          usage: "http-url",
          value: "https://secret-internal-host.example.com/hook/tok",
        }),
        method: "PUT",
      }),
    );
    await handler(
      request(OWNER, `/sync/${WORKSPACE}/secrets/HEADER_KEY`, {
        ...jsonBody({
          mode: "create",
          usage: "http-header",
          value: "hdr_secret_val",
          allowedHosts: ["other-allowed.example.com"],
        }),
        method: "PUT",
      }),
    );
    let digest = secretHookDigest(storage);
    await approveStep(handler, digest, "secret-hook", 0);

    // Host-pin denial on a secret URL must NOT reveal secret-internal-host.example.com.
    const pinDenied = await handler(
      request(
        OWNER,
        `/sync/${WORKSPACE}/webhooks/outbound-dispatch`,
        jsonBody({
          collectionId: "obj-schema",
          collectionPath: COLLECTION,
          automationId: "secret-hook",
          stepOrdinal: 0,
          approvalDigest: digest,
          deliveryId: createHash("sha256").update("pin-denied-secret-url").digest("hex"),
          chainDepth: 0,
          evaluatedSafeHeaders: [],
          evaluatedBody: "hello",
          defaultContentType: "text/plain; charset=utf-8",
        }),
      ),
    );
    expect(pinDenied.status).toBe(200);
    const pinDeniedText = await pinDenied.text();
    expect(pinDeniedText).toContain("secret_host_denied");
    expect(pinDeniedText).not.toContain("secret-internal-host.example.com");
    expect(sent).toHaveLength(0);

    // Fix HEADER_KEY allowedHosts and test a 64 KiB body of alternating letters and newlines (~98 KiB JSON envelope).
    await handler(
      request(OWNER, `/sync/${WORKSPACE}/secrets/HEADER_KEY`, {
        ...jsonBody({
          mode: "replace",
          usage: "http-header",
          value: "hdr_secret_val",
          allowedHosts: ["secret-internal-host.example.com"],
        }),
        method: "PUT",
      }),
    );
    digest = secretHookDigest(storage);
    await approveStep(handler, digest, "secret-hook", 0);
    const expanded64kBody = "a\n".repeat(32 * 1024);
    expect(Buffer.byteLength(expanded64kBody, "utf8")).toBe(64 * 1024);
    const largeRes = await handler(
      request(
        OWNER,
        `/sync/${WORKSPACE}/webhooks/outbound-dispatch`,
        jsonBody({
          collectionId: "obj-schema",
          collectionPath: COLLECTION,
          automationId: "secret-hook",
          stepOrdinal: 0,
          approvalDigest: digest,
          deliveryId: createHash("sha256").update("expanded-64k").digest("hex"),
          chainDepth: 0,
          evaluatedSafeHeaders: [],
          evaluatedBody: expanded64kBody,
          defaultContentType: "text/plain; charset=utf-8",
        }),
      ),
    );
    expect(largeRes.status).toBe(200);
    expect(await largeRes.json()).toEqual({ ok: true, status: 200 });
    expect(sent).toHaveLength(1);

    duringDns = async () => {
      const replaced = await handler(
        request(OWNER, `/sync/${WORKSPACE}/secrets/PRIVATE_HOOK_URL`, {
          ...jsonBody({
            mode: "replace",
            usage: "http-url",
            value: "https://secret-internal-host.example.com/hook/new",
          }),
          method: "PUT",
        }),
      );
      expect(replaced.status).toBe(200);
    };
    const replacedDuringDns = await handler(
      request(
        OWNER,
        `/sync/${WORKSPACE}/webhooks/outbound-dispatch`,
        jsonBody({
          collectionId: "obj-schema",
          collectionPath: COLLECTION,
          automationId: "secret-hook",
          stepOrdinal: 0,
          approvalDigest: digest,
          deliveryId: createHash("sha256").update("replaced-during-dns").digest("hex"),
          chainDepth: 0,
          evaluatedSafeHeaders: [],
          evaluatedBody: "hello",
          defaultContentType: "text/plain; charset=utf-8",
        }),
      ),
    );
    expect(replacedDuringDns.status).toBe(409);
    expect(await replacedDuringDns.json()).toMatchObject({
      ok: false,
      error: "secret_changed",
      beforeSend: true,
    });
    expect(sent).toHaveLength(1);
    const staleLink = await handler(
      request(
        OWNER,
        `/sync/${WORKSPACE}/webhooks/outbound-dispatch`,
        jsonBody({
          collectionId: "obj-schema",
          collectionPath: COLLECTION,
          automationId: "secret-hook",
          stepOrdinal: 0,
          approvalDigest: digest,
          deliveryId: createHash("sha256").update("stale-link").digest("hex"),
          chainDepth: 0,
          evaluatedSafeHeaders: [],
          evaluatedBody: "hello",
          defaultContentType: "text/plain; charset=utf-8",
        }),
      ),
    );
    expect(staleLink.status).toBe(409);
    expect(await staleLink.json()).toMatchObject({ error: "definition_not_synced" });
    digest = secretHookDigest(storage);
    await approveStep(handler, digest, "secret-hook", 0);

    // Disabling the automation while DNS is pending must abort atomically at reservation without sending.
    const disabledYaml = secretUrlYaml.replace(
      "when: record-added",
      "enabled: false\n    when: record-added",
    );
    duringDns = async () => {
      await commitFiles(handler, [
        { objectId: "obj-auto", path: `${COLLECTION}/automations.yaml`, text: disabledYaml },
      ]);
    };
    const disabledDuringDns = await handler(
      request(
        OWNER,
        `/sync/${WORKSPACE}/webhooks/outbound-dispatch`,
        jsonBody({
          collectionId: "obj-schema",
          collectionPath: COLLECTION,
          automationId: "secret-hook",
          stepOrdinal: 0,
          approvalDigest: digest,
          deliveryId: createHash("sha256").update("race-disable-during-dns").digest("hex"),
          chainDepth: 0,
          evaluatedSafeHeaders: [],
          evaluatedBody: "hello",
          defaultContentType: "text/plain; charset=utf-8",
        }),
      ),
    );
    expect(disabledDuringDns.status).toBe(409);
    expect(await disabledDuringDns.json()).toMatchObject({
      ok: false,
      error: "definition_not_synced",
      beforeSend: true,
    });
    expect(sent).toHaveLength(1);

    // Re-enable automation, then add an Edit share during DNS -> must abort before sendOutboundRequest runs.
    await commitFiles(handler, [
      { objectId: "obj-auto", path: `${COLLECTION}/automations.yaml`, text: secretUrlYaml },
    ]);
    duringDns = async () => {
      await createShare(handler, OWNER, WORKSPACE, {
        recipientUserId: "late-editor",
        paths: [COLLECTION],
        access: "edit",
      });
    };
    const raceShareRes = await handler(
      request(
        OWNER,
        `/sync/${WORKSPACE}/webhooks/outbound-dispatch`,
        jsonBody({
          collectionId: "obj-schema",
          collectionPath: COLLECTION,
          automationId: "secret-hook",
          stepOrdinal: 0,
          approvalDigest: digest,
          deliveryId: createHash("sha256").update("race-share-during-dns").digest("hex"),
          chainDepth: 0,
          evaluatedSafeHeaders: [],
          evaluatedBody: "hello",
          defaultContentType: "text/plain; charset=utf-8",
        }),
      ),
    );
    expect(raceShareRes.status).toBe(403);
    expect(await raceShareRes.json()).toMatchObject({
      ok: false,
      error: "reach_stopped",
      beforeSend: true,
    });
    expect(sent).toHaveLength(1);

    // Fencing the account during DNS resolution must abort before sendOutboundRequest runs.
    const {
      storage: fenceStorage,
      handler: fenceHandler,
      sent: fenceSent,
    } = await setup({
      resolveOutboundDestination: async (rawUrl) => {
        initializeAccountDeletion(fenceStorage, LINK_KEY);
        fenceAccount(fenceStorage, LINK_KEY, OWNER, "owner@dohc.test");
        return fakeDestination(rawUrl);
      },
    });
    await commitFiles(fenceHandler, [
      { objectId: "obj-schema", path: `${COLLECTION}/collection.yaml`, text: COLLECTION_SCHEMA },
      { objectId: "obj-auto", path: `${COLLECTION}/automations.yaml`, text: secretUrlYaml },
    ]);
    await fenceHandler(
      request(OWNER, `/sync/${WORKSPACE}/secrets/PRIVATE_HOOK_URL`, {
        ...jsonBody({
          mode: "create",
          usage: "http-url",
          value: "https://secret-internal-host.example.com/hook/tok",
        }),
        method: "PUT",
      }),
    );
    await fenceHandler(
      request(OWNER, `/sync/${WORKSPACE}/secrets/HEADER_KEY`, {
        ...jsonBody({
          mode: "create",
          usage: "http-header",
          value: "hdr_secret_val",
          allowedHosts: ["secret-internal-host.example.com"],
        }),
        method: "PUT",
      }),
    );
    digest = secretHookDigest(fenceStorage);
    await approveStep(fenceHandler, digest, "secret-hook", 0);
    const fencedDuringDns = await fenceHandler(
      request(
        OWNER,
        `/sync/${WORKSPACE}/webhooks/outbound-dispatch`,
        jsonBody({
          collectionId: "obj-schema",
          collectionPath: COLLECTION,
          automationId: "secret-hook",
          stepOrdinal: 0,
          approvalDigest: digest,
          deliveryId: createHash("sha256").update("race-fence-during-dns").digest("hex"),
          chainDepth: 0,
          evaluatedSafeHeaders: [],
          evaluatedBody: "hello",
          defaultContentType: "text/plain; charset=utf-8",
        }),
      ),
    );
    expect(fencedDuringDns.status).toBe(404);
    expect(fenceSent).toHaveLength(0);
    expect(storage).toBeDefined();
  });

  it("preserves UTF-8 BOM in run-file hashes, rejects replacement Collections, and returns structured beforeSend on quota exhaustion", async () => {
    const { storage, handler, sent } = await setup();
    const bomHelper = `\uFEFFexport default () => "bom-v1";`;
    await commitFiles(handler, [
      {
        objectId: "obj-schema-bom",
        path: `${COLLECTION}/collection.yaml`,
        text: COLLECTION_SCHEMA,
      },
      { objectId: "obj-auto", path: `${COLLECTION}/automations.yaml`, text: SAMPLE_YAML },
      { objectId: "obj-helper", path: `${COLLECTION}/helper.js`, text: bomHelper },
    ]);
    await handler(
      request(OWNER, `/sync/${WORKSPACE}/secrets/RESEND_API_KEY`, {
        ...jsonBody({
          mode: "create",
          usage: "http-header",
          value: "re_bom_secret",
          allowedHosts: ["api.resend.com"],
        }),
        method: "PUT",
      }),
    );
    const bomDigest = approvalFor(SAMPLE_YAML, bomHelper, 1, "obj-schema-bom", storage);
    await handler(
      request(
        OWNER,
        `/sync/${WORKSPACE}/webhooks/http-approvals`,
        jsonBody({
          approvalDigest: bomDigest,
          collectionId: "obj-schema-bom",
          collectionPath: COLLECTION,
          automationId: "notify-hook",
          stepOrdinal: 1,
        }),
      ),
    );

    const bomRes = await handler(
      request(
        OWNER,
        `/sync/${WORKSPACE}/webhooks/outbound-dispatch`,
        jsonBody({
          collectionId: "obj-schema-bom",
          collectionPath: COLLECTION,
          automationId: "notify-hook",
          stepOrdinal: 1,
          approvalDigest: bomDigest,
          deliveryId: createHash("sha256").update("bom-delivery").digest("hex"),
          chainDepth: 0,
          evaluatedSafeHeaders: [
            { name: "X-Fixed", value: "literal-value" },
            { name: "X-Dynamic", value: "bom-v1" },
          ],
          evaluatedBody: JSON.stringify({ title: "BOM" }),
          defaultContentType: "application/json",
        }),
      ),
    );
    expect(bomRes.status).toBe(200);
    expect(await bomRes.json()).toEqual({ ok: true, status: 200 });
    expect(sent).toHaveLength(1);

    // Exhaust workspace quota before reservation -> must return structured beforeSend: true refusal.
    const originalUsage = Number(
      (
        storage.db
          .prepare("SELECT usage_bytes FROM sync_relay_workspace_usage WHERE workspace_id = ?")
          .get(WORKSPACE) as { usage_bytes: number }
      ).usage_bytes,
    );
    storage.db
      .prepare("UPDATE sync_relay_workspace_usage SET usage_bytes = ? WHERE workspace_id = ?")
      .run(storage.options.workspaceQuotaBytes, WORKSPACE);
    const quotaRes = await handler(
      request(
        OWNER,
        `/sync/${WORKSPACE}/webhooks/outbound-dispatch`,
        jsonBody({
          collectionId: "obj-schema-bom",
          collectionPath: COLLECTION,
          automationId: "notify-hook",
          stepOrdinal: 1,
          approvalDigest: bomDigest,
          deliveryId: createHash("sha256").update("quota-delivery").digest("hex"),
          chainDepth: 0,
          evaluatedSafeHeaders: [
            { name: "X-Fixed", value: "literal-value" },
            { name: "X-Dynamic", value: "bom-v1" },
          ],
          evaluatedBody: JSON.stringify({ title: "Quota" }),
          defaultContentType: "application/json",
        }),
      ),
    );
    expect(quotaRes.status).toBe(507);
    expect(await quotaRes.json()).toMatchObject({
      ok: false,
      error: "quota_exceeded",
      beforeSend: true,
    });
    expect(sent).toHaveLength(1);

    // Restore quota and replace Tasks/collection.yaml with a NEW objectId -> old approval must be refused.
    storage.db
      .prepare("UPDATE sync_relay_workspace_usage SET usage_bytes = ? WHERE workspace_id = ?")
      .run(originalUsage, WORKSPACE);
    await commitFiles(handler, [
      {
        objectId: "obj-schema-replaced",
        path: `${COLLECTION}/collection.yaml`,
        text: COLLECTION_SCHEMA,
      },
    ]);
    const replacedRes = await handler(
      request(
        OWNER,
        `/sync/${WORKSPACE}/webhooks/outbound-dispatch`,
        jsonBody({
          collectionId: "obj-schema-bom",
          collectionPath: COLLECTION,
          automationId: "notify-hook",
          stepOrdinal: 1,
          approvalDigest: bomDigest,
          deliveryId: createHash("sha256").update("replaced-col-delivery").digest("hex"),
          chainDepth: 0,
          evaluatedSafeHeaders: [
            { name: "X-Fixed", value: "literal-value" },
            { name: "X-Dynamic", value: "bom-v1" },
          ],
          evaluatedBody: JSON.stringify({ title: "Replaced" }),
          defaultContentType: "application/json",
        }),
      ),
    );
    expect(replacedRes.status).toBe(409);
    expect(await replacedRes.json()).toMatchObject({
      ok: false,
      error: "definition_not_synced",
      beforeSend: true,
    });
    expect(sent).toHaveLength(1);

    // Multibyte Unicode error reason must truncate by UTF-8 bytes <= 500 without exceeding headroom.
    const unicodeDelivery = createHash("sha256").update("unicode-error").digest("hex");
    storage.reserveWorkspaceHttpDispatch({
      workspaceId: WORKSPACE,
      ownerUserId: OWNER,
      deliveryId: unicodeDelivery,
      nowMs: 5_000,
    });
    storage.finalizeWorkspaceHttpDispatch({
      workspaceId: WORKSPACE,
      deliveryId: unicodeDelivery,
      status: "failed",
      httpStatus: 500,
      errorReason: "日".repeat(400),
      nowMs: 5_100,
    });
    const row = storage.db
      .prepare(
        "SELECT error_reason, storage_bytes FROM sync_relay_http_dispatches WHERE delivery_id = ?",
      )
      .get(unicodeDelivery) as { error_reason: string; storage_bytes: number };
    expect(Buffer.byteLength(row.error_reason, "utf8")).toBeLessThanOrEqual(500);
    expect(row.storage_bytes).toBeLessThanOrEqual(
      Buffer.byteLength(unicodeDelivery, "utf8") + 32 + 500,
    );
  });

  it("rechecks desktop sign-in inside automation-server/allow before committing an HTTP approval and blocks non-desktop callers", async () => {
    let desktopSignedIn = true;
    const allowSpy = vi.fn(
      async (
        _scope: { workspaceId: string; ownerUserId: string },
        _input: unknown,
        options?: { recheckDesktopHttpApproval?: () => Promise<void> },
      ) => {
        if (!options?.recheckDesktopHttpApproval) return "changed" as const;
        await options.recheckDesktopHttpApproval();
        return "confirmed" as const;
      },
    );
    const { handler } = await setup({
      resolveActor: async (req, workspaceId) => {
        const match = /^Bearer (user|phone):([^ ]+)$/u.exec(req.headers.get("authorization") ?? "");
        if (!match) throw new UnauthorizedError();
        return { userId: match[2]!, workspaceId };
      },
      resolvePhoneCapableAccountSession: async (req) => {
        const match = /^Bearer (user|phone):([^ ]+)$/u.exec(req.headers.get("authorization") ?? "");
        if (!match) throw new UnauthorizedError();
        if (match[1] === "user" && !desktopSignedIn) throw new UnauthorizedError();
        return {
          userId: match[2]!,
          sessionId: `${match[1]}:${match[2]!}`,
          expiresAtMs: Number.MAX_SAFE_INTEGER,
          clientKind: match[1] === "phone" ? "phone" : "desktop",
        };
      },
      serverRuns: () => ({
        list: async () => ({ runs: [], next: null }),
        get: async () => null,
        retry: async () => ({ status: "refused", reason: "none" }),
        undo: async () => ({ status: "refused", reason: "none" }),
        restore: async () => ({
          undone: 0,
          left: 0,
          reverted: 0,
          missing: 0,
          keptFields: [],
          otherKept: 0,
          errorMessage: null,
        }),
        holds: () => [],
        allow: allowSpy,
      }),
    });

    const body = {
      automationId: "collection:obj-schema#notify",
      definitionHash: "a".repeat(16),
      step: "http:0",
      seq: 1,
    };

    const phoneAllow = await handler(
      new Request(`http://relay.test/sync/${WORKSPACE}/automation-server/allow`, {
        method: "POST",
        headers: {
          authorization: `Bearer phone:${OWNER}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      }),
    );
    expect(phoneAllow.status).toBe(200);
    expect(await phoneAllow.json()).toEqual({ ok: true, status: "changed" });

    const desktopAllow = await handler(
      request(OWNER, `/sync/${WORKSPACE}/automation-server/allow`, jsonBody(body)),
    );
    expect(desktopAllow.status).toBe(200);
    expect(await desktopAllow.json()).toEqual({ ok: true, status: "confirmed" });

    allowSpy.mockImplementationOnce(async (_scope, _input, options) => {
      desktopSignedIn = false;
      await options!.recheckDesktopHttpApproval!();
      return "confirmed";
    });
    const revokedAllow = await handler(
      request(OWNER, `/sync/${WORKSPACE}/automation-server/allow`, jsonBody(body)),
    );
    expect(revokedAllow.status).toBe(401);
  });

  it("retires superseded approval digests for the same step instead of exhausting the workspace approval cap", async () => {
    const { handler } = await setup();
    const firstDigest = createHash("sha256").update("rev-1").digest("hex");
    const secondDigest = createHash("sha256").update("rev-2").digest("hex");

    const approveFirst = await handler(
      request(
        OWNER,
        `/sync/${WORKSPACE}/webhooks/http-approvals`,
        jsonBody({
          approvalDigest: firstDigest,
          collectionId: "obj-schema",
          collectionPath: COLLECTION,
          automationId: "notify-hook",
          stepOrdinal: 1,
        }),
      ),
    );
    expect(approveFirst.status).toBe(200);

    const approveSecond = await handler(
      request(
        OWNER,
        `/sync/${WORKSPACE}/webhooks/http-approvals`,
        jsonBody({
          approvalDigest: secondDigest,
          collectionId: "obj-schema",
          collectionPath: COLLECTION,
          automationId: "notify-hook",
          stepOrdinal: 1,
        }),
      ),
    );
    expect(approveSecond.status).toBe(200);

    const listed = await handler(request(OWNER, `/sync/${WORKSPACE}/webhooks/http-approvals`));
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({ ok: true, secrets: [], approvals: [secondDigest] });
  });
});
