import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash, createHmac } from "node:crypto";
import {
  UnauthorizedError,
  type ResolveAccountSession,
  type StoredAccountSession,
} from "@dohc/workspace-auth/session";
import { createLiveTickets } from "./liveTickets.js";
import { createLiveHostReports } from "./namedLiveHostReports";
import { createPhoneMemberLiveSessions } from "./phonePages";
import {
  chatChannelCreate,
  chatMessageAppend,
  chatThreadCreate,
  json,
  jsonBody,
  request,
  sequenced,
  testHandler,
} from "./testing";
import { LIVE_CONNECTION_LIMIT_CLOSE_CODE } from "@dohc/live-session-contract/live-connection";
import { LIVE_TICKET_LIFETIME_MS } from "@dohc/live-session-contract/live-ticket";
import { selfHostLiveProfile } from "./selfHostLiveProfile";
import { observeRelayWrites } from "./relayWriteChanges";
import { WORKSPACE_SHARE_SELECTOR_JSON } from "./storage/workspaceMembers";
import { fenceAccount, initializeAccountDeletion } from "./storage/accountDeletion";
import type { StorageContext } from "./storage/context.js";
import { createLiveConnectionAdmission } from "./liveConnectionAdmission";
import { once } from "node:events";
import * as Y from "yjs";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createLiveRooms, type LiveRooms } from "./liveRoom.js";
import type { NamedFrameRoomHost } from "./namedLiveFrameHost.js";
import {
  createLiveFrameSession,
  encodeLiveFrame,
  type LiveFrame,
} from "@dohc/live-session-contract/live-frame";
import { createLiveMarkdownJournalValidator } from "@dohc/ydoc-projection/live-journal-validation";
import { createNamedLiveRoutes, OWNER_SESSION_CHECK_MS } from "./namedLiveRoutes.js";
import { hashLinkBearer, hashLinkProfileSecret } from "./linkSecurity.js";
import { createNamedLiveProvider } from "@dohc/ydoc-projection/named-live-provider";
import { liveBrowserActor } from "./liveBrowserContext.js";
import { captureNamedLiveFrameHost, captureOwnerLiveFrameHost } from "./namedLiveFrameHost.js";
import { createNamedFrameChanges, type NamedFrameNativeHost } from "./namedLiveFrameHost.js";
import { audience, binding, host, key, scope, seedLinkAgent } from "./liveTickets.test-helper.js";
import type { LiveUpdateJournalCut } from "./storage/types.js";
import type { LiveObjectBinding } from "@dohc/live-session-contract/live-object-binding";
import type { LiveAuthorContext } from "@dohc/live-session-contract";
import { NAMED_LIVE_STOPPED, linkRefusalBody } from "@dohc/security-contract/link-refusal";

import {
  fixture,
  relayHost,
  frames,
  bounds,
  policy,
  limits,
  cleanups,
  phoneState,
  phoneScope,
  phoneHeaders,
  browserHeaders,
  browserScope,
  openProductionSync,
} from "./namedLiveRoutes.test-helper";

it("refuses desktop cross-account, scope, Origin, cookie, and host changes", async () => {
  const f = await fixture(limits, false, undefined, false, true);
  const body = { shareId: scope.shareId, path: binding.currentPath };
  for (const headers of [
    { authorization: "Bearer other-token" },
    { origin: "https://evil.test" },
    { cookie: "account=reader" },
    { host: "evil.test" },
  ] as Record<string, string>[]) {
    expect((await f.post("/sync/live/desktop-open", body, "", headers)).status).toBe(404);
  }
  for (const path of ["other/a.md", "docs/missing.md", "docs/a.excalidraw", "../docs/a.md"]) {
    expect((await f.post("/sync/live/desktop-open", { ...body, path })).status).toBe(404);
  }
  const ticket = await f.mint();
  expect(
    await f.connect(ticket.token, "", { authorization: "Bearer other-token" }).status,
  ).not.toBe(101);
  expect(await f.connect(ticket.token, "", { origin: "https://evil.test" }).status).not.toBe(101);
  expect(await f.connect(ticket.token, "", { cookie: "account=reader" }).status).not.toBe(101);
  expect(await f.connect(ticket.token).status).toBe(101);
});

it("finishes a desktop open started during reconnect after one host readiness wake", async () => {
  const f = await fixture(limits, false, undefined, false, true);
  f.captureNative.mockRejectedValue(new Error("Host reconnecting."));
  const mint = vi.spyOn(f.tickets, "mint");
  const waiting = f.post("/sync/live/desktop-open", {
    shareId: scope.shareId,
    path: binding.currentPath,
  });
  await vi.waitFor(() => expect(mint).toHaveBeenCalledTimes(1));
  f.captureNative.mockResolvedValue(f.native);
  f.changes.notifyHost([binding.workspaceId]);
  const response = await waiting;
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    objectId: binding.objectId,
    path: binding.currentPath,
    ticket: { token: expect.any(String) },
  });
  expect(mint).toHaveBeenCalledTimes(2);
  expect(f.changes.listenerCount()).toBe(0);
});

it("edits an invited desktop's note in the note's room", async () => {
  const join = vi.fn((captured: NamedFrameRoomHost) => captured);
  const f = await fixture(
    limits,
    false,
    undefined,
    false,
    true,
    undefined,
    0,
    0,
    false,
    undefined,
    undefined,
    undefined,
    { join } as unknown as LiveRooms,
  );
  const client = f.connect((await f.mint()).token);
  expect(await client.status).toBe(101);
  await client.until(() => client.received.some((frame) => frame.kind === "welcome"));
  expect(join).toHaveBeenCalledOnce();
});

it.each(["held", "stopped"] as const)(
  "opens no invited desktop on a %s note, and opens it once it stands again",
  async (block) => {
    const f = await fixture(limits, false, undefined, false, true);
    const body = { shareId: scope.shareId, path: binding.currentPath };
    const mint = vi.spyOn(f.tickets, "mint");
    f.sessionHostBlocked.mockReturnValue(block);
    expect((await f.post("/sync/live/desktop-open", body)).status).toBe(404);
    expect(await (await f.desktopAdmission!.handle(readinessRequest())).text()).toBe(
      "waiting\nunavailable\n",
    );
    expect(mint).not.toHaveBeenCalled();
    f.sessionHostBlocked.mockReturnValue(undefined);
    expect((await f.post("/sync/live/desktop-open", body)).status).toBe(200);
  },
);

function readinessRequest(user = "reader", path = binding.currentPath) {
  return new Request(`https://${relayHost}/sync/live/desktop-ready`, {
    method: "POST",
    headers: {
      host: relayHost,
      authorization: `Bearer ${user}-token`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ shareId: scope.shareId, path }),
  });
}

it("caps readiness per authenticated user and frees that user's slot on cancel", async () => {
  const f = await fixture(limits, false, undefined, false, true);
  const mint = vi.spyOn(f.tickets, "mint").mockResolvedValue(null);
  const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
  try {
    for (let index = 0; index < 4; index++) {
      const reader = (await f.desktopAdmission!.handle(readinessRequest())).body!.getReader();
      readers.push(reader);
      await reader.read();
    }
    await vi.waitFor(() => expect(mint).toHaveBeenCalledTimes(4));
    expect(await (await f.desktopAdmission!.handle(readinessRequest())).text()).toBe(
      "waiting\nunavailable\n",
    );
    expect(mint).toHaveBeenCalledTimes(4);
    await readers.shift()!.cancel();
    const replacement = (await f.desktopAdmission!.handle(readinessRequest())).body!.getReader();
    readers.push(replacement);
    await replacement.read();
    await vi.waitFor(() => expect(mint).toHaveBeenCalledTimes(5));
  } finally {
    await Promise.all(readers.map((reader) => reader.cancel()));
  }
});

it("rechecks access and releases a waiting readiness subscription on cancellation", async () => {
  const f = await fixture(limits, false, undefined, false, true);
  const mint = vi.spyOn(f.tickets, "mint").mockResolvedValue(null);
  const request = () =>
    new Request(`https://${relayHost}/sync/live/desktop-ready`, {
      method: "POST",
      headers: {
        host: relayHost,
        authorization: "Bearer reader-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ shareId: scope.shareId, path: binding.currentPath }),
    });
  const cancelled = (await f.desktopAdmission!.handle(request())).body!.getReader();
  await cancelled.read();
  await vi.waitFor(() => expect(mint).toHaveBeenCalledTimes(1));
  await cancelled.cancel();
  const reader = (await f.desktopAdmission!.handle(request())).body!.getReader();
  await reader.read();
  await vi.waitFor(() => expect(mint).toHaveBeenCalledTimes(2));
  f.raw.prepare("UPDATE sync_relay_share_grants SET access='view'").run();
  f.changes.notify(binding);
  expect(new TextDecoder().decode((await reader.read()).value)).toBe("unavailable\n");
  expect((await reader.read()).done).toBe(true);
  expect(mint).toHaveBeenCalledTimes(2);
});

afterEach(async () => {
  const owned = cleanups.splice(0).reverse();
  vi.restoreAllMocks();
  for (const cleanup of owned) await cleanup();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
// A held document waits for its owner, so the page is told and stops asking. Other blocks say nothing new.
it.each([
  [false, "stopped"],
  [true, "stopped"],
  [false, "held"],
  [true, "held"],
] as const)(
  "refuses a ticket for a document the session host blocked until the block lifts; link=%s, %s",
  async (link, block) => {
    const f = await fixture(limits, link);
    const mint = vi.spyOn(f.tickets, "mint");
    f.sessionHostBlocked.mockReturnValue(block);
    const refused = await f.post(`/sync/live/${link ? "link" : "named"}-tickets`, {
      discriminator: f.discriminator,
      objectId: binding.objectId,
    });
    expect([refused.status, await refused.json()]).toEqual(
      link
        ? [503, linkRefusalBody(block === "held" ? "link_live_stopped" : "link_live_unavailable")]
        : [404, block === "held" ? NAMED_LIVE_STOPPED : { ok: false, error: "not found" }],
    );
    expect(f.sessionHostBlocked).toHaveBeenCalledWith({
      workspaceId: binding.workspaceId,
      objectId: binding.objectId,
    });
    expect(mint).not.toHaveBeenCalled();
    // A document the caller can't reach says nothing about its block.
    const hidden = await f.post(`/sync/live/${link ? "link" : "named"}-tickets`, {
      discriminator: f.discriminator,
      objectId: "hidden-object",
    });
    expect([hidden.status, await hidden.text()]).toEqual([404, '{"ok":false,"error":"not found"}']);
    // Nor does a real document the share no longer covers.
    const select = f.raw.prepare("UPDATE sync_relay_shares SET selector_json=?");
    select.run(JSON.stringify({ paths: ["other.md"], versionId: null }));
    const outside = await f.post(`/sync/live/${link ? "link" : "named"}-tickets`, {
      discriminator: f.discriminator,
      objectId: binding.objectId,
    });
    expect([outside.status, await outside.text()]).toEqual([
      404,
      '{"ok":false,"error":"not found"}',
    ]);
    select.run(JSON.stringify({ paths: [binding.currentPath], versionId: null }));
    f.sessionHostBlocked.mockReturnValue(undefined);
    expect(await f.connect((await f.mint()).token).status).toBe(101);
  },
);

// Moving a note's file ends its binding, and the room pauses the note. Only the owner can start it again.
it("tells a link holder a held note whose file moved stopped, not to try again", async () => {
  const f = await fixture(limits, true);
  f.raw
    .prepare("UPDATE sync_relay_shares SET selector_json=?")
    .run(JSON.stringify({ paths: ["docs"], versionId: null }));
  f.raw
    .prepare(
      `INSERT INTO sync_relay_object_moments (workspace_id, object_id, relay_seq, moment_id, version_id, path, blob_sha256, content_kind, byte_length, recorded_at_ms)
      VALUES (?, ?, 99, 'moved', 'main', 'docs/moved.md', ?, 'text', 1, 2)`,
    )
    .run(binding.workspaceId, binding.objectId, "b".repeat(64));
  const ask = async () => {
    const response = await f.post("/sync/live/link-tickets", {
      discriminator: f.discriminator,
      objectId: binding.objectId,
    });
    return [response.status, await response.json()];
  };
  // Before the pause, the holder may try again: the owner's desktop can host the note at its new path.
  expect(await ask()).toEqual([503, linkRefusalBody("link_live_unavailable")]);
  f.sessionHostBlocked.mockReturnValue("held");
  expect(await ask()).toEqual([503, linkRefusalBody("link_live_stopped")]);
});

// A note with no binding answers from its record: starting tells the page to wait, off that only the owner can start it.
it.each([true, false])(
  "tells a caller who reaches a note with no binding whether it is starting or off; link=%s",
  async (link) => {
    const f = await fixture(limits, link);
    const select = f.raw.prepare("UPDATE sync_relay_shares SET selector_json=?");
    select.run(JSON.stringify({ paths: ["docs"], versionId: null }));
    f.raw
      .prepare(
        `INSERT INTO sync_relay_object_moments (workspace_id, object_id, relay_seq, moment_id, version_id, path, blob_sha256, content_kind, byte_length, recorded_at_ms)
        VALUES (?, ?, 99, 'moved', 'main', 'docs/moved.md', ?, 'text', 1, 2)`,
      )
      .run(binding.workspaceId, binding.objectId, "b".repeat(64));
    const ask = async () => {
      const response = await f.post(`/sync/live/${link ? "link" : "named"}-tickets`, {
        discriminator: f.discriminator,
        objectId: binding.objectId,
      });
      return [response.status, await response.json()];
    };
    const stopped = link ? [503, linkRefusalBody("link_live_stopped")] : [404, NAMED_LIVE_STOPPED];
    f.liveNote.mockReturnValue("starting");
    expect(await ask()).toEqual([503, linkRefusalBody("link_live_starting")]);
    expect(f.liveNote).toHaveBeenCalledWith({
      workspaceId: binding.workspaceId,
      objectId: binding.objectId,
    });
    f.sessionHostBlocked.mockReturnValue("held");
    expect(await ask()).toEqual(stopped);
    f.sessionHostBlocked.mockReturnValue(undefined);
    f.liveNote.mockReturnValue("off");
    expect(await ask()).toEqual(stopped);
    select.run(JSON.stringify({ paths: ["other.md"], versionId: null }));
    expect(await ask()).toEqual([404, { ok: false, error: "not found" }]);
  },
);

// A note whose record says live before its host serves it waits, and one its host won't start is off. Only a caller
// who reaches the note learns either.
it.each([true, false])(
  "tells a caller who reaches a bound note whether it is still starting or off before minting; link=%s",
  async (link) => {
    const f = await fixture(limits, link);
    const ask = async () => {
      const response = await f.post(`/sync/live/${link ? "link" : "named"}-tickets`, {
        discriminator: f.discriminator,
        objectId: binding.objectId,
      });
      return [response.status, await response.json()];
    };
    f.liveNote.mockReturnValue("starting");
    expect(await ask()).toEqual([503, linkRefusalBody("link_live_starting")]);
    f.liveNote.mockReturnValue("off");
    expect(await ask()).toEqual(
      link ? [503, linkRefusalBody("link_live_stopped")] : [404, NAMED_LIVE_STOPPED],
    );
    f.liveNote.mockReturnValue(undefined);
    expect((await ask())[0]).toBe(200);
    f.liveNote.mockReturnValue("starting");
    f.raw
      .prepare("UPDATE sync_relay_shares SET selector_json=?")
      .run(JSON.stringify({ paths: ["other.md"], versionId: null }));
    f.liveNote.mockClear();
    expect(await ask()).toEqual([404, { ok: false, error: "not found" }]);
    expect(f.liveNote).not.toHaveBeenCalled();
  },
);

it("says in the server log why a link holder was told to try again, once for each reason and with no id of the note, workspace or link", async () => {
  const f = await fixture(limits, true);
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  const told = () =>
    logged.mock.calls
      .map(([line]) => String(line))
      .filter((line) => line.includes("live open told to try again"));
  f.raw
    .prepare("UPDATE sync_relay_shares SET selector_json=?")
    .run(JSON.stringify({ paths: ["docs"], versionId: null }));
  f.raw
    .prepare(
      `INSERT INTO sync_relay_object_moments (workspace_id, object_id, relay_seq, moment_id, version_id, path, blob_sha256, content_kind, byte_length, recorded_at_ms)
      VALUES (?, ?, 99, 'moved', 'main', 'docs/moved.md', ?, 'text', 1, 2)`,
    )
    .run(binding.workspaceId, binding.objectId, "b".repeat(64));
  const ask = async () =>
    (
      await f.post("/sync/live/link-tickets", {
        discriminator: f.discriminator,
        objectId: binding.objectId,
      })
    ).status;
  expect([await ask(), await ask()]).toEqual([503, 503]);
  f.sessionHostBlocked.mockReturnValue("held");
  expect(await ask()).toBe(503);
  expect(told()).toHaveLength(2);
  expect(told()[0]).toMatch(
    /^\[sync-relay\] live open told to try again: the note has no binding \((host-unavailable|stale-document)\), host says stopped \(1x\)$/u,
  );
  expect(told()[1]).toMatch(/the note has no binding \([a-z-]+\), host says held \(1x\)$/u);
  for (const line of told())
    for (const secret of [binding.objectId, binding.workspaceId, f.discriminator])
      expect(line).not.toContain(secret);
});

it("names a live host failure it knows in the server log, and only the class of any other", async () => {
  const f = await fixture(limits, true);
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  const told = () =>
    logged.mock.calls
      .map(([line]) => String(line))
      .filter((line) => line.includes("live open told to try again"));
  const ask = async () =>
    (
      await f.post("/sync/live/link-tickets", {
        discriminator: f.discriminator,
        objectId: binding.objectId,
      })
    ).status;
  f.captureNative.mockRejectedValue(new Error("Service document activation is incomplete."));
  expect(await ask()).toBe(503);
  f.captureNative.mockRejectedValue(new Error("Cannot open /srv/notes/private-plan.md"));
  expect(await ask()).toBe(503);
  expect(told()).toEqual([
    "[sync-relay] live open told to try again: the open failed: Service document activation is incomplete. (1x)",
    "[sync-relay] live open told to try again: the open failed: Error (1x)",
  ]);
});

it("writes no try-again line for an invited editor's refused open or for a link holder's not found", async () => {
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  const told = () =>
    logged.mock.calls
      .map(([line]) => String(line))
      .filter((line) => line.includes("live open told to try again"));
  const named = await fixture(limits, false);
  named.sessionHostBlocked.mockReturnValue("stopped");
  expect(
    (
      await named.post("/sync/live/named-tickets", {
        discriminator: named.discriminator,
        objectId: binding.objectId,
      })
    ).status,
  ).toBe(404);
  const link = await fixture(limits, true);
  expect(
    (
      await link.post("/sync/live/link-tickets", {
        discriminator: link.discriminator,
        objectId: "hidden-object",
      })
    ).status,
  ).toBe(404);
  expect(told()).toEqual([]);
});

it.each([false, true])(
  "asks a link holder or agent to try again while its share of tickets is full; link=%s",
  async (link) => {
    const f = await fixture(limits, link);
    const ask = async () => {
      const response = await f.post(`/sync/live/${link ? "link" : "named"}-tickets`, {
        discriminator: f.discriminator,
        objectId: binding.objectId,
      });
      return [response.status, await response.json()];
    };
    expect((await ask())[0]).toBe(200);
    expect((await ask())[0]).toBe(200);
    expect(await ask()).toEqual(
      link
        ? [503, linkRefusalBody("link_live_unavailable")]
        : [404, { ok: false, error: "not found" }],
    );
    if (!link) return;
    // An agent on the same link holds its own share.
    f.useCredentials(linkAgent(f).headers);
    expect((await ask())[0]).toBe(200);
    expect((await ask())[0]).toBe(200);
    expect(await ask()).toEqual([503, linkRefusalBody("link_live_unavailable")]);
  },
);

it.each([false, true])(
  "mints through actual HTTP auth and redeems once before exposing only live frames; link=%s",
  async (link) => {
    const f = await fixture(limits, link),
      minted = await f.mint();
    expect(Object.keys(minted).sort()).toEqual(
      link ? ["expiresAtMs", "publicPrincipalId", "token"] : ["expiresAtMs", "token"],
    );
    if (link) {
      const publicId = minted.publicPrincipalId;
      expect(publicId).toMatch(/^public_/);
      expect(
        f.raw.prepare("SELECT public_principal_id FROM sync_relay_app_public_principals").get(),
      ).toEqual({ public_principal_id: publicId });
      expect((await f.mint()) as Record<string, unknown>).toMatchObject({
        publicPrincipalId: publicId,
      });
    }
    const browser = f.connect(minted.token);
    expect(await browser.status).toBe(101);
    await browser.until(() => browser.received.some((frame) => frame.kind === "welcome"));
    expect(browser.ws.protocol).toBe("dohc-live-v1");
    expect(browser.received[0]).toMatchObject({ kind: "welcome", hostEpoch: host.hostEpoch });
    expect(JSON.stringify(browser.received)).not.toContain("never-send-native-handle");
    expect(JSON.stringify(browser.received)).not.toContain("registrationId");
    expect(
      f.raw.prepare("SELECT redeemed_at_ms FROM sync_relay_live_session_tickets").get(),
    ).toEqual({ redeemed_at_ms: 1000 });
    expect(await f.connect(minted.token).status).toBe(404);
  },
);

it.each(["anonymous", "account=other"])(
  "refuses %s on HTTP and WebSocket without consuming the valid ticket",
  async (cookie) => {
    const f = await fixture(),
      minted = await f.mint();
    expect(
      (
        await f.post(
          "/sync/live/named-tickets",
          { discriminator: f.discriminator, objectId: binding.objectId },
          cookie,
        )
      ).status,
    ).toBe(404);
    expect(await f.connect(minted.token, cookie).status).toBe(404);
    expect(
      f.raw.prepare("SELECT redeemed_at_ms FROM sync_relay_live_session_tickets").get(),
    ).toEqual({ redeemed_at_ms: null });
    expect(await f.connect(minted.token).status).toBe(101);
  },
);

it.each(["grant", "fence", "host"])(
  "refuses a %s change between mint and upgrade",
  async (changed) => {
    const f = await fixture(),
      minted = await f.mint();
    if (changed === "grant")
      f.raw.exec("UPDATE sync_relay_share_grants SET generation=generation+1");
    if (changed === "fence")
      f.raw.exec(
        "UPDATE sync_relay_live_documents SET restore_fence_generation=restore_fence_generation+1",
      );
    if (changed === "host") f.invalidated.abort();
    expect(await f.connect(minted.token).status).toBe(404);
  },
);

it.each<Record<string, string>>([
  { origin: "https://foreign.example" },
  { "x-dohc-relay-exchange-key": "wrong" },
  { host: "foreign.example" },
])("rejects untrusted forwarded route headers %j", async (headers) => {
  const f = await fixture(),
    minted = await f.mint();
  expect(
    (
      await f.post(
        "/sync/live/named-tickets",
        { discriminator: f.discriminator, objectId: binding.objectId },
        "account=reader",
        headers,
      )
    ).status,
  ).toBe(404);
  expect(await f.connect(minted.token, "account=reader", headers).status).toBe(404);
  expect(f.raw.prepare("SELECT redeemed_at_ms FROM sync_relay_live_session_tickets").get()).toEqual(
    { redeemed_at_ms: null },
  );
});

it("checks standing again when native capture finishes after a grant change", async () => {
  const f = await fixture(),
    minted = await f.mint(),
    entered = deferred<void>(),
    resume = deferred<void>();
  let calls = 0;
  f.captureNative.mockImplementation(async () => {
    if (++calls === 2) {
      entered.resolve();
      await resume.promise;
    }
    return f.native;
  });
  const browser = f.connect(minted.token);
  await entered.promise;
  f.raw.exec("UPDATE sync_relay_share_grants SET generation=generation+1");
  resume.resolve();
  expect(await browser.status).toBe(404);
  expect(f.native.client.openLiveAppliedSync).not.toHaveBeenCalled();
});

it("never accepts browser identity fields or mismatched trusted share scope", async () => {
  const f = await fixture();
  expect(
    (
      await f.post("/sync/live/named-tickets", {
        discriminator: f.discriminator,
        objectId: binding.objectId,
        userId: scope.userId,
      })
    ).status,
  ).toBe(404);
  expect(
    f.storage.resolveLiveObjectHostBinding({ ...scope, shareId: "other-share" }, binding.objectId),
  ).toMatchObject({ kind: "refused", reason: "not-authorized" });
  expect(f.storage.resolveLiveObjectHostBinding(scope, "missing-object")).toMatchObject({
    kind: "refused",
    reason: "stale-document",
  });
  expect(f.captureNative).not.toHaveBeenCalled();
});

it("keeps a link socket through bearer refresh and closes it on revocation", async () => {
  const f = await fixture(limits, true),
    minted = await f.mint(),
    browser = f.connect(minted.token);
  expect(await browser.status).toBe(101);
  await browser.until(() => browser.received.some((frame) => frame.kind === "welcome"));
  const principal = f.raw
    .prepare("SELECT principal_id,display_name FROM sync_relay_link_principals")
    .get()!;
  expect(principal.display_name).toBeNull();
  const serialized = JSON.stringify({
    frames: browser.received,
    ticket: f.raw.prepare("SELECT * FROM sync_relay_live_session_tickets").get(),
  });
  for (const secret of [
    f.bearer,
    f.profile,
    hashLinkBearer(f.bearer, key),
    hashLinkProfileSecret(f.profile, key),
  ])
    expect(serialized).not.toContain(secret);
  const old = f.storage.findLinkSessionByCapabilityHash(hashLinkBearer(f.bearer, key))!;
  expect(
    f.storage.replaceLinkSession({
      currentSession: old,
      session: {
        sessionId: old.sessionId,
        capabilityHash: hashLinkBearer("fresh", key),
        grantId: old.grantId,
        generation: old.generation,
        mintedAtMs: 1000,
        expiresAtMs: 70_000,
      },
      guard() {},
    }),
  ).toBe(true);
  f.changes.notifyWrite();
  expect(f.storage.findLinkSessionByCapabilityHash(old.capabilityHash)).toBeNull();
  expect(
    (
      await f.post("/sync/live/link-tickets", {
        discriminator: f.discriminator,
        objectId: binding.objectId,
      })
    ).status,
  ).toBe(404);
  const pong = once(browser.ws, "pong");
  browser.ws.ping("still-connected");
  await pong;
  const { provider, until } = await startProvider(browser);
  await until(() => provider.state().status === "live");
  expect(provider.state().binding?.workspaceId).toBe(`link:${scope.grantId}`);
  const closed = once(browser.ws, "close");
  f.storage.revokeShareGrant({ shareId: scope.shareId, grantId: scope.grantId, revokedAtMs: 1001 });
  f.changes.notifyWrite();
  await closed;
  expect(f.invalidated.signal.aborted).toBe(false);
  expect(
    f.raw.prepare("SELECT link_session_id FROM sync_relay_live_session_tickets").get(),
  ).toEqual({ link_session_id: old.sessionId });
});

async function pingOutcome(socket: ReturnType<Awaited<ReturnType<typeof fixture>>["connect"]>) {
  const pong = once(socket.ws, "pong").then(
    () => "pong",
    () => "error",
  );
  socket.ws.ping("keepalive");
  return Promise.race([pong, socket.closed.then(() => "closed")]);
}

it.each([false, true])(
  "keeps a share page editor open while its gateway pings and closes it once pings stop; link=%s",
  async (link) => {
    const routeLimits = { ...limits, idleTimeoutMs: 1000 };
    const f = await fixture(routeLimits, link),
      browser = f.connect((await f.mint()).token);
    expect(await browser.status).toBe(101);
    await browser.until(() => browser.received.some((frame) => frame.kind === "welcome"));
    // The gateway pings every half idle period; these come faster, for three idle periods.
    const opened = performance.now();
    while (performance.now() - opened < 3 * routeLimits.idleTimeoutMs) {
      expect(await pingOutcome(browser)).toBe("pong");
      await new Promise((resolve) => setTimeout(resolve, routeLimits.idleTimeoutMs / 5));
    }
    await browser.closed;
  },
);

it("closes a link editor on the gateway's first ping after its link session expires", async () => {
  const f = await fixture(limits, true),
    browser = f.connect((await f.mint()).token);
  expect(await browser.status).toBe(101);
  await browser.until(() => browser.received.some((frame) => frame.kind === "welcome"));
  expect(await pingOutcome(browser)).toBe("pong");
  // The fixture's link session expires at 61 s.
  vi.mocked(Date.now).mockReturnValue(61_000);
  expect(await pingOutcome(browser)).toBe("closed");
});

it.each<Record<string, string>>([
  { authorization: "" },
  { "x-dohc-link-profile-secret": "" },
  { "x-dohc-link-profile-secret": Buffer.alloc(32, 9).toString("base64url") },
  { origin: "https://other.example" },
  { host: "other.example" },
  { "x-dohc-relay-exchange-key": "forged" },
])(
  "refuses invalid private link credentials and origin without consuming a ticket: %j",
  async (headers) => {
    const f = await fixture(limits, true),
      minted = await f.mint();
    expect(
      (
        await f.post(
          "/sync/live/link-tickets",
          { discriminator: f.discriminator, objectId: binding.objectId },
          "anonymous",
          headers,
        )
      ).status,
    ).toBe(404);
    expect(await f.connect(minted.token, "anonymous", headers).status).toBe(404);
    expect(
      f.raw.prepare("SELECT redeemed_at_ms FROM sync_relay_live_session_tickets").get(),
    ).toEqual({ redeemed_at_ms: null });
    expect(await f.connect(minted.token, "anonymous").status).toBe(101);
  },
);

type LinkFixture = Awaited<ReturnType<typeof fixture>>;
// The agent signed in nearly an hour ago: its token expires before a link holder's session (61 s).
const agentExpiresAtMs = 2000;
function linkAgent(f: LinkFixture, connectionId = "agent-connection") {
  const { workspaceId, shareId, grantId } = f.currentScope;
  return seedLinkAgent(f.raw, {
    connectionId,
    workspaceId,
    shareId,
    grantId,
    generation: 4,
    expiresAtMs: agentExpiresAtMs,
  });
}
const liveDocument = {
  workspaceId: binding.workspaceId,
  mainVersionId: "main",
  objectId: binding.objectId,
  lineageClaimId: binding.lineageClaimId,
};

it("refuses an agent's ticket for another MCP address, and a token for another link, without consuming its ticket", async () => {
  const f = await fixture(limits, true),
    agent = linkAgent(f);
  f.raw
    .exec(`INSERT INTO sync_relay_shares (share_id, workspace_id, granter_user_id, selector_json, created_at_ms)
      VALUES ('other-share', '${binding.workspaceId}', 'owner-1', '{"paths":["other"],"versionId":null}', 0);
    INSERT INTO sync_relay_share_grants (grant_id,share_id,principal_kind,principal_user_id,principal_email,access,generation,status,created_at_ms,revoked_at_ms,parent_grant_id)
      VALUES ('other-grant', 'other-share', 'link', NULL, NULL, 'edit', 1, 'active', 0, NULL, NULL)`);
  const other = seedLinkAgent(f.raw, {
    connectionId: "other-connection",
    workspaceId: binding.workspaceId,
    shareId: "other-share",
    grantId: "other-grant",
    generation: 1,
    expiresAtMs: agentExpiresAtMs,
  });
  const elsewhere = { ...agent.headers, "x-dohc-agent-resource": `${audience}/mcp/s/elsewhere` };
  const ticket = { discriminator: f.discriminator, objectId: binding.objectId };
  for (const headers of [elsewhere, other.headers]) {
    f.useCredentials(headers);
    expect((await f.post("/sync/live/link-tickets", ticket)).status).toBe(404);
  }
  f.useCredentials(agent.headers);
  const minted = await f.mint();
  for (const headers of [elsewhere, other.headers]) {
    f.useCredentials(headers);
    expect(await f.connect(minted.token).status).toBe(404);
  }
  expect(f.raw.prepare("SELECT redeemed_at_ms FROM sync_relay_live_session_tickets").get()).toEqual(
    { redeemed_at_ms: null },
  );
  f.useCredentials(agent.headers);
  expect(await f.connect(minted.token).status).toBe(101);
});

it("refuses an agent request that also sends a cookie, on the ticket and socket routes, without consuming its ticket", async () => {
  const f = await fixture(limits, true),
    agent = linkAgent(f);
  f.useCredentials(agent.headers);
  expect(
    (
      await f.post(
        "/sync/live/link-tickets",
        { discriminator: f.discriminator, objectId: binding.objectId },
        "account=reader",
      )
    ).status,
  ).toBe(404);
  const minted = await f.mint();
  expect(await f.connect(minted.token, "account=reader").status).toBe(404);
  expect(f.raw.prepare("SELECT redeemed_at_ms FROM sync_relay_live_session_tickets").get()).toEqual(
    { redeemed_at_ms: null },
  );
  expect(await f.connect(minted.token).status).toBe(101);
});

it("closes only the disconnected agent's live session and keeps the holder's and another agent's open", async () => {
  const f = await fixture(limits, true),
    agent = linkAgent(f),
    staying = linkAgent(f, "staying-connection");
  const holder = f.connect((await f.mint()).token);
  expect(await holder.status).toBe(101);
  f.useCredentials(staying.headers);
  const kept = f.connect((await f.mint()).token);
  expect(await kept.status).toBe(101);
  f.useCredentials(agent.headers);
  const ended = f.connect((await f.mint()).token);
  expect(await ended.status).toBe(101);
  const closed = once(ended.ws, "close");
  expect(
    f.storage.disconnectAgentConnection({
      workspaceId: agent.workspaceId,
      shareId: agent.shareId,
      grantId: agent.grantId,
      connectionId: agent.connectionId,
      nowMs: 1001,
      guard: () => undefined,
    }),
  ).not.toBeNull();
  f.changes.notifyWrite();
  await closed;
  for (const socket of [holder, kept]) {
    const pong = once(socket.ws, "pong");
    socket.ws.ping("still-open");
    await pong;
  }
  expect(
    f.storage.resolveCurrentLiveDocumentBinding({ document: liveDocument, actor: staying.actor }),
  ).toMatchObject({ kind: "current" });
});

async function startProvider(browser: ReturnType<Awaited<ReturnType<typeof fixture>>["connect"]>) {
  const provider = createNamedLiveProvider({
    frames,
    maxPendingUpdateBytes: 4096,
    maxPendingUpdates: 4,
    maxDeliveryAttempts: 2,
  });
  const route = provider.connect({
    send: (bytes) =>
      new Promise<void>((resolve, reject) =>
        browser.ws.send(bytes, (error) => (error ? reject(error) : resolve())),
      ),
    close: () => browser.ws.terminate(),
  });
  const { encodeLiveFrame } = await import("@dohc/live-session-contract/live-frame");
  for (const frame of browser.received)
    void route.receive(encodeLiveFrame(frame, frames.receive.maxFrameBytes));
  browser.ws.on("message", (bytes) => {
    void route.receive(Buffer.from(bytes as Buffer));
  });
  const until = (check: () => boolean) =>
    check()
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          const remove = provider.subscribe(() => {
            if (check()) {
              remove();
              resolve();
            }
          });
        });
  cleanups.push(async () => {
    provider.close();
    await route.settled();
    provider.doc.destroy();
  });
  await until(() => provider.state().membership !== null);
  return { provider, until };
}

async function namedMember(f: Awaited<ReturnType<typeof fixture>>) {
  f.storage.createShare({
    share: {
      shareId: "named-other-share",
      workspaceId: scope.workspaceId,
      granterUserId: "owner-1",
      selectorJson: JSON.stringify({ paths: [binding.currentPath], versionId: null }),
      createdAtMs: 1,
    },
    grant: {
      grantId: "named-other-grant",
      shareId: "named-other-share",
      principalKind: "user",
      principalUserId: scope.userId,
      principalEmail: null,
      access: "edit",
      generation: 1,
      status: "active",
      revokedAtMs: null,
      createdAtMs: 1,
      parentGrantId: null,
    },
  });
  const boot = await f.post(
    "/sync/live/named-sessions",
    { grantId: "named-other-grant" },
    "account=reader",
  );
  const { discriminator } = (await boot.json()) as { discriminator: string };
  const context = await f.application.resolveNamedBrowserSession(
    new Request("https://relay.example.test", { headers: { cookie: "account=reader" } }),
    discriminator,
  );
  if (!context) throw new Error("Named member authentication missing");
  const minted = await f.tickets.mint({ objectId: binding.objectId }, context),
    ticket = await f.tickets.redeem(minted!.token, context);
  if (!ticket) throw new Error("Named member ticket missing");
  const host = captureNamedLiveFrameHost({
    ticket,
    actor: liveBrowserActor(context),
    storage: f.storage,
    native: f.native,
    bounds,
    validate: ({ retainStateUpdate: _retainStateUpdate, ...input }) =>
      createLiveMarkdownJournalValidator(policy)(input),
  });
  const member = f.memberships.join({
    ticket,
    invalidated: host.invalidated,
    assertCurrent: host.assertCurrent,
  });
  cleanups.push(async () => {
    member.close();
    host.close();
  });
  return member;
}

it("shares authenticated named and link membership on the same path across grants and selectors", async () => {
  const f = await fixture(limits, true),
    minted = await f.mint(),
    browser = f.connect(minted.token);
  expect(await browser.status).toBe(101);
  const live = await startProvider(browser),
    named = await namedMember(f);
  await live.until(() => live.provider.state().membership?.members.length === 2);
  const first = live.provider.state().membership!;
  expect(named.snapshot(1024)).toEqual(first);
  expect(first.overflow).toBe(false);
  for (const secret of [scope.userId, scope.grantId, f.bearer, f.profile, "link-session"])
    expect(JSON.stringify(first)).not.toContain(secret);
  named.close();
  await live.until(() => live.provider.state().membership?.members.length === 1);
});

it("opens the owner bearer route without a recipient, browser cookie, ticket, or exchange key", async () => {
  const f = await fixture(limits, false, undefined, true);
  f.raw.exec("DELETE FROM sync_relay_share_grants");
  const client = f.connect("", "", { cookie: "account=reader" });
  expect(await client.status).toBe(101);
  await client.until(() => client.received.some((frame) => frame.kind === "welcome"));
  expect(client.received[0]).toMatchObject({ kind: "welcome", hostEpoch: host.hostEpoch });
  expect(f.accountSession.mock.calls[0]![0].headers.get("cookie")).toBeNull();
  expect(
    f.raw.prepare("SELECT COUNT(*) AS count FROM sync_relay_live_session_tickets").get(),
  ).toEqual({ count: 0 });
});

it.each<Record<string, string>>([
  { authorization: "" },
  { authorization: "Bearer reader-token" },
  { authorization: "Bearer owner-phone-token" },
  { origin: "https://foreign.example" },
  { host: "foreign.example" },
])(
  "refuses unauthenticated, non-owner, owner phone and foreign owner upgrades %j",
  async (headers) => {
    const f = await fixture(limits, false, undefined, true);
    expect(await f.connect("", "", headers).status).toBe(404);
    expect(f.captureNative).not.toHaveBeenCalled();
  },
);

it.each(["owner", "fence"])(
  "rechecks owner %s standing after native capture awaits",
  async (changed) => {
    const f = await fixture(limits, false, undefined, true);
    f.captureNative.mockImplementationOnce(async () => {
      f.raw.exec(
        changed === "owner"
          ? "UPDATE sync_relay_workspaces SET owner_user_id='other'"
          : "UPDATE sync_relay_live_documents SET restore_fence_generation=restore_fence_generation+1",
      );
      return f.native;
    });
    expect(await f.connect("").status).toBe(404);
  },
);

it("refuses a native capture for a different owner document", async () => {
  const f = await fixture(limits, false, undefined, true);
  f.captureNative.mockImplementationOnce(async () => ({
    ...f.native,
    binding: { ...f.native.binding, objectId: "other-object" },
  }));
  expect(await f.connect("").status).toBe(404);
  expect(f.native.client.openLiveAppliedSync).not.toHaveBeenCalled();
});

describe("an owner's phone", () => {
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  const phoneFixture = (rooms?: LiveRooms, production = false) => {
    phoneState.expiresAt = 8e12;
    return fixture(
      production ? selfHostLiveProfile().namedLive.transport : limits,
      false,
      undefined,
      true,
      false,
      production ? createLiveConnectionAdmission() : undefined,
      production ? 1 : 0,
      production ? 1 : 0,
      production,
      undefined,
      undefined,
      undefined,
      rooms,
    );
  };
  const mintPhone = async (f: Fixture, changed: Partial<typeof phoneScope> = {}) =>
    (await f.tickets.mint({ objectId: f.binding.objectId }, { ...phoneScope, ...changed }))!;
  // An upgrade with exactly these protocols, which a WebSocket client would refuse to send.
  const upgradeStatus = (f: Fixture, protocols: string) =>
    new Promise<number>((resolve, reject) => {
      const request = httpRequest({
        host: "127.0.0.1",
        port: f.port,
        path: `/sync/workspaces/${f.binding.workspaceId}/live/owner?objectId=${f.binding.objectId}&lineageClaimId=${f.binding.lineageClaimId}`,
        headers: {
          ...phoneHeaders,
          host: relayHost,
          connection: "Upgrade",
          upgrade: "websocket",
          "sec-websocket-version": "13",
          "sec-websocket-key": Buffer.alloc(16, 7).toString("base64"),
          "sec-websocket-protocol": protocols,
        },
      });
      request.once("upgrade", (_response, socket) => {
        socket.destroy();
        resolve(101);
      });
      request.once("response", (response) => {
        response.resume();
        resolve(response.statusCode!);
      });
      request.once("error", reject);
      request.end();
    });
  const openPhone = async (f: Fixture) => {
    const phone = f.connect((await mintPhone(f)).token, "", phoneHeaders);
    const desktop = f.connect("");
    expect([await phone.status, await desktop.status]).toEqual([101, 101]);
    return { phone, desktop };
  };
  // Pings the server until the phone's socket closes, then reports the close.
  const closesWhileSending = async (phone: { ws: WebSocket }, invalidate: () => void) => {
    const closed = once(phone.ws, "close");
    const traffic = setInterval(() => {
      if (phone.ws.readyState === WebSocket.OPEN) phone.ws.ping();
    }, 5);
    try {
      invalidate();
      await closed;
    } finally {
      clearInterval(traffic);
    }
  };

  it("keeps an idle phone open past idleTimeoutMs while it answers pings, and closes one whose pongs stop", async () => {
    const routeLimits = { ...limits, idleTimeoutMs: 600 };
    const f = await fixture(routeLimits, false, undefined, true);
    const phone = f.connect((await mintPhone(f)).token, "", phoneHeaders);
    expect(await phone.status).toBe(101);
    expect(await waitForPings(phone.ws, 5)).toBe(5);
    expect(phone.ws.readyState).toBe(WebSocket.OPEN);
    const silent = f.connect((await mintPhone(f)).token, "", phoneHeaders, "", undefined, false);
    expect(await silent.status).toBe(101);
    const opened = performance.now();
    const spoof = setInterval(() => {
      if (silent.ws.readyState === WebSocket.OPEN) silent.ws.pong(Buffer.alloc(8, 7));
    }, 100);
    try {
      await silent.closed;
    } finally {
      clearInterval(spoof);
    }
    expect(performance.now() - opened).toBeLessThan(2 * routeLimits.idleTimeoutMs);
    expect(phone.ws.readyState).toBe(WebSocket.OPEN);
  });

  it("opens once per ticket, selects only the live protocol, and keeps its own capture with owner rooms on", async () => {
    const join = vi.fn((captured: NamedFrameRoomHost) => captured);
    const f = await phoneFixture({ join } as unknown as LiveRooms);
    const { token } = await mintPhone(f);
    const phone = f.connect(token, "", phoneHeaders);
    expect(await phone.status).toBe(101);
    expect(phone.ws.protocol).toBe("dohc-live-v1");
    await phone.until(() => phone.received.some((frame) => frame.kind === "welcome"));
    expect(f.readSessions).toHaveBeenCalledWith(["phone-session"]);
    expect(join).not.toHaveBeenCalled();
    expect(await f.connect(token, "", phoneHeaders).status).toBe(404);
    expect(await f.connect("").status).toBe(101);
    expect(join).toHaveBeenCalledOnce();
  });

  it.each([
    ["a ticket for another sign-in", { sessionId: "other-session" }, phoneHeaders],
    ["an expired ticket", {}, phoneHeaders],
    ["a desktop that sends a ticket", {}, {}],
  ] as const)("refuses %s", async (name, changed, headers) => {
    const f = await phoneFixture();
    const { token } = await mintPhone(f, changed);
    if (name === "an expired ticket") f.setTime(31_000);
    expect(await f.connect(token, "", headers).status).toBe(404);
    expect(f.native.client.openLiveAppliedSync).not.toHaveBeenCalled();
  });

  it("refuses every other protocol offer without spending its ticket, and never logs one", async () => {
    const f = await phoneFixture();
    const { token } = await mintPhone(f);
    const ticket = `dohc-live-ticket.${token}`;
    const logs = (["log", "info", "warn", "error", "debug"] as const).map((level) =>
      vi.spyOn(console, level),
    );
    for (const offer of [
      "dohc-live-v1",
      `dohc-live-v1, dohc-live-v1, ${ticket}`,
      `dohc-live-v1, ${ticket}, ${ticket}`,
      `dohc-live-v1, ${ticket}, chat`,
      `dohc-live-v1, ${ticket},`,
      ticket,
      `dohc-live-v1, dohc-live-ticket.${token.toUpperCase()}`,
    ])
      expect(await upgradeStatus(f, offer), offer).toBe(404);
    expect(await upgradeStatus(f, `${ticket}, dohc-live-v1`)).toBe(101);
    expect(JSON.stringify(logs.flatMap((log) => log.mock.calls))).not.toContain(token);
  });

  it.each(["a revoke", "Show on phone turned off", "Show on phone off at a check", "a fence"])(
    "closes at %s while frames flow, and leaves the host",
    async (invalidation) => {
      const f = await phoneFixture();
      const { phone, desktop } = await openPhone(f);
      await closesWhileSending(phone, () => {
        if (invalidation === "a revoke") f.routes.stopSession("owner-1", "phone-session");
        else if (invalidation === "a fence") f.routes.deleteAccount("owner-1", []);
        else if (invalidation === "Show on phone turned off")
          f.routes.stopPhoneWorkspace("owner-1", f.binding.workspaceId);
        else {
          f.storage.setShowOnPhone({
            userId: "owner-1",
            workspaceId: f.binding.workspaceId,
            showOnPhone: false,
          });
          f.changes.notifyWrite();
        }
      });
      expect(f.native.invalidated.aborted).toBe(false);
      if (invalidation !== "a fence") expect(desktop.ws.readyState).toBe(WebSocket.OPEN);
    },
  );

  it("closes when its sign-in expires, and not before", async () => {
    const f = await phoneFixture();
    // The clock stands still while both sockets open, so admission never races the expiry.
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    try {
      phoneState.expiresAt = Date.now() + 5_000;
      const { phone, desktop } = await openPhone(f);
      const closed = new Promise<void>((resolve) => phone.ws.once("close", () => resolve()));
      await vi.advanceTimersByTimeAsync(4_999);
      expect(phone.ws.readyState).toBe(WebSocket.OPEN);
      await vi.advanceTimersByTimeAsync(1);
      await closed;
      expect(desktop.ws.readyState).toBe(WebSocket.OPEN);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["deleted", "unreadable", "standing"])(
    "reads its sign-in again each minute and closes when it is %s",
    async (state) => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      try {
        const f = await phoneFixture();
        const { phone, desktop } = await openPhone(f);
        f.readSessions.mockClear();
        if (state === "deleted") f.sessionRows.delete("phone-session");
        if (state === "unreadable") f.readSessions.mockRejectedValueOnce(new Error("unreadable"));
        const closed = new Promise<void>((resolve) => phone.ws.once("close", () => resolve()));
        await vi.advanceTimersByTimeAsync(OWNER_SESSION_CHECK_MS);
        expect(f.readSessions).toHaveBeenCalledOnce();
        expect(f.readSessions).toHaveBeenCalledWith(["phone-session"]);
        if (state === "standing") expect(phone.ws.readyState).toBe(WebSocket.OPEN);
        else await closed;
        expect(desktop.ws.readyState).toBe(WebSocket.OPEN);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each([false, true])(
    "commits an edit past its last check before a revoke without answering it; past=%s",
    async (past) => {
      const f = await phoneFixture(undefined, true);
      const phone = f.connect((await mintPhone(f)).token, "", phoneHeaders);
      expect(await phone.status).toBe(101);
      await openProductionSync(f, phone);
      const updateBytes = Uint8Array.of(0, 0),
        draining = deferred<void>(),
        drained = deferred<void>();
      const revoke = () => f.routes.stopSession("owner-1", "phone-session");
      vi.spyOn(f.storage, "readLiveUpdateJournalCut").mockImplementation(() => {
        if (!past) revoke();
        const cut = { checkpoint: { bytes: Uint8Array.of(0, 0) }, suffix: [] };
        return { kind: "cut", cut: cut as unknown as LiveUpdateJournalCut };
      });
      const commit = vi.spyOn(f.storage, "commitLiveUpdateJournal").mockReturnValue({
        result: {
          kind: "accepted",
          receipt: {
            deliveryId: "edit",
            updateDigest: createHash("sha256").update(updateBytes).digest("hex"),
            journalCursor: 1,
            acceptingHostEpoch: host.hostEpoch,
          },
        },
      } as never);
      vi.mocked(f.native.drain).mockImplementation(async () => {
        draining.resolve();
        await drained.promise;
      });
      const closed = once(phone.ws, "close");
      submitUpdate(f, phone, "edit", 2);
      if (past) {
        await draining.promise;
        revoke();
      }
      drained.resolve();
      await closed;
      expect(commit).toHaveBeenCalledTimes(past ? 1 : 0);
      expect(phone.received.filter((frame) => frame.kind === "result")).toEqual([]);
    },
  );

  describe("and browser", () => {
    const mintBrowser = (f: Fixture, changed: Partial<typeof browserScope> = {}) =>
      mintPhone(f, { ...browserScope, ...changed });
    const openBrowser = async (f: Fixture) => {
      const browser = f.connect((await mintBrowser(f)).token, "", browserHeaders);
      const desktop = f.connect("");
      expect([await browser.status, await desktop.status]).toEqual([101, 101]);
      return { browser, desktop };
    };

    it("opens once per ticket that share-web forwards, on its own capture, reading its sign-in uncached", async () => {
      const join = vi.fn((captured: NamedFrameRoomHost) => captured);
      const f = await phoneFixture({ join } as unknown as LiveRooms);
      const { token } = await mintBrowser(f);
      const browser = f.connect(token, "", browserHeaders);
      expect(await browser.status).toBe(101);
      expect(browser.ws.protocol).toBe("dohc-live-v1");
      await browser.until(() => browser.received.some((frame) => frame.kind === "welcome"));
      expect(f.readSessions).toHaveBeenCalledWith(["browser-session"]);
      expect(join).not.toHaveBeenCalled();
      expect(await f.connect(token, "", browserHeaders).status).toBe(404);
    });

    const { cookie, origin } = browserHeaders;
    const key = browserHeaders["x-dohc-relay-exchange-key"];
    it.each<[string, Partial<typeof browserScope>, Record<string, string>]>([
      ["another account", {}, { ...browserHeaders, cookie: "account=browser:owner-2" }],
      ["a member", {}, { ...browserHeaders, cookie: `account=browser:${scope.userId}` }],
      ["a desktop's sign-in", {}, { ...browserHeaders, cookie: "account=reader" }],
      ["no cookie", {}, { origin, "x-dohc-relay-exchange-key": key }],
      ["another origin", {}, { ...browserHeaders, origin: "https://foreign.example" }],
      ["no origin", {}, { cookie, "x-dohc-relay-exchange-key": key }],
      [
        "a wrong exchange key",
        {},
        { ...browserHeaders, "x-dohc-relay-exchange-key": "x".repeat(54) },
      ],
      ["a ticket for the phone's sign-in", { sessionId: "phone-session" }, browserHeaders],
      [
        "a Bearer beside the cookie",
        {},
        { ...browserHeaders, authorization: "Bearer owner-token" },
      ],
    ])(
      "refuses %s as a missing workspace, and spends no ticket",
      async (_name, changed, headers) => {
        const f = await phoneFixture();
        const { token } = await mintBrowser(f, changed);
        expect(await f.connect(token, "", headers).status).toBe(404);
        expect(f.native.client.openLiveAppliedSync).not.toHaveBeenCalled();
        if (Object.keys(changed).length === 0)
          expect(await f.connect(token, "", browserHeaders).status).toBe(101);
      },
    );

    it("refuses a browser with no ticket, and a fenced owner", async () => {
      const f = await phoneFixture();
      expect(await f.connect("", "", browserHeaders).status).toBe(404);
      const { token } = await mintBrowser(f);
      const context = f.storage as StorageContext;
      initializeAccountDeletion(context, "deletion-key");
      fenceAccount(context, "deletion-key", "owner-1", "owner-1@dohc.test");
      expect(await f.connect(token, "", browserHeaders).status).toBe(404);
      expect(f.native.client.openLiveAppliedSync).not.toHaveBeenCalled();
    });

    it.each(["a revoke", "a fence"])(
      "closes at %s while frames flow, and leaves the host",
      async (invalidation) => {
        const f = await phoneFixture();
        const { browser, desktop } = await openBrowser(f);
        await closesWhileSending(browser, () => {
          if (invalidation === "a revoke") f.routes.stopSession("owner-1", "browser-session");
          else f.routes.deleteAccount("owner-1", []);
        });
        expect(f.native.invalidated.aborted).toBe(false);
        if (invalidation !== "a fence") expect(desktop.ws.readyState).toBe(WebSocket.OPEN);
      },
    );

    it("stays open when Show on phone turns off", async () => {
      const f = await phoneFixture();
      const { browser } = await openBrowser(f);
      f.routes.stopPhoneWorkspace("owner-1", f.binding.workspaceId);
      f.storage.setShowOnPhone({
        userId: "owner-1",
        workspaceId: f.binding.workspaceId,
        showOnPhone: false,
      });
      f.changes.notifyWrite();
      // A ping answered after the change shows the socket outlived it.
      browser.ws.ping();
      await once(browser.ws, "pong");
      expect(browser.ws.readyState).toBe(WebSocket.OPEN);
    });

    it.each(["signed out", "standing"])(
      "reads its sign-in again each minute and closes when it is %s",
      async (state) => {
        vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
        try {
          const f = await phoneFixture();
          const { browser, desktop } = await openBrowser(f);
          f.readSessions.mockClear();
          // share-web's sign-out deletes the session's row.
          if (state === "signed out") f.sessionRows.delete("browser-session");
          const closed = new Promise<void>((resolve) => browser.ws.once("close", () => resolve()));
          await vi.advanceTimersByTimeAsync(OWNER_SESSION_CHECK_MS);
          expect(f.readSessions).toHaveBeenCalledWith(["browser-session"]);
          if (state === "standing") expect(browser.ws.readyState).toBe(WebSocket.OPEN);
          else await closed;
          expect(desktop.ws.readyState).toBe(WebSocket.OPEN);
        } finally {
          vi.useRealTimers();
        }
      },
    );

    it("stays open while share-web's gateway pings it, and closes once the pings stop", async () => {
      phoneState.expiresAt = 8e12;
      const routeLimits = { ...limits, idleTimeoutMs: 1000 };
      const f = await fixture(routeLimits, false, undefined, true);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const browser = f.connect((await mintBrowser(f)).token, "", browserHeaders);
        expect(await browser.status).toBe(101);
        await browser.until(() => browser.received.some((frame) => frame.kind === "welcome"));
        for (let elapsed = 0; elapsed < 3 * routeLimits.idleTimeoutMs; elapsed += 200) {
          expect(await pingOutcome(browser)).toBe("pong");
          await vi.advanceTimersByTimeAsync(200);
        }
        expect(browser.ws.readyState).toBe(WebSocket.OPEN);
        await vi.advanceTimersByTimeAsync(routeLimits.idleTimeoutMs);
        await browser.closed;
      } finally {
        vi.useRealTimers();
      }
    });

    // The note's room, as production runs it, beside the owner's desktop and browser.
    const roomFixture = async () => {
      let rooms: LiveRooms | undefined;
      const f = await phoneFixture(
        {
          join: (captured: NamedFrameRoomHost, options?: { owner?: boolean }) =>
            rooms!.join(captured, options),
        } as unknown as LiveRooms,
        true,
      );
      rooms = createLiveRooms({
        storage: f.storage,
        maxUpdateBytes: 1 << 20,
        maxNoteBytes: 1 << 22,
        maxAppliedBytes: 1 << 20,
        saveEveryMs: 3_600_000,
        log() {},
        openSaver: async () =>
          captureOwnerLiveFrameHost({
            authenticatedUserId: "owner-1",
            storage: f.storage,
            native: f.native,
            bounds: selfHostLiveProfile().namedLive.host,
            validate: ({ retainStateUpdate: _retainStateUpdate, ...input }) =>
              createLiveMarkdownJournalValidator(policy)(input),
          }),
      });
      cleanups.push(async () => rooms!.close());
      const browser = f.connect((await mintBrowser(f)).token, "", browserHeaders);
      expect(await browser.status).toBe(101);
      await openProductionSync(f, browser);
      return { f, browser };
    };
    const paragraph = (text: string) => {
      const doc = new Y.Doc(),
        line = new Y.XmlElement("paragraph");
      line.insert(0, [new Y.XmlText(text)]);
      doc.getXmlFragment("body").insert(0, [line]);
      return Y.encodeStateAsUpdate(doc);
    };
    const submit = (
      f: Fixture,
      socket: ReturnType<Fixture["connect"]>,
      updateBytes: Uint8Array,
      authorContext?: LiveAuthorContext,
    ) => {
      const encode = (frame: LiveFrame) => encodeLiveFrame(frame, f.frames.receive.maxFrameBytes);
      socket.ws.send(
        encode({
          kind: "begin",
          purpose: "submit-update",
          deliveryId: "edit",
          transferId: 2,
          totalBytes: updateBytes.length,
          digest: createHash("sha256").update(updateBytes).digest("hex"),
          ...(authorContext ? { authorContext } : {}),
        }),
      );
      socket.ws.send(encode({ kind: "chunk", transferId: 2, offset: 0, bytes: updateBytes }));
    };

    it("stays on its own capture with the note's room on, so another editor's unsaved edit never reaches it as a room row", async () => {
      const { f, browser } = await roomFixture();
      const desktop = f.connect("");
      expect(await desktop.status).toBe(101);
      await openProductionSync(f, desktop);
      submit(f, desktop, paragraph("From the desktop"));
      await desktop.until(() => desktop.received.some((frame) => frame.kind === "result"));
      expect(desktop.received.find((frame) => frame.kind === "result")).toMatchObject({
        result: "success",
      });
      // A ping answered after the desktop's edit was taken shows the browser had its chance to hear of it.
      browser.ws.ping();
      await once(browser.ws, "pong");
      expect(
        browser.received.filter((frame) => frame.kind === "begin" && frame.purpose === "room-row"),
      ).toEqual([]);
    });

    it("refuses an edit from the browser that names an agent, with the note's room on", async () => {
      const { f, browser } = await roomFixture();
      submit(f, browser, paragraph("Written by a helper"), {
        kind: "account",
        accountId: "owner-1",
        agent: { agentId: "helper", agentName: "Helper", depth: 0 },
      });
      await browser.until(() => browser.received.some((frame) => frame.kind === "result"));
      expect(browser.received.find((frame) => frame.kind === "result")).toMatchObject({
        result: "refused",
        reason: "provenance-refused",
      });
    });
  });
});

it.each([
  ["named", false, "docs/a.md", ["docs/a.md"]],
  ["link", true, "a.md", ["a.md"]],
] as const)(
  "closes a %s connection when its folder share narrows to the file, and reopening shows the new view",
  async (_kind, link, currentPath, selectorPaths) => {
    const f = await fixture(limits, link);
    f.raw
      .prepare("UPDATE sync_relay_shares SET selector_json=?")
      .run(JSON.stringify({ paths: ["docs"], versionId: null }));
    const first = f.connect((await f.mint()).token);
    expect(await first.status).toBe(101);
    const opened = await startProvider(first);
    await opened.until(() => opened.provider.state().status === "live");
    expect(opened.provider.state().binding).toMatchObject({
      currentPath: "docs/a.md",
      selectorPaths: ["docs"],
    });
    const closed = once(first.ws, "close");
    f.raw
      .prepare("UPDATE sync_relay_shares SET selector_json=?")
      .run(JSON.stringify({ paths: [binding.currentPath], versionId: null }));
    f.changes.notifyWrite();
    await closed;
    expect(f.native.invalidated.aborted).toBe(false);
    const second = f.connect((await f.mint()).token);
    expect(await second.status).toBe(101);
    const reopened = await startProvider(second);
    await reopened.until(() => reopened.provider.state().status === "live");
    expect(reopened.provider.state().binding).toMatchObject({
      currentPath,
      selectorPaths,
      objectId: binding.objectId,
    });
  },
);
it.each(["named", "link", "owner", "desktop"])(
  "deletion closes a running %s live connection",
  async (kind) => {
    const f = await fixture(
      limits,
      kind === "link",
      undefined,
      kind === "owner",
      kind === "desktop",
    );
    const minted = kind === "owner" ? { token: "" } : await f.mint();
    const connection = f.connect(minted.token);
    expect(await connection.status).toBe(101);
    const closed = once(connection.ws, "close");
    f.routes.deleteAccount("owner-1", [binding.workspaceId]);
    await closed;
    expect(connection.ws.readyState).toBe(WebSocket.CLOSED);
  },
);

it.each([
  ["maxConnections", "live_total_limit"],
  ["maxConnectionsPerWorkspace", "live_workspace_limit"],
  ["maxConnectionsPerGrant", "live_grant_limit"],
  ["maxConnectionsPerPrincipal", "live_person_limit"],
  ["maxConnectionsPerSession", "live_session_limit"],
] as const)(
  "names %s only after authenticating and redeeming an in-scope ticket",
  async (limit, code) => {
    const f = await fixture({ ...limits, [limit]: 1 });
    const first = f.connect((await f.mint()).token);
    expect(await first.status).toBe(101);
    const ticket = await f.mint();
    expect(await f.connect(ticket.token, "account=other").status).toBe(404);
    const refused = f.connect(ticket.token);
    expect(await refused.status).toBe(101);
    expect(await refused.closed).toEqual([LIVE_CONNECTION_LIMIT_CLOSE_CODE, code]);
    expect(f.captureNative).toHaveBeenCalledTimes(5);
  },
);

it("refuses aggregate frame pressure and releases it on close", async () => {
  const admission = createLiveConnectionAdmission();
  const f = await fixture(
    {
      ...limits,
      maxBufferedBytes: 10_000,
      maxBufferedBytesPerPrincipal: 3750,
      maxBufferedBytesPerShare: 5000,
      maxBufferedBytesPerWorkspace: 10_000,
    },
    false,
    undefined,
    false,
    false,
    admission,
  );
  const socket = f.connect((await f.mint()).token);
  expect(await socket.status).toBe(101);
  await socket.until(() => socket.received.some((frame) => frame.kind === "credit"));
  const buffers = admission.buffers(10_000),
    release = buffers.reserve(9_990);
  const protocol = createLiveFrameSession("client", frames);
  for (const frame of socket.received)
    protocol
      .receive(
        (await import("@dohc/live-session-contract/live-frame")).encodeLiveFrame(
          frame,
          frames.receive.maxFrameBytes,
        ),
      )
      .release();
  const hello = protocol.send({ kind: "hello", receivePolicy: frames.receive });
  socket.ws.send(hello.value);
  hello.release();
  expect(await socket.closed).toEqual([LIVE_CONNECTION_LIMIT_CLOSE_CODE, "live_buffer_limit"]);
  release();
  await vi.waitFor(() => expect(buffers.usage()).toBe(0));
  protocol.close();
});

it("charges WebSocket sends until their callback settles", async () => {
  const admission = createLiveConnectionAdmission(),
    f = await fixture(limits, false, undefined, false, false, admission);
  const ticket = await f.mint(),
    sent = deferred<void>();
  let callback: (() => void) | undefined,
    heldBytes = 0;
  const original = WebSocket.prototype.send;
  vi.spyOn(WebSocket.prototype, "send").mockImplementation(function (
    this: WebSocket,
    ...args: Parameters<WebSocket["send"]>
  ) {
    if (this.url === undefined) {
      const bytes = args[0];
      if (bytes instanceof Uint8Array) heldBytes = bytes.byteLength;
      const completed = args.at(-1);
      callback = () => {
        if (typeof completed === "function") completed();
      };
      sent.resolve();
      return;
    }
    original.apply(this, args);
  });
  const socket = f.connect(ticket.token);
  expect(await socket.status).toBe(101);
  await sent.promise;
  const buffers = admission.buffers(limits.maxBufferedBytes);
  try {
    expect(buffers.usage()).toBe(2 * heldBytes);
    socket.ws.terminate();
    await socket.closed;
    expect(buffers.usage()).toBe(2 * heldBytes);
  } finally {
    f.routes.close();
    callback?.();
  }
  await vi.waitFor(() => expect(buffers.usage()).toBe(0));
});

type ProductionPeer = {
  f: Awaited<ReturnType<typeof fixture>>;
  socket: ReturnType<Awaited<ReturnType<typeof fixture>>["connect"]>;
};

it.each([false, true])(
  "delivers one production-size 2 MiB edit to 22 readers of one document; link=%s",
  async (link) => {
    const profile = selfHostLiveProfile(),
      admission = createLiveConnectionAdmission();
    const readers: ProductionPeer[] = [];
    const sharedChanges = createNamedFrameChanges(128);
    let shared: NamedFrameNativeHost | undefined;
    for (let person = 1; person <= 22; person++) {
      const f = await fixture(
        profile.namedLive.transport,
        link,
        undefined,
        false,
        false,
        admission,
        person,
        1,
        true,
      );
      if (!shared) shared = { ...f.native, changes: sharedChanges };
      const native = shared;
      f.captureNative.mockImplementation(async () => native);
      const socket = f.connect((await f.mint()).token);
      expect(await socket.status).toBe(101);
      await openProductionSync(f, socket);
      readers.push({ f, socket });
    }
    const updateBytes = Buffer.alloc(profile.namedLive.host.maxAppliedUpdateBytes, 42);
    vi.mocked(shared!.client.readNextLiveApplied).mockImplementation(async (_request, after) =>
      after.eventCount
        ? null
        : {
            position: { eventCount: 1, journalCursor: 1, evidenceDigest: "cd".repeat(32) },
            updateBytes,
            ack: {
              deliveryId: "edit",
              updateDigest: createHash("sha256").update(updateBytes).digest("hex"),
              journalCursor: 1,
              acceptingHostEpoch: host.hostEpoch,
              localYDocSequence: 1,
              applicationReplayed: false,
            },
          },
    );
    await vi.waitFor(() => expect(sharedChanges.listenerCount()).toBe(44));
    sharedChanges.notify(readers[0]!.f.binding);
    await vi.waitFor(
      () => {
        expect(readers.map(({ socket }) => socket.ws.readyState)).toEqual(
          Array(22).fill(WebSocket.OPEN),
        );
        expect(
          readers.map(({ socket }) =>
            socket.received
              .filter((frame) => frame.kind === "chunk" && frame.transferId === 2)
              .reduce((sum, frame) => sum + (frame.kind === "chunk" ? frame.bytes.length : 0), 0),
          ),
        ).toEqual(Array(22).fill(updateBytes.length));
      },
      { timeout: 10_000 },
    );
    for (const { socket } of readers) {
      const chunks = socket.received.filter(
        (frame): frame is Extract<LiveFrame, { kind: "chunk" }> =>
          frame.kind === "chunk" && frame.transferId === 2,
      );
      expect(
        Buffer.concat(chunks.map((frame) => Buffer.from(frame.bytes))).equals(updateBytes),
      ).toBe(true);
    }
    expect(readers.every(({ socket }) => socket.ws.readyState === WebSocket.OPEN)).toBe(true);
    await vi.waitFor(() =>
      expect(admission.buffers(profile.namedLive.transport.maxBufferedBytes).usage()).toBe(0),
    );
  },
  60_000,
);

function submitUpdate(
  f: Awaited<ReturnType<typeof fixture>>,
  socket: ReturnType<Awaited<ReturnType<typeof fixture>>["connect"]>,
  deliveryId: string,
  transferId: number,
) {
  const updateBytes = Uint8Array.of(0, 0);
  socket.ws.send(
    encodeLiveFrame(
      {
        kind: "begin",
        purpose: "submit-update",
        deliveryId,
        transferId,
        totalBytes: updateBytes.length,
        digest: createHash("sha256").update(updateBytes).digest("hex"),
      },
      f.frames.receive.maxFrameBytes,
    ),
  );
  socket.ws.send(
    encodeLiveFrame(
      { kind: "chunk", transferId, offset: 0, bytes: updateBytes },
      f.frames.receive.maxFrameBytes,
    ),
  );
}

it("keeps another workspace's 4 MiB sync open while a nearly full workspace checks a large edit", async () => {
  const profile = selfHostLiveProfile(),
    limits = profile.namedLive.transport,
    admission = createLiveConnectionAdmission(),
    MiB = 1024 * 1024;
  const frameBudget = admission.buffers(limits.maxBufferedBytes),
    validationBudget = admission.validationBuffers(limits.maxBufferedBytes);
  const editor = await fixture(limits, true, undefined, false, false, admission, 1, 1, true);
  const editing = editor.connect((await editor.mint()).token);
  expect(await editing.status).toBe(101);
  await openProductionSync(editor, editing);
  const releaseFrames = frameBudget.reserve(76 * MiB, [
    [JSON.stringify(["workspace", scope.workspaceId]), 80 * MiB],
  ]);
  const checking = deferred<void>(),
    drained = deferred<void>(),
    updateBytes = Uint8Array.of(0, 0);
  vi.spyOn(editor.storage, "readLiveUpdateJournalCut").mockImplementation((_input, reserve) => {
    reserve!(50 * MiB);
    return {
      kind: "cut",
      cut: {
        checkpoint: { bytes: Uint8Array.of(0, 0) },
        suffix: [],
      } as unknown as LiveUpdateJournalCut,
    };
  });
  vi.spyOn(editor.storage, "commitLiveUpdateJournal").mockReturnValue({
    result: {
      kind: "accepted",
      receipt: {
        deliveryId: "large-edit",
        updateDigest: createHash("sha256").update(updateBytes).digest("hex"),
        journalCursor: 1,
        acceptingHostEpoch: host.hostEpoch,
      },
    },
  } as never);
  vi.mocked(editor.native.drain).mockImplementation(async () => {
    checking.resolve();
    await drained.promise;
  });
  try {
    submitUpdate(editor, editing, "large-edit", 2);
    await checking.promise;
    expect(frameBudget.usage() + validationBudget.usage()).toBeGreaterThanOrEqual(126 * MiB);
    const other = await fixture(
      limits,
      true,
      undefined,
      false,
      false,
      admission,
      2,
      1,
      true,
      "other-workspace",
    );
    vi.mocked(other.native.client.openLiveAppliedSync).mockResolvedValue({
      binding: { ...other.binding, selectorPaths: [other.binding.currentPath] },
      hostVector: Buffer.from([0]),
      missingStateUpdate: Buffer.alloc(4 * MiB - 1024),
      observedLocalYDocHeadSequence: 1,
      position: { eventCount: 0, journalCursor: 0, evidenceDigest: "ab".repeat(32) },
    });
    const reader = other.connect((await other.mint()).token);
    expect(await reader.status).toBe(101);
    const before = frameBudget.usage();
    await openProductionSync(other, reader, false);
    await vi.waitFor(() =>
      expect(
        reader.ws.readyState === WebSocket.CLOSED || frameBudget.usage() > before + 4 * MiB - 2048,
      ).toBe(true),
    );
    expect(reader.ws.readyState).toBe(WebSocket.OPEN);
    const pong = once(reader.ws, "pong");
    reader.ws.ping("still-live");
    await pong;
    expect(reader.ws.readyState).toBe(WebSocket.OPEN);
    expect(editing.ws.readyState).toBe(WebSocket.OPEN);
    expect(validationBudget.usage()).toBeGreaterThanOrEqual(50 * MiB);
  } finally {
    drained.resolve();
    releaseFrames();
  }
  await vi.waitFor(() =>
    expect(editing.received).toContainEqual(
      expect.objectContaining({
        kind: "result",
        deliveryId: "large-edit",
        result: "retry",
        reason: "application-pending",
      }),
    ),
  );
  await vi.waitFor(() => expect(validationBudget.usage()).toBe(0));
}, 60_000);

it.each(["named", "owner", "link"])(
  "finally refuses a %s edit whose check can never fit the validation pool",
  async (kind) => {
    const profile = selfHostLiveProfile(),
      admission = createLiveConnectionAdmission(),
      limits = profile.namedLive.transport;
    const f = await fixture(
      limits,
      kind === "link",
      undefined,
      kind === "owner",
      false,
      admission,
      1,
      1,
      true,
    );
    const socket = f.connect(kind === "owner" ? "" : (await f.mint()).token);
    expect(await socket.status).toBe(101);
    await openProductionSync(f, socket);
    const read = vi
      .spyOn(f.storage, "readLiveUpdateJournalCut")
      .mockImplementation((_input, reserve) => {
        reserve!(limits.maxBufferedBytes - 6 + 1);
        throw new Error("The cut is read only after its check is reserved.");
      });
    submitUpdate(f, socket, "oversized", 2);
    await vi.waitFor(() =>
      expect(socket.received).toContainEqual(
        expect.objectContaining({
          kind: "result",
          deliveryId: "oversized",
          result: "refused",
          reason: "capacity-refused",
        }),
      ),
    );
    expect(read).toHaveBeenCalledOnce();
    expect(admission.validationBuffers(limits.maxBufferedBytes).usage()).toBe(0);
  },
);

it("names the limit and the size in the server log when a note is too large for a page's sync", async () => {
  const f = await fixture(
    selfHostLiveProfile().namedLive.transport,
    true,
    undefined,
    false,
    false,
    createLiveConnectionAdmission(),
    1,
    1,
    true,
  );
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(f.native.client.openLiveAppliedSync).mockResolvedValue({
    binding: { ...f.binding, selectorPaths: [f.binding.currentPath] },
    hostVector: Buffer.from([0]),
    missingStateUpdate: Buffer.alloc(2000),
    observedLocalYDocHeadSequence: 1,
    position: { eventCount: 0, journalCursor: 0, evidenceDigest: "ab".repeat(32) },
  });
  const socket = f.connect((await f.mint()).token);
  expect(await socket.status).toBe(101);
  await openProductionSync(f, socket, false, { ...f.frames.receive, maxSyncBytes: 1024 });
  await vi.waitFor(() => expect(socket.ws.readyState).toBe(WebSocket.CLOSED));
  expect(logged.mock.calls.map(([line]) => String(line))).toContainEqual(
    expect.stringMatching(
      /^\[sync-relay\] live frame refused: maxSyncBytes is 1024 bytes, the frame needed \d{4} bytes$/,
    ),
  );
});

it("returns only the named grant binding in live frames", async () => {
  const f = await fixture();
  const minted = await f.mint(),
    socket = f.connect(minted.token);
  expect(await socket.status).toBe(101);
  const { provider, until } = await startProvider(socket);
  await until(() => provider.state().status === "live");
  expect(provider.state().binding).toMatchObject({
    ...binding,
    workspaceId: `named:${scope.grantId}`,
    selectorPaths: ["docs"],
  });
  expect(JSON.stringify(provider.state().binding)).not.toContain(scope.workspaceId);
  expect(f.native.binding.workspaceId).toBe(scope.workspaceId);
});
it.each(["view", "comment"] as const)(
  "keeps %s recipients out of desktop admission and named live frames",
  async (access) => {
    const f = await fixture(limits, false, undefined, false, true),
      minted = await f.mint();
    f.raw.prepare("UPDATE sync_relay_share_grants SET access=?").run(access);
    const response = await f.post("/sync/live/desktop-open", {
      shareId: scope.shareId,
      path: binding.currentPath,
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ ok: false });
    expect(await f.connect(minted.token).status).not.toBe(101);
    expect(f.native.client.openLiveAppliedSync).not.toHaveBeenCalled();
  },
);

it("keeps one account's new browser sessions coming and still gives another account its session", async () => {
  const f = await fixture(
    limits,
    false,
    undefined,
    false,
    false,
    undefined,
    0,
    0,
    false,
    undefined,
    undefined,
    { people: 2, documents: 1 },
  );
  // One more than the whole store holds.
  for (let index = 0; index <= selfHostLiveProfile().browserSessions.maxSessions; index++) {
    const response = await f.post(
      "/sync/live/named-sessions",
      { grantId: "edit-1" },
      "account=reader-1",
    );
    expect(response.status).toBe(200);
  }
  const other = await f.post(
    "/sync/live/named-sessions",
    { grantId: "edit-2" },
    "account=reader-2",
  );
  expect(other.status).toBe(200);
});

describe("a desktop's session", () => {
  const opening = async () => {
    // The desktop's store reads the clock it was given when it was made.
    const clock = { now: Date.now() };
    vi.spyOn(Date, "now").mockImplementation(() => clock.now);
    const f = await fixture(limits, false, undefined, false, true);
    // Each open also mints a ticket; these tests count only sessions.
    vi.spyOn(f.tickets, "mint").mockResolvedValue({
      token: "ticket",
      expiresAtMs: Date.now() + 60_000,
    });
    const open = async (shareId = scope.shareId, path = binding.currentPath) => {
      const response = await f.post("/sync/live/desktop-open", { shareId, path });
      expect(response.status).toBe(200);
      return ((await response.json()) as { discriminator: string }).discriminator;
    };
    const resolve = (discriminator: string) =>
      f.desktopAdmission!.resolve(
        new Request(`https://${relayHost}/sync/live/desktop`, {
          headers: { authorization: "Bearer reader-token" },
        }),
        discriminator,
      );
    return { f, open, resolve, clock };
  };

  it("ends once its socket opens", async () => {
    const { open, resolve } = await opening();
    const opened: string[] = [];
    for (let index = 0; index < 3; index++) opened.push(await open());
    for (const discriminator of opened)
      expect(await resolve(discriminator)).toMatchObject({ kind: "named", userId: scope.userId });
    for (const discriminator of opened) expect(await resolve(discriminator)).toBeNull();
  });

  // A desktop asks again before every connect, so its notes that keep failing to connect
  // leave sessions behind until their tickets expire. They must not cost a slow connect its own.
  it("keeps a slow connect's session while the same account's other notes retry", async () => {
    const { f, open, resolve, clock } = await opening();
    f.storage.createShare({
      share: {
        shareId: "desktop-second-share",
        workspaceId: scope.workspaceId,
        granterUserId: "owner-1",
        selectorJson: JSON.stringify({ paths: ["docs"], versionId: null }),
        createdAtMs: 1,
      },
      grant: {
        grantId: "desktop-second-grant",
        shareId: "desktop-second-share",
        principalKind: "user",
        principalUserId: scope.userId,
        principalEmail: null,
        access: "edit",
        generation: 1,
        status: "active",
        revokedAtMs: null,
        createdAtMs: 1,
        parentGrantId: null,
      },
    });
    const notes = Array.from({ length: 4 }, (_, index) => ({
      shareId: index % 2 ? "desktop-second-share" : scope.shareId,
      path: `docs/note-${index}.md`,
    }));
    notes.forEach(({ path }, index) =>
      f.raw
        .prepare(
          `INSERT INTO sync_relay_object_moments (workspace_id, object_id, relay_seq, moment_id, version_id, path, blob_sha256, content_kind, byte_length, recorded_at_ms)
          VALUES (?, ?, ?, ?, 'main', ?, ?, 'text', 1, 1)`,
        )
        .run(
          scope.workspaceId,
          `note-${index}`,
          100 + index,
          `note-moment-${index}`,
          path,
          "b".repeat(64),
        ),
    );
    const slow = await open(notes[0]!.shareId, notes[0]!.path);
    const retries: string[] = [];
    for (let attempt = 0; attempt < 18; attempt++) {
      const note = notes[1 + (attempt % 3)]!;
      retries.push(await open(note.shareId, note.path));
    }
    expect(await resolve(slow)).toMatchObject({ kind: "named", userId: scope.userId });
    clock.now += LIVE_TICKET_LIFETIME_MS;
    for (const discriminator of retries) expect(await resolve(discriminator)).toBeNull();
  });

  it("lasts no longer than its ticket", async () => {
    const { open, resolve, clock } = await opening();
    const discriminator = await open();
    clock.now += LIVE_TICKET_LIFETIME_MS;
    expect(await resolve(discriminator)).toBeNull();
  });
});

describe("a desktop's opens while a host is away", () => {
  const away = async () => {
    const f = await fixture(limits, false, undefined, false, true);
    f.storage.createShare({
      share: {
        shareId: "other-person-share",
        workspaceId: scope.workspaceId,
        granterUserId: "owner-1",
        selectorJson: JSON.stringify({ paths: ["docs"], versionId: null }),
        createdAtMs: 1,
      },
      grant: {
        grantId: "other-person-grant",
        shareId: "other-person-share",
        principalKind: "user",
        principalUserId: "other-user",
        principalEmail: null,
        access: "edit",
        generation: 1,
        status: "active",
        revokedAtMs: null,
        createdAtMs: 1,
        parentGrantId: null,
      },
    });
    const notes = Array.from({ length: 12 }, (_, index) => `docs/away-${index}.md`);
    notes.forEach((path, index) =>
      f.raw
        .prepare(
          `INSERT INTO sync_relay_object_moments (workspace_id, object_id, relay_seq, moment_id, version_id, path, blob_sha256, content_kind, byte_length, recorded_at_ms)
          VALUES (?, ?, ?, ?, 'main', ?, ?, 'text', 1, 1)`,
        )
        .run(
          scope.workspaceId,
          `away-${index}`,
          200 + index,
          `away-moment-${index}`,
          path,
          "c".repeat(64),
        ),
    );
    const host = { away: true };
    // A mint throws when the host is away, as it does when the host goes away while it runs.
    const mint = vi.spyOn(f.tickets, "mint").mockImplementation(async () => {
      if (host.away) throw new Error("The live host changed.");
      return { token: "ticket", expiresAtMs: Date.now() + 60_000 };
    });
    const answers: (number | undefined)[] = [];
    const ended = new AbortController();
    cleanups.push(async () => ended.abort());
    const open = (path: string, person: "reader" | "other" = "reader") => {
      const index = answers.push(undefined) - 1;
      void f
        .post(
          "/sync/live/desktop-open",
          { shareId: person === "reader" ? scope.shareId : "other-person-share", path },
          "",
          person === "reader" ? {} : { authorization: "Bearer other-token" },
          ended.signal,
        )
        .then(
          (response) => (answers[index] = response.status),
          (error: unknown) => {
            if (!ended.signal.aborted || (error as Error).cause !== ended.signal.reason)
              throw error;
          },
        );
      return index;
    };
    const returns = () => {
      host.away = false;
      f.changes.notifyHost([scope.workspaceId]);
    };
    return { f, notes, mint, open, answers, returns };
  };

  it("lets one account's opens wait for an away host up to its limit, and every note opens once the host returns", async () => {
    const { notes, mint, open, answers, returns } = await away();
    const first = notes.slice(0, 6).map((path) => open(path));
    await vi.waitFor(() => expect(mint).toHaveBeenCalledTimes(6));
    await vi.waitFor(() => expect(answers.filter((status) => status === 404)).toHaveLength(2));
    const refused = first.filter((index) => answers[index] === 404);
    const other = open(notes[6]!, "other");
    await vi.waitFor(() => expect(mint).toHaveBeenCalledTimes(7));
    expect(answers[other]).toBeUndefined();
    returns();
    await vi.waitFor(() =>
      expect(
        first.filter((index) => !refused.includes(index)).map((index) => answers[index]),
      ).toEqual([200, 200, 200, 200]),
    );
    await vi.waitFor(() => expect(answers[other]).toBe(200));
    const again = refused.map((index) => open(notes[first.indexOf(index)]!));
    await vi.waitFor(() => expect(again.map((index) => answers[index])).toEqual([200, 200]));
  });

  it("never counts opens that a ready host accepts", async () => {
    const { notes, open, answers, returns } = await away();
    returns();
    for (const batch of [notes.slice(0, 6), notes.slice(6)]) {
      const opened = batch.map((path) => open(path));
      await vi.waitFor(() =>
        expect(opened.map((index) => answers[index])).toEqual(batch.map(() => 200)),
      );
    }
  });

  it("does not count an open whose ticket is refused while its host stays current", async () => {
    const { f, mint, open, answers, returns } = await away();
    // The fixture's note has a current host. A mint refused for it, as when the host's binding
    // moves during the mint, waits uncounted.
    mint.mockResolvedValue(null);
    const waiting = Array.from({ length: 6 }, () => open(binding.currentPath));
    await vi.waitFor(() => expect(mint).toHaveBeenCalledTimes(6));
    expect(waiting.map((index) => answers[index])).toEqual(waiting.map(() => undefined));
    mint.mockResolvedValue({ token: "ticket", expiresAtMs: Date.now() + 60_000 });
    returns();
    f.changes.notify(binding);
    await vi.waitFor(() =>
      expect(waiting.map((index) => answers[index])).toEqual(waiting.map(() => 200)),
    );
  });

  it("counts an open its account's ticket limit refuses", async () => {
    const { mint, open, answers } = await away();
    mint.mockRestore();
    const first = open(binding.currentPath);
    await vi.waitFor(() => expect(answers[first]).toBe(200));
    // That ticket fills the fixture's tickets for this grant, so each of these waits for one to
    // expire. Four wait; the rest are refused at once, well before the open timeout.
    const over = Array.from({ length: 6 }, () => open(binding.currentPath));
    await vi.waitFor(() => expect(over.filter((index) => answers[index] === 404)).toHaveLength(2));
    expect(over.filter((index) => answers[index] === undefined)).toHaveLength(4);
  });
});

// A link page stops editing on a 404 and tries again on a 503. Each of these answered 404 before.
describe("a link ticket while the relay is busy", () => {
  const tryAgain = [503, linkRefusalBody("link_live_unavailable")];
  const opaque = [404, { ok: false, error: "not found" }];
  const ask = async (f: LinkFixture) => {
    const response = await f.post("/sync/live/link-tickets", {
      discriminator: f.discriminator,
      objectId: binding.objectId,
    });
    return [response.status, await response.json()];
  };
  const unknownAgent = (agent: ReturnType<typeof linkAgent>) => ({
    ...agent.headers,
    authorization: `DohcAgent ${"Z".repeat(43)}`,
  });

  it("asks a holder to try again while the relay stops, and tells an agent nothing", async () => {
    const f = await fixture(limits, true),
      agent = linkAgent(f);
    f.routes.close();
    expect(await ask(f)).toEqual(tryAgain);
    f.useCredentials(agent.headers);
    expect(await ask(f)).toEqual(opaque);
  });

  it("asks a holder to try again while requests are full, and tells an agent nothing", async () => {
    const f = await fixture({ ...limits, upgradeTimeoutMs: 10_000 }, true),
      agent = linkAgent(f);
    let release!: () => void;
    const held = new Promise<null>((done) => {
      release = () => done(null);
    });
    const mint = vi.spyOn(f.tickets, "mint").mockImplementation(() => held);
    const waiting = Array.from({ length: limits.maxPendingRequests }, () => ask(f));
    await vi.waitFor(() => expect(mint).toHaveBeenCalledTimes(limits.maxPendingRequests));
    expect(await ask(f)).toEqual(tryAgain);
    f.useCredentials(agent.headers);
    expect(await ask(f)).toEqual(opaque);
    release();
    expect(await Promise.all(waiting)).toEqual(waiting.map(() => opaque));
  });

  it("asks a holder to try again when the live host reconnects during a ticket", async () => {
    const f = await fixture(limits, true);
    f.invalidated.abort();
    expect(await ask(f)).toEqual(tryAgain);
  });

  it("asks a holder to try again when the live host goes away during a ticket", async () => {
    const f = await fixture(limits, true);
    f.captureNative.mockImplementationOnce(async () => {
      f.raw.exec(
        "BEGIN IMMEDIATE; UPDATE sync_relay_session_host_control SET admission_state='closed', registered_connection_id=NULL; COMMIT",
      );
      return f.native;
    });
    expect(await ask(f)).toEqual(tryAgain);
  });

  // Only a full link says so: trying again can't help, and the holder can ask for a new link.
  it.each([
    ["linkDiscussionPrincipalLimit", [403, linkRefusalBody("link_full")]],
    ["workspaceQuotaBytes", opaque],
  ] as const)("stops a new holder that %s turns away", async (limit, answer) => {
    const f = await fixture(limits, true);
    // The storage context holds its limits here; the public storage type does not show them.
    (f.storage as unknown as { options: Record<typeof limit, number> }).options[limit] = 0;
    expect(await ask(f)).toEqual(answer);
  });

  // An agent enrolls elsewhere, so only the record of its public principal is new here.
  it("stops a link agent whose public principal a full workspace can't hold", async () => {
    for (const quota of [undefined, 0]) {
      const f = await fixture(limits, true);
      f.useCredentials(linkAgent(f).headers);
      if (quota !== undefined)
        (
          f.storage as unknown as { options: { workspaceQuotaBytes: number } }
        ).options.workspaceQuotaBytes = quota;
      const [status] = await ask(f);
      expect(status).toBe(quota === undefined ? 200 : 404);
    }
  });

  it("tells a caller with neither a capability nor an agent token nothing", async () => {
    const f = await fixture(limits, true);
    f.routes.close();
    f.useCredentials({});
    expect(await ask(f)).toEqual(opaque);
    f.useCredentials({ authorization: "Bearer something" });
    expect(await ask(f)).toEqual(opaque);
  });

  it("asks a holder to try again when a ticket takes too long", async () => {
    const f = await fixture(limits, true);
    vi.spyOn(f.tickets, "mint").mockImplementation(() => new Promise(() => {}));
    expect(await ask(f)).toEqual(tryAgain);
  });

  it("asks a known caller to try again when minting fails, and tells an unknown agent nothing", async () => {
    const f = await fixture(limits, true),
      agent = linkAgent(f);
    vi.spyOn(f.tickets, "mint").mockRejectedValue(new Error("Live-ticket operation failed."));
    expect(await ask(f)).toEqual(tryAgain);
    f.useCredentials(agent.headers);
    expect(await ask(f)).toEqual(tryAgain);
    f.useCredentials(unknownAgent(agent));
    expect(await ask(f)).toEqual(opaque);
  });
});

// A person in the owner's workspace opens a live document through the
// workspace share. The relay checks the path with the workspace file reach
// and admits only Edit.
it("admits a workspace member at Edit for a reached path, and refuses View, Comment and a path outside reach", async () => {
  const f = await fixture(limits, false, undefined, false, true);
  const relay = testHandler(f.storage);
  const owner = (path: string, body: Record<string, unknown>) =>
    relay(request("owner-1", `/sync/${scope.workspaceId}${path}`, jsonBody(body)));
  const invited = await owner("/members/invites", {
    email: "reader-1@dohc.test",
    workspaceName: "Docs",
  });
  expect(invited.status, await invited.clone().text()).toBe(200);
  const shares = await json(await relay(request("reader-1", "/sync/shares")));
  const shareId = (shares.received as Array<{ shareId: string; selector: { kind?: string } }>).find(
    (row) => row.selector.kind === "workspace",
  )!.shareId;
  f.raw
    .prepare(`INSERT INTO sync_relay_object_moments (workspace_id, object_id, relay_seq, moment_id, version_id, path, blob_sha256, content_kind, byte_length, recorded_at_ms)
    VALUES (?, 'object-secret', 50, 'moment-secret', 'main', '.env/notes.md', ?, 'text', 1, 1)`)
    .run(scope.workspaceId, "c".repeat(64));
  const open = (path: string) => f.post("/sync/live/desktop-open", { shareId, path });

  for (const level of ["view", "comment"]) {
    expect((await owner("/members/level", { level })).status).toBe(200);
    expect((await open(binding.currentPath)).status).toBe(404);
  }
  expect((await owner("/members/level", { level: "edit" })).status).toBe(200);
  const admitted = await open(binding.currentPath);
  expect(admitted.status).toBe(200);
  const body = (await admitted.json()) as {
    shareId: string;
    path: string;
    discriminator: string;
    ticket: { token: string };
  };
  expect(body).toMatchObject({ shareId, path: binding.currentPath });
  expect(await f.connect(body.ticket.token, undefined, {}, "", body.discriminator).status).toBe(
    101,
  );
  expect((await open(".env/notes.md")).status).toBe(404);
});

it("wakes only the connections on a changed document and still closes a revoked one elsewhere", async () => {
  const profile = selfHostLiveProfile(),
    admission = createLiveConnectionAdmission();
  const f = await fixture(
    profile.namedLive.transport,
    false,
    { maxSessions: 16, maxMembers: 16, maxSnapshotBytes: 4096 },
    false,
    false,
    admission,
    0,
    0,
    true,
    scope.workspaceId,
    scope.shareId,
    { people: 4, documents: 2 },
  );
  const published = new Map<string, number>(),
    applied = new Map<string, number>(),
    standing = new Map<string, number>();
  const updateBytes = Buffer.alloc(16, 7),
    updateDigest = createHash("sha256").update(updateBytes).digest("hex");
  f.captureNative.mockImplementation(async (current?: LiveObjectBinding) => {
    const native = { ...current!, selectorPaths: [current!.currentPath] };
    return {
      ...f.native,
      binding: native,
      client: {
        openLiveAppliedSync: async () => ({
          binding: native,
          hostVector: Buffer.from([0]),
          missingStateUpdate: Buffer.from([0, 0]),
          observedLocalYDocHeadSequence: 100,
          position: { eventCount: 0, journalCursor: 0, evidenceDigest: "ab".repeat(32) },
        }),
        readNextLiveApplied: async (_request: unknown, after: { eventCount: number }) => {
          applied.set(native.objectId, (applied.get(native.objectId) ?? 0) + 1);
          const next = after.eventCount + 1;
          if (next > (published.get(native.objectId) ?? 0)) return null;
          return {
            position: { eventCount: next, journalCursor: next, evidenceDigest: "cd".repeat(32) },
            updateBytes,
            ack: {
              deliveryId: `edit-${next}`,
              updateDigest,
              journalCursor: next,
              acceptingHostEpoch: host.hostEpoch,
              localYDocSequence: next,
              applicationReplayed: false,
            },
          };
        },
        readLiveApplicationAck: async () => null,
      },
    } as NamedFrameNativeHost;
  });
  const sockets = new Map<number, { document: number; socket: ReturnType<typeof f.connect> }>();
  for (let person = 1; person <= 4; person++) {
    const document = ((person - 1) % 2) + 1,
      peer = await f.peer(person, document),
      socket = peer.connect((await peer.mint()).token);
    expect(await socket.status).toBe(101);
    await openProductionSync(f, socket);
    sockets.set(person, { document, socket });
  }
  // Each connection holds one standing listener and one waiting native read.
  await vi.waitFor(() => expect(f.changes.listenerCount()).toBe(8));
  const resolve = f.storage.resolveCurrentLiveDocumentBinding.bind(f.storage);
  vi.spyOn(f.storage, "resolveCurrentLiveDocumentBinding").mockImplementation(
    (input, activation) => {
      standing.set(input.document.objectId, (standing.get(input.document.objectId) ?? 0) + 1);
      return resolve(input, activation);
    },
  );
  const arrived = (socket: ReturnType<typeof f.connect>, cursor: number) =>
    socket.until(
      () =>
        socket.received.some(
          (frame) =>
            frame.kind === "begin" &&
            frame.purpose === "applied-update" &&
            frame.journalCursor === cursor,
        ),
      `applied update ${cursor}`,
    );
  applied.clear();
  published.set("object-1", 1);
  f.changes.notify({ ...f.binding, objectId: "object-1" });
  await Promise.all(
    [...sockets.values()]
      .filter(({ document }) => document === 1)
      .map(({ socket }) => arrived(socket, 1)),
  );
  await new Promise((resolve) => setImmediate(resolve));
  expect({
    standing: standing.get("object-2") ?? 0,
    applied: applied.get("object-2") ?? 0,
  }).toEqual({ standing: 0, applied: 0 });
  expect(standing.get("object-1")).toBeGreaterThan(0);
  expect(applied.get("object-1")).toBeGreaterThan(0);
  // A relay write naming document 2 rechecks only document 2's standing.
  standing.clear();
  applied.clear();
  f.changes.notifyWrite([{ ...f.binding, objectId: "object-2" }]);
  await new Promise((resolve) => setImmediate(resolve));
  expect(Object.fromEntries(standing)).toEqual({ "object-2": 2 });
  expect(applied.size).toBe(0);
  // A relay write that names no document rechecks every connection, so a
  // revoked grant on document 2 still closes its connection.
  const revoked = sockets.get(2)!.socket;
  f.raw
    .prepare("UPDATE sync_relay_share_grants SET generation=generation+1 WHERE grant_id=?")
    .run("edit-2");
  f.changes.notifyWrite();
  expect((await revoked.closed)[0]).not.toBe(1000);
  await vi.waitFor(() => expect(f.changes.listenerCount()).toBe(6));
  expect(
    [1, 3, 4].every((person) => sockets.get(person)!.socket.ws.readyState === WebSocket.OPEN),
  ).toBe(true);
  for (const person of [1, 3, 4]) sockets.get(person)!.socket.ws.close();
  await vi.waitFor(() => expect(f.changes.listenerCount()).toBe(0));
}, 60_000);

it.each([
  ["maxConnections", "live_total_limit"],
  ["maxConnectionsPerWorkspace", "live_workspace_limit"],
  ["maxConnectionsPerGrant", "live_grant_limit"],
  ["maxConnectionsPerPrincipal", "live_person_limit"],
  ["maxConnectionsPerSession", "live_session_limit"],
] as const)(
  "names %s only after authenticating and redeeming an in-scope ticket",
  async (limit, code) => {
    const f = await fixture({ ...limits, [limit]: 1 });
    const first = f.connect((await f.mint()).token);
    expect(await first.status).toBe(101);
    const ticket = await f.mint();
    expect(await f.connect(ticket.token, "account=other").status).toBe(404);
    const refused = f.connect(ticket.token);
    expect(await refused.status).toBe(101);
    expect(await refused.closed).toEqual([LIVE_CONNECTION_LIMIT_CLOSE_CODE, code]);
    expect(f.captureNative).toHaveBeenCalledTimes(5);
  },
);

it("rechecks no live connection for a Group's posts, and still closes the sockets a removal, a revocation or a lower level ends", async () => {
  const profile = selfHostLiveProfile(),
    admission = createLiveConnectionAdmission();
  const f = await fixture(
    profile.namedLive.transport,
    false,
    { maxSessions: 16, maxMembers: 16, maxSnapshotBytes: 4096 },
    false,
    false,
    admission,
    0,
    0,
    true,
    scope.workspaceId,
    scope.shareId,
    { people: 4, documents: 2 },
  );
  // The fixture's share becomes the workspace's membership, and its four Edit grants the members'.
  f.raw
    .prepare("UPDATE sync_relay_shares SET selector_json = ? WHERE share_id = ?")
    .run(WORKSPACE_SHARE_SELECTOR_JSON, scope.shareId);
  f.raw
    .prepare(`INSERT INTO sync_relay_workspace_memberships (workspace_id, share_id, member_level, workspace_name, created_at_ms)
    VALUES (?, ?, 'edit', 'Fundraiser', 0)`)
    .run(scope.workspaceId, scope.shareId);
  for (let person = 1; person <= 4; person++) {
    f.raw
      .prepare(`INSERT INTO sync_relay_workspace_members (member_id, workspace_id, grant_id, user_id, email, role, state, invited_at_ms, joined_at_ms)
      VALUES (?, ?, ?, ?, NULL, 'member', 'active', 0, 0)`)
      .run("member-" + person, scope.workspaceId, "edit-" + person, "reader-" + person);
  }
  f.captureNative.mockImplementation(async (current?: LiveObjectBinding) => {
    const native = { ...current!, selectorPaths: [current!.currentPath] };
    return {
      ...f.native,
      binding: native,
      client: {
        openLiveAppliedSync: async () => ({
          binding: native,
          hostVector: Buffer.from([0]),
          missingStateUpdate: Buffer.from([0, 0]),
          observedLocalYDocHeadSequence: 100,
          position: { eventCount: 0, journalCursor: 0, evidenceDigest: "ab".repeat(32) },
        }),
        readNextLiveApplied: async () => null,
        readLiveApplicationAck: async () => null,
      },
    } as NamedFrameNativeHost;
  });
  const sockets = new Map<number, ReturnType<typeof f.connect>>();
  for (let person = 1; person <= 4; person++) {
    const peer = await f.peer(person, ((person - 1) % 2) + 1),
      socket = peer.connect((await peer.mint()).token);
    expect(await socket.status).toBe(101);
    await openProductionSync(f, socket);
    sockets.set(person, socket);
  }
  await vi.waitFor(() => expect(f.changes.listenerCount()).toBe(8));
  // As a delivering host wires them.
  const stop = observeRelayWrites(f.storage, (documents) => f.changes.notifyWrite(documents));
  cleanups.push(async () => stop());
  const workspaceId = scope.workspaceId,
    threadId = "t".repeat(26);
  const append = (ops: Parameters<typeof sequenced>[0], originId = "member-desktop") =>
    f.storage.appendLogBatch({
      workspaceId,
      originId,
      ops: sequenced(ops, f.storage.maxOriginSeq(workspaceId, originId) + 1).map(
        ({ payload, ...op }) => ({ ...op, payloadJson: JSON.stringify(payload) }),
      ),
    });
  append(
    [
      chatChannelCreate("c".repeat(26), {
        kind: "channel",
        name: "Events",
        type: "both",
        folderPath: "events",
      }),
      chatThreadCreate(threadId, "c".repeat(26)),
    ],
    "owner-desktop",
  );
  await new Promise((resolve) => setImmediate(resolve));
  let posted = 0;
  const post = () =>
    append([
      chatMessageAppend(`post-${++posted}`, threadId, "See you at 6", {
        authorUserId: "reader-1",
        authorDisplayName: "Sam",
        parentMessageId: posted > 1 ? "post-1" : undefined,
      }),
    ]);
  const resolve = f.storage.resolveCurrentLiveDocumentBinding.bind(f.storage);
  const rechecks = vi
    .spyOn(f.storage, "resolveCurrentLiveDocumentBinding")
    .mockImplementation((input, activation) => resolve(input, activation));
  for (let count = 0; count < 3; count++) post();
  append([
    {
      opKind: "chat.reaction.set",
      payload: {
        reactionId: "r1",
        messageId: "post-1",
        threadId,
        emoji: "+1",
        authorId: "reader-2",
        authorKind: "human",
        authorDisplayName: "Ana",
        state: "on",
        atMs: 5,
      },
    },
  ]);
  await new Promise((resolve) => setImmediate(resolve));
  expect(rechecks).not.toHaveBeenCalled();
  expect([...sockets.values()].every((socket) => socket.ws.readyState === WebSocket.OPEN)).toBe(
    true,
  );
  const open = (people: number[]) =>
    people.every((person) => sockets.get(person)!.ws.readyState === WebSocket.OPEN);
  post();
  expect(
    f.storage.removeWorkspaceMember({
      workspaceId,
      actorUserId: "owner-1",
      memberId: "member-1",
      nowMs: 10,
    }),
  ).toEqual({ ok: true });
  post();
  expect((await sockets.get(1)!.closed)[0]).not.toBe(1000);
  expect(open([2, 3, 4])).toBe(true);
  post();
  expect(
    f.storage.revokeShareGrant({ shareId: scope.shareId, grantId: "edit-2", revokedAtMs: 11 }).ok,
  ).toBe(true);
  post();
  expect((await sockets.get(2)!.closed)[0]).not.toBe(1000);
  expect(open([3, 4])).toBe(true);
  post();
  expect(
    f.storage.setWorkspaceMemberLevel({
      workspaceId,
      actorUserId: "owner-1",
      level: "comment",
      workspaceName: undefined,
      newShareId: () => "unused-share",
      nowMs: 12,
    }),
  ).toEqual({ ok: true });
  post();
  expect((await sockets.get(3)!.closed)[0]).not.toBe(1000);
  expect((await sockets.get(4)!.closed)[0]).not.toBe(1000);
  await vi.waitFor(() => expect(f.changes.listenerCount()).toBe(0));
}, 60_000);

it.each([
  ["maxConnections", "live_total_limit"],
  ["maxConnectionsPerWorkspace", "live_workspace_limit"],
  ["maxConnectionsPerGrant", "live_grant_limit"],
  ["maxConnectionsPerPrincipal", "live_person_limit"],
  ["maxConnectionsPerSession", "live_session_limit"],
] as const)(
  "names %s only after authenticating and redeeming an in-scope ticket",
  async (limit, code) => {
    const f = await fixture({ ...limits, [limit]: 1 });
    const first = f.connect((await f.mint()).token);
    expect(await first.status).toBe(101);
    const ticket = await f.mint();
    expect(await f.connect(ticket.token, "account=other").status).toBe(404);
    const refused = f.connect(ticket.token);
    expect(await refused.status).toBe(101);
    expect(await refused.closed).toEqual([LIVE_CONNECTION_LIMIT_CLOSE_CODE, code]);
    expect(f.captureNative).toHaveBeenCalledTimes(5);
  },
);

it.each([""])(
  "ends a member's standing live writer when its folder rule becomes %j",
  async (rule) => {
    const f = await fixture(limits, false, undefined, false, true);
    f.raw
      .prepare("UPDATE sync_relay_shares SET selector_json=? WHERE share_id=?")
      .run(WORKSPACE_SHARE_SELECTOR_JSON, scope.shareId);
    f.raw
      .prepare(
        `INSERT INTO sync_relay_workspace_memberships (workspace_id,share_id,member_level,workspace_name,created_at_ms) VALUES (?,?,'edit','Workspace',0)`,
      )
      .run(scope.workspaceId, scope.shareId);
    f.raw
      .prepare(`INSERT INTO sync_relay_workspace_members (member_id,workspace_id,grant_id,user_id,email,role,state,invited_at_ms,joined_at_ms)
    VALUES ('member',?,?,?,NULL,'member','active',0,0)`)
      .run(scope.workspaceId, scope.grantId, scope.userId);
    const ticket = await f.mint();
    const socket = f.connect(ticket.token);
    expect(await socket.status).toBe(101);
    await socket.until(() => socket.received.some((frame) => frame.kind === "credit"));
    const stop = observeRelayWrites(f.storage, (documents) => f.changes.notifyWrite(documents));
    cleanups.push(async () => stop());
    (f.storage as StorageContext).tx(() =>
      (f.storage as StorageContext).db
        .prepare(
          `INSERT INTO sync_relay_access_rules (workspace_id,folder,rule_text,from_seq,to_seq) VALUES (?,'docs',?,100,NULL)`,
        )
        .run(scope.workspaceId, rule),
    );
    await vi.waitFor(() => expect(socket.ws.readyState).toBe(WebSocket.CLOSED));
    expect((await socket.closed)[0]).not.toBe(1000);
    const hidden = await f.post("/sync/live/desktop-open", {
      shareId: scope.shareId,
      path: binding.currentPath,
    });
    const missing = await f.post("/sync/live/desktop-open", {
      shareId: scope.shareId,
      path: "docs/missing.md",
    });
    expect(hidden.status).toBe(404);
    expect(await hidden.text()).toBe(await missing.text());
  },
);

function waitForPings(ws: WebSocket, count: number) {
  return new Promise<number>((resolve, reject) => {
    let seen = 0;
    const onPing = () => {
      if (++seen >= count) {
        cleanup();
        resolve(seen);
      }
    };
    const onClose = () => {
      cleanup();
      reject(new Error(`Socket closed after ${seen} of ${count} pings`));
    };
    const cleanup = () => {
      ws.off("ping", onPing);
      ws.off("close", onClose);
    };
    ws.on("ping", onPing);
    ws.once("close", onClose);
  });
}

it("keeps an invited desktop editor live past idleTimeoutMs via server pings and closes when pongs stop", async () => {
  const routeLimits = { ...limits, idleTimeoutMs: 600 };
  const f = await fixture(routeLimits, false, undefined, false, true);
  const desktop = f.connect((await f.mint()).token);
  expect(await desktop.status).toBe(101);
  const enoughPings = waitForPings(desktop.ws, 5);
  const { provider, until } = await startProvider(desktop);
  await until(() => provider.state().status === "live");
  expect(await enoughPings).toBe(5);
  expect(desktop.ws.readyState).toBe(WebSocket.OPEN);
  expect(provider.state().status).toBe("live");
  const silent = f.connect((await f.mint()).token, undefined, {}, "", undefined, false);
  expect(await silent.status).toBe(101);
  const spoof = setInterval(() => {
    if (silent.ws.readyState === WebSocket.OPEN) silent.ws.pong(Buffer.alloc(8, 7));
  }, 100);
  try {
    await silent.closed;
  } finally {
    clearInterval(spoof);
  }
  expect(silent.ws.readyState).toBe(WebSocket.CLOSED);
});

it("keeps an active invited desktop socket open while an earlier ping is still in flight", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  try {
    const routeLimits = { ...limits, idleTimeoutMs: 2_000 };
    const f = await fixture(routeLimits, false, undefined, false, true);
    const socket = f.connect((await f.mint()).token, undefined, {}, "", undefined, false);
    expect(await socket.status).toBe(101);
    const ping = new Promise<Buffer>((resolve) => socket.ws.once("ping", resolve));
    await vi.advanceTimersByTimeAsync(routeLimits.idleTimeoutMs / 2);
    const nonce = await ping;
    await openProductionSync(f, socket);
    await vi.advanceTimersByTimeAsync(routeLimits.idleTimeoutMs / 2);
    expect(socket.ws.readyState).toBe(WebSocket.OPEN);
    socket.ws.pong(nonce);
    expect(await pingOutcome(socket)).toBe("pong");
  } finally {
    vi.useRealTimers();
  }
});

it("closes an idle invited desktop socket on the next pong when its grant is revoked without a write wake", async () => {
  const routeLimits = { ...limits, idleTimeoutMs: 400 };
  const f = await fixture(routeLimits, false, undefined, false, true);
  const desktop = f.connect((await f.mint()).token);
  expect(await desktop.status).toBe(101);
  const { provider, until } = await startProvider(desktop);
  await until(() => provider.state().status === "live");
  expect(
    f.storage.revokeShareGrant({
      shareId: scope.shareId,
      grantId: scope.grantId,
      revokedAtMs: 2000,
    }).ok,
  ).toBe(true);
  await desktop.closed;
  expect(desktop.ws.readyState).toBe(WebSocket.CLOSED);
});

it("keeps delivering live room edits after quiet idle cycles and keeps editing after Can edit -> Can view -> Can edit", async () => {
  const routeLimits = { ...limits, idleTimeoutMs: 400 };
  let liveRooms: LiveRooms | undefined;
  const f = await fixture(
    routeLimits,
    false,
    undefined,
    false,
    true,
    undefined,
    0,
    0,
    false,
    undefined,
    undefined,
    undefined,
    {
      join: (captured: NamedFrameRoomHost) => liveRooms!.join(captured),
    } as unknown as LiveRooms,
    true,
  );
  f.sessionRows.set("session-other-user", {
    userId: "other-user",
    expiresAtMs: 8e12,
    clientKind: "desktop",
  });
  liveRooms = createLiveRooms({
    storage: f.storage,
    maxUpdateBytes: 1 << 20,
    maxNoteBytes: 1 << 22,
    maxAppliedBytes: 1 << 20,
    saveEveryMs: 3_600_000,
    log() {},
    openSaver: async () =>
      captureOwnerLiveFrameHost({
        authenticatedUserId: "owner-1",
        storage: f.storage,
        native: f.native,
        bounds,
        validate: ({ retainStateUpdate: _retainStateUpdate, ...input }) =>
          createLiveMarkdownJournalValidator(policy)(input),
      }),
  });
  cleanups.push(async () => liveRooms!.close());

  f.raw
    .prepare(
      `INSERT INTO sync_relay_share_grants (grant_id, share_id, principal_kind, principal_user_id, access, status, generation, created_at_ms)
       VALUES ('edit-peer', ?, 'user', 'other-user', 'edit', 'active', 1, 1)`,
    )
    .run(scope.shareId);
  const openDesktop = async (authorization: string) => {
    const response = await f.post(
      "/sync/live/desktop-open",
      { shareId: scope.shareId, path: binding.currentPath },
      undefined,
      { authorization },
    );
    expect(response.status).toBe(200);
    const admitted = (await response.json()) as {
      discriminator: string;
      ticket: { token: string };
    };
    const socket = f.connect(
      admitted.ticket.token,
      undefined,
      { authorization },
      "",
      admitted.discriminator,
    );
    expect(await socket.status).toBe(101);
    const peer = await startProvider(socket);
    await peer.until(() => peer.provider.state().status === "live");
    return { socket, ...peer };
  };

  const editorA = await openDesktop("Bearer peer-token");
  const editorBSocket = f.connect((await f.mint()).token);
  expect(await editorBSocket.status).toBe(101);
  const editorBPeer = await startProvider(editorBSocket);
  await editorBPeer.until(() => editorBPeer.provider.state().status === "live");
  const editorB = { socket: editorBSocket, ...editorBPeer };

  const appendParagraph = (doc: Y.Doc, text: string) => {
    const paragraph = new Y.XmlElement("paragraph");
    paragraph.insert(0, [new Y.XmlText(text)]);
    const body = doc.getXmlFragment("body");
    body.insert(body.length, [paragraph]);
  };
  const waitForText = (doc: Y.Doc, needle: string) =>
    doc.getXmlFragment("body").toString().includes(needle)
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          const onUpdate = () => {
            if (doc.getXmlFragment("body").toString().includes(needle)) {
              doc.off("update", onUpdate);
              resolve();
            }
          };
          doc.on("update", onUpdate);
        });

  editorA.provider.doc.transact(() => appendParagraph(editorA.provider.doc, "ZERO_QUIET"));
  await waitForText(editorB.provider.doc, "ZERO_QUIET");

  await Promise.all([waitForPings(editorA.socket.ws, 6), waitForPings(editorB.socket.ws, 6)]);
  expect(editorA.socket.ws.readyState).toBe(WebSocket.OPEN);
  expect(editorB.socket.ws.readyState).toBe(WebSocket.OPEN);
  editorA.provider.doc.transact(() => appendParagraph(editorA.provider.doc, "AFTER_QUIET"));
  await waitForText(editorB.provider.doc, "AFTER_QUIET");

  f.raw
    .prepare(
      "UPDATE sync_relay_share_grants SET access = 'view', generation = generation + 1 WHERE grant_id = ?",
    )
    .run(scope.grantId);
  editorB.provider.doc.transact(() => appendParagraph(editorB.provider.doc, "DURING_VIEW"));
  await editorB.socket.closed;
  expect(editorA.provider.doc.getXmlFragment("body").toString()).not.toContain("DURING_VIEW");
  expect(
    (await f.post("/sync/live/desktop-open", { shareId: scope.shareId, path: binding.currentPath }))
      .status,
  ).toBe(404);

  f.raw
    .prepare(
      "UPDATE sync_relay_share_grants SET access = 'edit', generation = generation + 1 WHERE grant_id = ?",
    )
    .run(scope.grantId);
  const editorB2 = await openDesktop("Bearer reader-token");
  await waitForPings(editorB2.socket.ws, 4);
  expect(editorB2.socket.ws.readyState).toBe(WebSocket.OPEN);
  expect(editorB2.provider.state().status).toBe("live");
  editorB2.provider.doc.transact(() => appendParagraph(editorB2.provider.doc, "AFTER_ROUNDTRIP"));
  await waitForText(editorA.provider.doc, "AFTER_ROUNDTRIP");
});

describe("desktop account session standing", () => {
  const desktopSessionFixture = (routeLimits = limits) =>
    fixture(
      routeLimits,
      false,
      undefined,
      false,
      true,
      undefined,
      0,
      0,
      false,
      undefined,
      undefined,
      undefined,
      undefined,
      true,
    );

  it("requires resolveAccountSession and accountSessions to be paired and desktop-only", async () => {
    const f = await fixture(limits, false, undefined, false, true);
    const base = {
      storage: f.storage,
      hosts: new Set([relayHost]),
      publicOrigin: audience,
      exchangeKey: "0123456789abcdef0123456789abcdef",
      frames,
      bounds,
      limits,
      validate: createLiveMarkdownJournalValidator(policy),
      sessions: f.desktopAdmission!,
      tickets: f.tickets,
      captureNative: f.captureNative,
    };
    expect(() =>
      createNamedLiveRoutes({
        ...base,
        kind: "named",
        desktopBearer: true,
        resolveAccountSession: f.accountSession,
      }),
    ).toThrow(TypeError);
    expect(() =>
      createNamedLiveRoutes({
        ...base,
        kind: "named",
        desktopBearer: true,
        accountSessions: { read: f.readSessions },
      }),
    ).toThrow(TypeError);
    expect(() =>
      createNamedLiveRoutes({
        ...base,
        kind: "named",
        desktopBearer: false,
        resolveAccountSession: f.accountSession,
        accountSessions: { read: f.readSessions },
      }),
    ).toThrow(TypeError);
  });

  it("rejects unknown desktop discriminators without calling resolveAccountSession", async () => {
    const f = await desktopSessionFixture();
    const ticket = await f.mint();
    f.accountSession.mockClear();
    const unknown = f.connect(ticket.token, undefined, {}, "", "unknown12345");
    expect(await unknown.status).toBe(404);
    expect(f.accountSession).not.toHaveBeenCalled();
  });

  it("stops an open desktop socket immediately on stopSession and rejects upgrade if revoked during capture", async () => {
    const f = await desktopSessionFixture({ ...limits, idleTimeoutMs: 600 });
    const desktop = f.connect((await f.mint()).token);
    expect(await desktop.status).toBe(101);
    await desktop.until(() => desktop.received.some((frame) => frame.kind === "welcome"));
    f.routes.stopSession(scope.userId, `session-${scope.userId}`);
    await desktop.closed;
    expect(desktop.ws.readyState).toBe(WebSocket.CLOSED);

    f.captureNative.mockImplementationOnce(async () => {
      f.sessionRows.delete(`session-${scope.userId}`);
      return f.native;
    });
    const racing = f.connect((await f.mint()).token);
    expect(await racing.status).toBe(404);
  });

  it.each(["deleted", "unreadable", "standing"] as const)(
    "reads desktop sign-ins each minute and closes when %s",
    async (state) => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      try {
        const f = await desktopSessionFixture({
          ...limits,
          idleTimeoutMs: OWNER_SESSION_CHECK_MS * 4,
        });
        const desktop = f.connect((await f.mint()).token);
        expect(await desktop.status).toBe(101);
        await desktop.until(() => desktop.received.some((frame) => frame.kind === "welcome"));
        f.readSessions.mockClear();
        if (state === "deleted") f.sessionRows.delete(`session-${scope.userId}`);
        if (state === "unreadable") f.readSessions.mockRejectedValueOnce(new Error("unreadable"));
        await vi.advanceTimersByTimeAsync(OWNER_SESSION_CHECK_MS);
        expect(f.readSessions).toHaveBeenCalledOnce();
        expect(f.readSessions).toHaveBeenCalledWith([`session-${scope.userId}`]);
        if (state === "standing") expect(desktop.ws.readyState).toBe(WebSocket.OPEN);
        else await desktop.closed;
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("closes a desktop socket when its sign-in expires, and not before", async () => {
    const f = await desktopSessionFixture();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    try {
      const expiresAtMs = Date.now() + 5_000;
      f.accountSession.mockResolvedValue({
        userId: scope.userId,
        sessionId: `session-${scope.userId}`,
        expiresAtMs,
        clientKind: "desktop",
      });
      f.sessionRows.set(`session-${scope.userId}`, {
        userId: scope.userId,
        expiresAtMs,
        clientKind: "desktop",
      });
      const desktop = f.connect((await f.mint()).token);
      expect(await desktop.status).toBe(101);
      await desktop.until(() => desktop.received.some((frame) => frame.kind === "welcome"));
      await vi.advanceTimersByTimeAsync(4_999);
      expect(desktop.ws.readyState).toBe(WebSocket.OPEN);
      await vi.advanceTimersByTimeAsync(1);
      await desktop.closed;
      expect(desktop.ws.readyState).toBe(WebSocket.CLOSED);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a joined member's phone", () => {
  async function memberPhoneFixture(
    options: {
      routeLimits?: typeof limits;
      validate?: Parameters<typeof createNamedLiveRoutes>[0]["validate"];
      rooms?: LiveRooms;
    } = {},
  ) {
    const f = await fixture(options.routeLimits ?? limits, false, undefined, false, true);
    const phoneKey = createHmac("sha256", key).update("dohc-phone-named-live-ticket").digest();
    const phoneTickets = createLiveTickets({
      storage: f.storage,
      audience,
      key: phoneKey,
      hostReports: createLiveHostReports({
        storage: f.storage,
        captureNative: f.captureNative,
      }),
    });
    const phoneSessions = createPhoneMemberLiveSessions({
      storage: f.storage,
      maxSessions: 16,
      now: () => 1000,
    });
    const sessionRows = new Map<string, StoredAccountSession>([
      ["phone-1", { userId: scope.userId, expiresAtMs: 8e12, clientKind: "phone" }],
      ["phone-2", { userId: scope.userId, expiresAtMs: 8e12, clientKind: "phone" }],
      ["other-phone", { userId: "other-user", expiresAtMs: 8e12, clientKind: "phone" }],
    ]);
    const readSessions = vi.fn(
      async (ids: readonly string[]) =>
        new Map(
          ids.flatMap((id): Array<[string, StoredAccountSession]> => {
            const row = sessionRows.get(id);
            return row ? [[id, row]] : [];
          }),
        ),
    );
    const resolveAccountSession: ResolveAccountSession = vi.fn(async (req) => {
      const match = /^Bearer session:([\w-]+):([\w-]+):(phone|desktop|browser)$/u.exec(
        req.headers.get("authorization") ?? "",
      );
      if (!match) throw new UnauthorizedError();
      const row = sessionRows.get(match[2]!);
      return {
        userId: match[1]!,
        sessionId: match[2]!,
        expiresAtMs: row?.expiresAtMs ?? 8e12,
        clientKind: match[3] as "phone" | "desktop" | "browser",
      };
    });
    const phoneRoutes = createNamedLiveRoutes({
      kind: "named",
      phoneBearer: true,
      resolveAccountSession,
      accountSessions: { read: readSessions },
      phoneSessions,
      storage: f.storage,
      hosts: new Set([relayHost]),
      publicOrigin: audience,
      exchangeKey: "test-exchange-key-".repeat(3),
      limits: options.routeLimits ?? limits,
      frames,
      bounds,
      validate: options.validate ?? createLiveMarkdownJournalValidator(policy),
      tickets: phoneTickets,
      captureNative: f.captureNative,
      ...(options.rooms ? { rooms: options.rooms } : {}),
    });
    const server = createServer();
    server.on("upgrade", (req, socket, head) => {
      void phoneRoutes.handleUpgrade(req, socket, head).catch(() => socket.destroy());
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    cleanups.push(async () => {
      phoneRoutes.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    async function mintMember(
      overrides: {
        userId?: string;
        sessionId?: string;
        objectId?: string;
        lineageClaimId?: string;
        path?: string;
      } = {},
    ) {
      const minted = (await phoneTickets.mint(
        { objectId: overrides.objectId ?? binding.objectId },
        {
          kind: "named",
          workspaceId: scope.workspaceId,
          shareId: scope.shareId,
          grantId: scope.grantId,
          userId: overrides.userId ?? scope.userId,
        },
      ))!;
      const created = phoneSessions.create({
        userId: overrides.userId ?? scope.userId,
        sessionId: overrides.sessionId ?? "phone-1",
        workspaceId: scope.workspaceId,
        shareId: scope.shareId,
        grantId: scope.grantId,
        objectId: overrides.objectId ?? binding.objectId,
        lineageClaimId: overrides.lineageClaimId ?? binding.lineageClaimId,
        path: overrides.path ?? binding.currentPath,
        token: minted.token,
        expiresAtMs: minted.expiresAtMs,
      })!;
      return { token: minted.token, discriminator: created.discriminator };
    }

    function connectPhone(
      token: string,
      discriminator: string,
      headers: Record<string, string> = {},
    ) {
      const ws = new WebSocket(
        `ws://127.0.0.1:${port}/sync/live/phone?session=${discriminator}`,
        token ? ["dohc-live-v1", `dohc-live-ticket.${token}`] : ["dohc-live-v1"],
        {
          headers: {
            host: relayHost,
            authorization: `Bearer session:${scope.userId}:phone-1:phone`,
            ...headers,
          },
        },
      );
      cleanups.push(async () => {
        ws.terminate();
      });
      const frameSession = createLiveFrameSession("client", frames);
      const received: LiveFrame[] = [];
      let syncCursor: number | null = null;
      let resolveStatus!: (code: number) => void;
      const status = new Promise<number>((resolve) => {
        resolveStatus = resolve;
      });
      const closed = new Promise<void>((resolve) => ws.once("close", () => resolve()));
      ws.once("upgrade", () => resolveStatus(101));
      ws.once("unexpected-response", (_req, res) => {
        res.resume();
        resolveStatus(res.statusCode ?? 0);
      });
      ws.on("error", () => {});
      ws.on("message", (data: Buffer) => {
        const decoded = frameSession.receive(new Uint8Array(data));
        received.push(decoded.value.frame);
        if (decoded.value.transfer?.value.begin.purpose === "initial-sync")
          syncCursor = decoded.value.transfer.value.begin.appliedThroughJournalCursor;
        decoded.value.transfer?.release();
        decoded.release();
      });
      const send = (frame: LiveFrame) => {
        const lease = frameSession.send(frame);
        ws.send(lease.value);
        lease.release();
      };
      const until = (predicate: () => boolean) =>
        vi.waitFor(() => expect(predicate()).toBe(true), { timeout: 5_000, interval: 10 });
      return { ws, status, closed, received, send, until, syncCursor: () => syncCursor };
    }

    return {
      ...f,
      phoneTickets,
      phoneSessions,
      phoneRoutes,
      sessionRows,
      readSessions,
      resolveAccountSession,
      mintMember,
      connectPhone,
    };
  }

  it("validates phoneBearer route options strictly", async () => {
    const f = await fixture(limits, false, undefined, false, true);
    const phoneSessions = createPhoneMemberLiveSessions({ storage: f.storage, maxSessions: 4 });
    const base = {
      kind: "named" as const,
      storage: f.storage,
      hosts: new Set([relayHost]),
      publicOrigin: audience,
      exchangeKey: "test-exchange-key-".repeat(3),
      limits,
      frames,
      bounds,
      validate: createLiveMarkdownJournalValidator(policy),
      tickets: f.tickets,
      captureNative: f.captureNative,
    };
    expect(() =>
      createNamedLiveRoutes({
        ...base,
        desktopBearer: true,
        phoneBearer: true,
        sessions: f.desktopAdmission!,
      }),
    ).toThrow(TypeError);
    expect(() =>
      createNamedLiveRoutes({
        ...base,
        phoneBearer: true,
        resolveAccountSession: f.accountSession,
      }),
    ).toThrow(TypeError);
    expect(() =>
      createNamedLiveRoutes({ ...base, sessions: f.desktopAdmission!, phoneSessions }),
    ).toThrow(TypeError);
  });

  it("opens on /sync/live/phone, isolates tickets across sessions/users/routes, rejects agent claims, and never leaks secrets", async () => {
    const f = await memberPhoneFixture();
    const logs = (["log", "info", "warn", "error", "debug"] as const).map((level) =>
      vi.spyOn(console, level),
    );
    const { token, discriminator } = await f.mintMember();

    // Unknown discriminator fails before resolving account session.
    expect(await f.connectPhone(token, "unknown12345").status).toBe(404);
    expect(f.resolveAccountSession).not.toHaveBeenCalled();

    // Wrong phone session, wrong user, desktop/browser token, cookie, and desktop ticket are refused without consuming the valid session.
    expect(
      await f.connectPhone(token, discriminator, {
        authorization: `Bearer session:${scope.userId}:phone-2:phone`,
      }).status,
    ).toBe(404);
    expect(
      await f.connectPhone(token, discriminator, {
        authorization: "Bearer session:other-user:other-phone:phone",
      }).status,
    ).toBe(404);
    expect(
      await f.connectPhone(token, discriminator, {
        authorization: `Bearer session:${scope.userId}:phone-1:desktop`,
      }).status,
    ).toBe(404);
    expect(
      await f.connectPhone(token, discriminator, {
        cookie: "account=reader",
      }).status,
    ).toBe(404);
    const desktopTicket = await f.mint();
    expect(await f.connectPhone(desktopTicket.token, discriminator).status).toBe(404);
    // Phone ticket cannot redeem on the desktop route either.
    expect(await f.connect(token).status).toBe(404);

    // Valid matching phone session succeeds once, then discriminator & ticket cannot be reused.
    const client = f.connectPhone(token, discriminator);
    expect(await client.status).toBe(101);
    await client.until(() => client.received.some((frame) => frame.kind === "welcome"));
    expect(await f.connectPhone(token, discriminator).status).toBe(404);
    expect(JSON.stringify(logs.flatMap((log) => log.mock.calls))).not.toContain(token);

    // Open sync and attempt to spoof an agent authorContext -> provenance-refused (personOnly).
    client.send({ kind: "hello", receivePolicy: frames.receive });
    client.send({
      kind: "credit",
      grantedBytes: frames.maxQueuedBytes,
      grantedFrames: frames.maxQueuedFrames,
    });
    await client.until(() => client.received.some((frame) => frame.kind === "credit"));
    const emptyVec = Y.encodeStateVector(new Y.Doc());
    client.send({
      kind: "begin",
      purpose: "client-vector",
      transferId: 1,
      totalBytes: emptyVec.length,
      digest: createHash("sha256").update(emptyVec).digest("hex"),
    });
    client.send({ kind: "chunk", transferId: 1, offset: 0, bytes: emptyVec });
    await client.until(() => client.syncCursor() !== null);
    client.send({ kind: "sync-applied", appliedThroughJournalCursor: client.syncCursor()! });

    const doc = new Y.Doc();
    doc.getText("x").insert(0, "spoof");
    const update = Y.encodeStateAsUpdate(doc);
    client.send({
      kind: "begin",
      purpose: "submit-update",
      transferId: 2,
      totalBytes: update.length,
      digest: createHash("sha256").update(update).digest("hex"),
      deliveryId: "del-spoof-1",
      authorContext: {
        kind: "account",
        accountId: scope.userId,
        agent: { agentId: "fake-agent", agentName: "Fake" },
      } satisfies LiveAuthorContext,
    });
    client.send({ kind: "chunk", transferId: 2, offset: 0, bytes: update });
    await client.until(() =>
      client.received.some(
        (frame) =>
          frame.kind === "result" &&
          frame.result === "refused" &&
          frame.reason === "provenance-refused",
      ),
    );
  });

  it("registers the phone socket before redeeming the ticket so mid-upgrade Show on phone off aborts immediately", async () => {
    const f = await memberPhoneFixture();
    const { token, discriminator } = await f.mintMember();
    f.captureNative.mockClear();
    let releaseRedeem!: () => void;
    const redeemEntered = new Promise<void>((resolve) => {
      const originalRedeem = f.phoneTickets.redeem.bind(f.phoneTickets);
      vi.spyOn(f.phoneTickets, "redeem").mockImplementationOnce(async (tok, ctx, sig) => {
        resolve();
        await new Promise<void>((done) => {
          releaseRedeem = done;
        });
        return originalRedeem(tok, ctx, sig);
      });
    });
    const client = f.connectPhone(token, discriminator);
    await redeemEntered;
    f.phoneRoutes.stopPhoneWorkspace(scope.userId, scope.workspaceId);
    releaseRedeem();
    expect(await client.status).toBe(404);
    expect(f.captureNative).not.toHaveBeenCalled();
  });

  it.each(["showOnPhone-off", "grant-revoked", "folder-downgraded"] as const)(
    "closes immediately and refuses an in-flight frame commit on %s",
    async (cause) => {
      let releaseValidation!: () => void;
      let validationEntered!: () => void;
      const inFlight = new Promise<void>((resolve) => {
        validationEntered = resolve;
      });
      const realValidate = createLiveMarkdownJournalValidator(policy);
      const f = await memberPhoneFixture({
        validate: async (input, signal) => {
          validationEntered();
          await new Promise<void>((resolve) => {
            releaseValidation = resolve;
            signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          return realValidate(input);
        },
      });
      const stopObserving = observeRelayWrites(f.storage, (documents) =>
        f.changes.notifyWrite(documents),
      );
      cleanups.push(async () => stopObserving());
      if (cause === "folder-downgraded") {
        f.raw
          .prepare("UPDATE sync_relay_shares SET selector_json=? WHERE share_id=?")
          .run(WORKSPACE_SHARE_SELECTOR_JSON, scope.shareId);
        f.raw
          .prepare(
            "INSERT INTO sync_relay_workspace_memberships (workspace_id,share_id,member_level,workspace_name,created_at_ms) VALUES (?,?,'edit','Workspace',0)",
          )
          .run(scope.workspaceId, scope.shareId);
        f.raw
          .prepare(
            `INSERT INTO sync_relay_workspace_members (member_id,workspace_id,grant_id,user_id,email,role,state,invited_at_ms,joined_at_ms)
            VALUES ('member-1',?,?,?,'r@dohc.test','member','active',0,0)`,
          )
          .run(scope.workspaceId, scope.grantId, scope.userId);
      }

      const { token, discriminator } = await f.mintMember();
      const client = f.connectPhone(token, discriminator);
      expect(await client.status).toBe(101);
      await client.until(() => client.received.some((frame) => frame.kind === "welcome"));

      client.send({ kind: "hello", receivePolicy: frames.receive });
      client.send({
        kind: "credit",
        grantedBytes: frames.maxQueuedBytes,
        grantedFrames: frames.maxQueuedFrames,
      });
      await client.until(() => client.received.some((frame) => frame.kind === "credit"));
      const emptyVec = Y.encodeStateVector(new Y.Doc());
      client.send({
        kind: "begin",
        purpose: "client-vector",
        transferId: 1,
        totalBytes: emptyVec.length,
        digest: createHash("sha256").update(emptyVec).digest("hex"),
      });
      client.send({ kind: "chunk", transferId: 1, offset: 0, bytes: emptyVec });
      await client.until(() => client.syncCursor() !== null);
      client.send({ kind: "sync-applied", appliedThroughJournalCursor: client.syncCursor()! });

      const beforeJournal = (
        f.raw
          .prepare(
            "SELECT COUNT(*) AS count FROM sync_relay_live_update_journal WHERE workspace_id=? AND object_id=?",
          )
          .get(scope.workspaceId, binding.objectId) as { count: number }
      ).count;

      const doc = new Y.Doc();
      doc.getXmlFragment("body").insert(0, [new Y.XmlElement("paragraph")]);
      const update = Y.encodeStateAsUpdate(doc);
      client.send({
        kind: "begin",
        purpose: "submit-update",
        transferId: 2,
        totalBytes: update.length,
        digest: createHash("sha256").update(update).digest("hex"),
        deliveryId: `del-race-${cause}`,
      });
      client.send({ kind: "chunk", transferId: 2, offset: 0, bytes: update });
      await inFlight;

      if (cause === "showOnPhone-off") {
        f.storage.setShowOnPhone({
          userId: scope.userId,
          workspaceId: scope.workspaceId,
          showOnPhone: false,
        });
        f.phoneRoutes.stopPhoneWorkspace(scope.userId, scope.workspaceId);
      } else if (cause === "grant-revoked") {
        expect(
          f.storage.revokeShareGrant({
            shareId: scope.shareId,
            grantId: scope.grantId,
            revokedAtMs: 5000,
          }).ok,
        ).toBe(true);
      } else {
        (f.storage as StorageContext).tx(() =>
          (f.storage as StorageContext).db
            .prepare(
              `INSERT INTO sync_relay_access_rules (workspace_id,folder,rule_text,from_seq,to_seq) VALUES (?,'docs','members: view\n',100,NULL)`,
            )
            .run(scope.workspaceId),
        );
      }
      releaseValidation();
      await client.closed;

      const afterJournal = (
        f.raw
          .prepare(
            "SELECT COUNT(*) AS count FROM sync_relay_live_update_journal WHERE workspace_id=? AND object_id=?",
          )
          .get(scope.workspaceId, binding.objectId) as { count: number }
      ).count;
      expect(afterJournal).toBe(beforeJournal);
    },
  );
});
