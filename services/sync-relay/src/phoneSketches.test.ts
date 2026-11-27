import { afterEach, describe, expect, it } from "vitest";
import {
  UnauthorizedError,
  type AccountSession,
  type ResolveAccountSession,
} from "@dohc/workspace-auth/session";
import { DaemonRefusalError, type EngineTransport } from "@dohc/workspace-engine-client";
import type { EngineClient } from "@dohc/workspace-engine-client/daemon";
import { VersionedLoopbackEngine } from "@dohc/workspace-engine-client/testing";
import type { AutomationReplica } from "./automationReplicas";
import { isAllowedSketchPath, SAVE_SKETCH_MAX_BODY_BYTES } from "./phoneSketches";
import { startServerCopies } from "./serverCopies";
import type { SyncRelayStorage } from "./storage";
import { closeTestStorages, denialBytes, json, testHandler, testStorage } from "./testing";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
  await closeTestStorages();
});

const resolveAccountSession: ResolveAccountSession = async (request) => {
  const match = /^Bearer session:([\w-]+):([\w-]+)$/u.exec(
    request.headers.get("authorization") ?? "",
  );
  if (!match) throw new UnauthorizedError();
  return {
    userId: match[1]!,
    sessionId: match[2]!,
    expiresAtMs: Number.MAX_SAFE_INTEGER,
    clientKind: "phone",
  } satisfies AccountSession;
};

const signedIn = (userId: string, sessionId = "phone") => ({
  authorization: `Bearer session:${userId}:${sessionId}`,
});

function op(
  workspaceId: string,
  operation: string,
  args: unknown = {},
  headers: Record<string, string> = signedIn("ana"),
): Request {
  return new Request(`http://relay.test/sync/${encodeURIComponent(workspaceId)}/ops/${operation}`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: typeof args === "string" ? args : JSON.stringify(args),
  });
}

async function setup(options: { copies?: boolean; conflictOpen?: boolean } = {}) {
  const storage = await testStorage();
  storage.claimWorkspace({ workspaceId: "trip", ownerUserId: "ana", createdAtMs: 1 });
  storage.claimWorkspaceIdentity({
    workspaceId: "trip",
    replicationEpoch: "epoch",
    streamIdentity: "stream",
  });
  const files = new VersionedLoopbackEngine();
  const engine: EngineTransport = {
    onEvent: () => () => undefined,
    sendRequest: (request) => {
      if (options.conflictOpen && request.method === "ydoc.open") {
        return Promise.reject(
          new DaemonRefusalError(
            { code: "INVALID_PARAMS", message: "ydoc-conflict-open", retry: "no" },
            new Error("ydoc-conflict-open"),
          ),
        );
      }
      return files.sendRequest(request);
    },
  };
  let requestId = 0;
  const lifetime = new AbortController();
  const syncs: string[] = [];
  const copies = await startServerCopies({
    storage,
    root: "unused",
    engineExecutable: "unused",
    relayOrigin: "https://relay.example.test",
    key: new Uint8Array(32),
    namespace: "test",
    startReplicas: async (hooks) => {
      const open = new Map<string, AutomationReplica>();
      const pass = () => {
        for (const [workspaceId, reasons] of hooks.wanted()) {
          const row = storage.joinAutomationWorkspace({ workspaceId, nowMs: 1, reasons });
          if (!row || open.has(workspaceId)) continue;
          open.set(workspaceId, {
            workspaceId,
            ownerUserId: row.ownerUserId,
            incarnation: row.incarnation,
            reasons: row.reasons,
            startedAtMs: 1,
            pulledHead: storage.automationWorkspaceLogHead(workspaceId),
            root: "unused",
            metadataDir: "unused",
            client: engine as unknown as EngineClient,
            workspace: workspaceId,
            signal: lifetime.signal,
            nextRequestId: () => ++requestId,
            withRecordWork: <T>(work: () => Promise<T>) => work(),
            busy: () => false,
            step: async () => true,
            sync: async () => {
              syncs.push(workspaceId);
            },
          });
          hooks.onChanged?.(workspaceId);
        }
      };
      return {
        unavailable: false,
        replica: (id) => open.get(id),
        reconcile: () => queueMicrotask(pass),
        deleteWorkspaces: async () => undefined,
        failedSyncs: () => new Map(),
        settled: async () => undefined,
        close: async () => undefined,
      };
    },
  });
  cleanup.push(async () => {
    lifetime.abort();
    await copies.close();
  });
  const h = testHandler(storage, {
    resolveAccountSession,
    resolvePhoneCapableAccountSession: resolveAccountSession,
    serverCopies: () => (options.copies === false ? undefined : copies),
  });
  return { storage, files, h, syncs };
}

function inviteJoined(
  storage: SyncRelayStorage,
  userId: string,
  role: "member" | "admin" = "member",
) {
  expect(
    storage.inviteWorkspaceMember({
      workspaceId: "trip",
      actorUserId: "ana",
      workspaceName: "Trip",
      email: `${userId}@dohc.test`,
      recipientUserId: userId,
      newMemberId: () => `member-${userId}`,
      newGrantId: () => `grant-${userId}`,
      newShareId: () => `share-trip-${userId}`,
      nowMs: 1,
    }),
  ).toMatchObject({ ok: true });
  if (role === "admin") {
    expect(
      storage.setWorkspaceMemberRole({
        workspaceId: "trip",
        actorUserId: "ana",
        memberId: `member-${userId}`,
        role: "admin",
      }),
    ).toMatchObject({ ok: true });
  }
}

describe("isAllowedSketchPath", () => {
  it("allows normalized visible .excalidraw paths and refuses everything else", () => {
    expect(isAllowedSketchPath("Untitled.excalidraw")).toBe(true);
    expect(isAllowedSketchPath("notes/diagram.excalidraw")).toBe(true);
    for (const bad of [
      "",
      "notes/plan.md",
      "collection.yaml",
      "dataset.json",
      ".env",
      ".git/internal.excalidraw",
      ".dohc/internal.excalidraw",
      "node_modules/pkg/a.excalidraw",
      "a/../b.excalidraw",
      "/abs.excalidraw",
      "notes/.excalidraw",
      `${"a".repeat(2049)}.excalidraw`,
    ]) {
      expect(isAllowedSketchPath(bad), bad).toBe(false);
    }
  });
});

describe("owner-only sketch ops inside /ops/*", () => {
  it("returns 404 to joined Members and Admins before reading the request body", async () => {
    const { storage, h, syncs } = await setup();
    inviteJoined(storage, "ben", "member");
    inviteJoined(storage, "cara", "admin");
    const missing = await denialBytes(
      await h(op("nowhere", "readSketch", { path: "a.excalidraw" })),
    );

    for (const user of ["ben", "cara"] as const) {
      for (const [operation, args] of [
        ["readSketch", { path: "a.excalidraw" }],
        ["createSketch", { path: "a.excalidraw", requestId: "req-1" }],
        [
          "saveSketch",
          { path: "a.excalidraw", objectId: "obj-1", requestId: "req-2", elements: [] },
        ],
      ] as const) {
        let pulled = false;
        const unread = new Request(`http://relay.test/sync/trip/ops/${operation}`, {
          method: "POST",
          headers: { ...signedIn(user), "content-type": "application/json" },
          duplex: "half",
          body: new ReadableStream(
            {
              pull(controller) {
                pulled = true;
                controller.enqueue(new TextEncoder().encode(JSON.stringify(args)));
                controller.close();
              },
            },
            { highWaterMark: 0 },
          ),
        } as RequestInit & { duplex: "half" });
        expect(await denialBytes(await h(unread)), `${user}:${operation}`).toBe(missing);
        expect(pulled, `${user}:${operation} body should stay unread`).toBe(false);
      }
    }
    expect(syncs).toEqual([]);
  });

  it("keeps the 256 KiB global /ops/* limit while allowing up to 4 MiB strictly on saveSketch", async () => {
    const { h } = await setup();
    const mediumPayload = "x".repeat(300 * 1024);

    for (const [operation, args] of [
      ["documentRead", { path: mediumPayload }],
      ["readSketch", { path: mediumPayload }],
      ["createSketch", { path: `${mediumPayload}.excalidraw`, requestId: "req-1" }],
    ] as const) {
      const response = await h(op("trip", operation, args));
      expect(response.status, operation).toBe(413);
    }

    const mediumSave = await h(
      op("trip", "saveSketch", {
        path: "plan.md",
        objectId: "obj-1",
        requestId: "req-medium",
        elements: [{ id: "el-1", type: "text", text: mediumPayload }],
      }),
    );
    expect(mediumSave.status).toBe(200);
    expect(await json(mediumSave)).toMatchObject({
      ok: true,
      result: { ok: false, refusal: "missing" },
    });

    const oversizedSave = await h(
      op("trip", "saveSketch", {
        path: "map.excalidraw",
        objectId: "obj-1",
        requestId: "req-huge",
        elements: [
          { id: "el-1", type: "text", text: "y".repeat(SAVE_SKETCH_MAX_BODY_BYTES + 1024) },
        ],
      }),
    );
    expect(oversizedSave.status).toBe(413);
  });

  it("answers 503 server_busy to owners and 404 to joined Members when server copies are unavailable", async () => {
    const { storage, h } = await setup({ copies: false });
    inviteJoined(storage, "ben", "member");
    inviteJoined(storage, "cara", "admin");
    const missing = await denialBytes(
      await h(op("nowhere", "readSketch", { path: "a.excalidraw" })),
    );
    for (const [operation, args] of [
      ["readSketch", { path: "a.excalidraw" }],
      ["createSketch", { path: "a.excalidraw", requestId: "req-1" }],
      ["saveSketch", { path: "a.excalidraw", objectId: "obj-1", requestId: "req-2", elements: [] }],
    ] as const) {
      const response = await h(op("trip", operation, args));
      expect(response.status, operation).toBe(503);
      expect(await json(response)).toMatchObject({ ok: false, code: "server_busy" });
      for (const user of ["ben", "cara"] as const) {
        expect(await denialBytes(await h(op("trip", operation, args, signedIn(user))))).toBe(
          missing,
        );
      }
    }
  });

  it("validates operation arguments strictly and hides disallowed paths on read/save", async () => {
    const { h, syncs } = await setup();
    for (const [operation, args] of [
      ["readSketch", { path: "a.excalidraw", extra: 1 }],
      ["createSketch", { path: "a.md", requestId: "req-1" }],
      ["createSketch", { path: ".env", requestId: "req-1" }],
      ["createSketch", { path: "a.excalidraw", requestId: "" }],
      ["saveSketch", { path: "a.excalidraw", objectId: "", requestId: "req-1", elements: [] }],
      [
        "saveSketch",
        {
          path: "a.excalidraw",
          objectId: "obj-1",
          requestId: "req-1",
          elements: [],
          appState: { viewBackgroundColor: "#336600" },
        },
      ],
    ] as const) {
      const response = await h(op("trip", operation, args));
      expect(response.status, `${operation}:${JSON.stringify(args)}`).toBe(400);
      expect((await json(response)).code).toBe("bad_request");
    }

    for (const [operation, args] of [
      ["readSketch", { path: ".env" }],
      ["readSketch", { path: "notes/plan.md" }],
      [
        "saveSketch",
        { path: ".dohc/secret.excalidraw", objectId: "obj-1", requestId: "req-1", elements: [] },
      ],
    ] as const) {
      const response = await h(op("trip", operation, args));
      expect(response.status, operation).toBe(200);
      expect(await json(response)).toMatchObject({
        ok: true,
        result: { ok: false, refusal: "missing" },
      });
    }
    expect(syncs).toEqual([]);
  });

  it("falls back to portable read instead of HTTP 500 when ydoc.open reports ydoc-conflict-open", async () => {
    const { files, h } = await setup({ conflictOpen: true });
    files.seedTextFile({
      workspace: "trip",
      path: "Conflicted.excalidraw",
      text: JSON.stringify({ type: "excalidraw", version: 2, elements: null, appState: null }),
      objectId: "object-conflicted",
    });
    const response = await h(op("trip", "readSketch", { path: "Conflicted.excalidraw" }));
    expect(response.status).toBe(200);
    expect(await json(response)).toMatchObject({
      ok: true,
      result: { ok: true, path: "Conflicted.excalidraw", elements: [], appState: {}, files: {} },
    });
  });
});
