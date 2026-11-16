import { afterEach, expect, it, vi } from "vitest";
import type { WorkspaceAuth } from "@dohc/workspace-auth/betterAuth";
import {
  createAccountSessionResolver,
  createPhoneCapableAccountSessionResolver,
  createSessionActorResolver,
  type AccountSessions,
  type SessionKind,
} from "@dohc/workspace-auth/session";
import type { RelayDatasetHost } from "./datasetHost";
import { claimWorkspace, closeTestStorages, testHandler, testStorage } from "./testing";

afterEach(() => {
  vi.restoreAllMocks();
  return closeTestStorages();
});

const KINDS: Record<string, SessionKind> = { user: "desktop", phone: "phone", browser: "browser" };

// Better Auth as the relay sees it: `Bearer <user|phone|browser>:<id>` is that
// account's desktop, phone or browser sign-in. The resolvers under test are the
// production ones, so the relay judges each kind exactly as it does in production.
const auth = {
  api: {
    getSession: async ({ headers }: { headers: Headers }) => {
      const match = /^Bearer (user|phone|browser):([\w-]+)$/u.exec(
        headers.get("authorization") ?? "",
      );
      const clientKind = match ? KINDS[match[1]!] : undefined;
      if (!match || !clientKind) return null;
      return {
        user: { id: match[2]! },
        session: {
          id: `${match[1]}-session-${match[2]}`,
          userId: match[2]!,
          expiresAt: 8_000_000_000_000,
          clientKind,
        },
      };
    },
  },
} as unknown as WorkspaceAuth;

// Any use of the dataset host fails, so a route that reaches it answers 500, never 401.
const unreachableDatasetHost = new Proxy(
  {},
  {
    get: (_target, key) =>
      key === "then"
        ? undefined
        : () => {
            throw new Error("The dataset host was reached.");
          },
  },
) as unknown as RelayDatasetHost;

// Each account's three sign-ins, so the session list finds the caller's own session.
const sessions: AccountSessions = {
  list: async (userId) =>
    ["user", "phone", "browser"].map((kind) => ({
      sessionId: `${kind}-session-${userId}`,
      createdAtMs: 0,
      userAgent: null,
    })),
  revoke: async () => true,
  phoneSessionIsCurrent: async () => true,
  read: async () => new Map(),
};

async function relay() {
  const storage = await testStorage();
  const h = testHandler(storage, {
    resolveActor: createSessionActorResolver(auth),
    resolveAccountSession: createAccountSessionResolver(auth),
    resolvePhoneCapableAccountSession: createPhoneCapableAccountSessionResolver(auth),
    accountSessions: sessions,
    datasetHost: unreachableDatasetHost,
  });
  await claimWorkspace(h, "ana", "trip");
  return h;
}

function call(
  h: Awaited<ReturnType<typeof relay>>,
  credential: string,
  [method, path, body]: readonly [string, string, unknown?],
): Promise<Response> {
  return h(
    new Request(`http://relay.test${path}`, {
      method,
      headers: {
        authorization: `Bearer ${credential}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

const PUBLICATION = "a".repeat(64);
const DATASET = "00000000-0000-4000-8000-000000000000";
const WAKE = `wake-${"0".repeat(32)}`;

it("refuses the owner's phone on every workspace route, as if it had no sign-in", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const h = await relay();
  const routes = [
    ["GET", "/sync/trip/log"],
    ["GET", "/sync/trip/datasets"],
    ["POST", `/sync/trip/datasets/${DATASET}/binding`, {}],
    ["POST", "/sync/trip/app-publications", {}],
    ["POST", `/sync/trip/app-publications/${PUBLICATION}/withdraw`, {}],
    ["POST", `/sync/trip/app-publications/${PUBLICATION}/reactivate`, {}],
    ["POST", `/sync/trip/app-publications/${PUBLICATION}/backend/invoke`, {}],
    ["GET", "/sync/trip/automation-presses"],
    ["POST", "/sync/trip/automation-presses/accept", {}],
    ["GET", "/sync/trip/held-documents"],
    ["PUT", "/sync/workspaces/trip/name", { name: "Trip" }],
    // The owner's computers' wake routes: the phone reads wakes through its operations route.
    ["GET", "/sync/wakes"],
    ["POST", `/sync/wakes/${WAKE}/claim`, {}],
    ["POST", `/sync/wakes/${WAKE}/queued`, {}],
    ["PUT", "/sync/workspaces/trip/runners", { installId: "i", computerLabel: "c", runners: [] }],
  ] as const;
  for (const route of routes) {
    const label = `${route[0]} ${route[1]}`;
    const phone = await call(h, "phone:ana", route);
    const signedOut = await call(h, "nobody:ana", route);
    expect({ status: phone.status, body: await phone.text() }, label).toEqual({
      status: signedOut.status,
      body: await signedOut.text(),
    });
    expect(phone.status, label).toBe(401);
    // The same account's computer and browser get past sign-in on the same route.
    for (const credential of ["user:ana", "browser:ana"])
      expect((await call(h, credential, route)).status, `${label} as ${credential}`).not.toBe(401);
  }
});

it("still answers the owner's phone on every relay route the phone calls", async () => {
  const h = await relay();
  // `apps/mobile/src/server` calls these; personal agents are covered in personalAgents.test.ts.
  const routes = [
    ["GET", "/sync/account/workspaces"],
    ["PATCH", "/sync/account/workspaces/trip", { showOnPhone: true }],
    ["GET", "/sync/account/sessions"],
    ["POST", "/sync/account/sessions/other-session/revoke"],
    ["GET", "/sync/notices?scope=phone&limit=50"],
    ["POST", "/sync/notices/marks?scope=phone", { marks: [] }],
    ["POST", "/sync/trip/ops/listFiles", {}],
    ["POST", "/sync/trip/ops/markRead", {}],
    ["GET", "/sync/trip/ops/changes?since=0"],
    ["POST", "/sync/trip/ops/chatContext", {}],
    ["GET", "/sync/trip/ops/wakeChanges?since=0"],
    ["POST", "/sync/trip/ops/retryWake", {}],
    ["GET", "/sync/personal-agents"],
  ] as const;
  for (const route of routes) {
    const label = `${route[0]} ${route[1]}`;
    const phone = await call(h, "phone:ana", route);
    const desktop = await call(h, "user:ana", route);
    const signedOut = await call(h, "nobody:ana", route);
    expect(phone.status, label).not.toBe(401);
    expect(phone.status, label).toBe(desktop.status);
    expect(signedOut.status, label).toBe(401);
  }
});
