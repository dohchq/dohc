import { createServerClient } from "./client";
import type { MemberConsent, PhoneApp } from "./phoneApps";
import { testServer, type Answer } from "./testServer";

// Tests only: published apps, a launch's grant and bootstrap, and a sign-in to a test server.

export const TOKEN = "phone-session-token";
export const A = "a".repeat(64);
export const B = "b".repeat(64);
export const GRANT = "G".repeat(43);
export const HANDOFF = "H".repeat(43);
export const ACTION = `https://${"c".repeat(48)}.apps.example.net/bootstrap`;

type Server = ReturnType<typeof testServer>;

export const version = (
  publicationId: string,
  approved = false,
  appRoot = "events/signup",
  owner = false,
) => ({
  publicationId,
  authorityRevision: 1,
  appRoot,
  sourceRevision: "1".repeat(64),
  approved,
  owner,
  member: null as PhoneApp["member"],
});

/** A Member app as the phone reads it, with the fields the relay lists it under. */
export const memberVersion = (
  publicationId: string,
  consent: MemberConsent = "none",
  approved = false,
) => ({
  ...version(publicationId, approved, "app"),
  member: { name: "tracker", author: "Ana", consent },
});
const listed = ({ owner, ...app }: ReturnType<typeof version>) =>
  app.member
    ? {
        ...app,
        member: undefined,
        name: app.member.name,
        author: { name: app.member.author },
        consent: app.member.consent,
      }
    : { ...app, member: undefined, ...(owner ? { audience: "owner" } : {}) };

export const page = (
  apps: ReturnType<typeof version>[],
  nextCursor: string | null = null,
): Answer => ({
  status: 200,
  body: { ok: true, result: { apps: apps.map(listed), nextCursor } },
});

export const memberPage = (
  apps: ReturnType<typeof version>[],
  nextCursor: string | null = null,
): Answer => ({
  status: 200,
  body: { ok: true, result: { memberApps: apps.map(listed), nextCursor } },
});

/** A test server with no Member apps unless the test lists some. */
export function appServer() {
  const server = testServer();
  server.on("POST", "/sync/ws-1/ops/memberApps", memberPage([]));
  return server;
}

export const grantAnswer: Answer = {
  status: 200,
  body: { ok: true, result: { grant: GRANT, expiresAtMs: 30_000 } },
};

/** Answers a launch's grant and share-web's bootstrap. */
export function answerLaunch(server: Server) {
  server.on("POST", "/sync/ws-1/ops/appLaunch", grantAnswer);
  server.on("POST", "/api/apps/phone-launch", {
    status: 200,
    body: { action: ACTION, handoff: HANDOFF },
  });
}

export const signedIn = (server: Server, isCurrent = () => true) => ({
  client: createServerClient({
    origin: server.origin,
    token: TOKEN,
    fetch: server.fetch,
    signal: new AbortController().signal,
  }),
  isCurrent,
  origin: server.origin,
  userId: "u-1",
});
