import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SIGN_UP_INVITE_KEY_HEADER, SIGN_UP_INVITE_PATH } from "@dohc/workspace-auth/signUp";
import { afterEach, describe, expect, it } from "vitest";
import { createSignUpInviteRoute } from "./signUpInviteRoute";
import { openSyncRelayStorage } from "./storage";
import { RelayWriteOwner } from "./storage/writeOwner";
import { claimWorkspace, closeTestStorages, createShare, json, jsonBody, LINK_KEY, request, SHARE_WEB_ORIGIN, tempRoot, testHandler, testStorage } from "./testing";

afterEach(closeTestStorages);

const KEY = "derived-sign-up-key";
const OWNER = "owner";
const WORKSPACE = "workspace-a";

async function relay() {
  const storage = await testStorage();
  const h = testHandler(storage);
  await claimWorkspace(h, OWNER, WORKSPACE);
  return { storage, h, route: createSignUpInviteRoute({ storage, key: KEY, inviteLinkKey: LINK_KEY }) };
}

function ask(route: (request: Request) => Promise<Response>, email: unknown, key: string | null = KEY, extra: Record<string, unknown> = {}): Promise<Response> {
  return route(
    new Request(`http://sync-relay:1788${SIGN_UP_INVITE_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(key === null ? {} : { [SIGN_UP_INVITE_KEY_HEADER]: key }) },
      body: JSON.stringify({ email, ...extra }),
    }),
  );
}

async function invited(route: (request: Request) => Promise<Response>, email: string, inviteToken?: string): Promise<unknown> {
  const response = await ask(route, email, KEY, inviteToken === undefined ? {} : { inviteToken });
  expect(response.status).toBe(200);
  return ((await response.json()) as { invited: unknown }).invited;
}

describe("sign-up invite check", () => {
  it("confirms a pending invite whatever the case or surrounding whitespace", async () => {
    const { h, route } = await relay();
    await createShare(h, OWNER, WORKSPACE, { recipientEmail: "Late@Corp.Example", paths: ["docs"] });

    expect(await invited(route, "late@corp.example")).toBe(true);
    expect(await invited(route, "  LATE@corp.example \n")).toBe(true);
    expect(await invited(route, "stranger@corp.example")).toBe(false);
  });

  it("stops confirming an invite once it is revoked or claimed", async () => {
    const { storage, h, route } = await relay();
    const revoked = await createShare(h, OWNER, WORKSPACE, { recipientEmail: "revoked@corp.example", paths: ["docs"] });
    await createShare(h, OWNER, WORKSPACE, { recipientEmail: "claimed@corp.example", paths: ["docs"] });

    expect(storage.revokeShare(revoked, 3_000)).toBe(true);
    expect(storage.claimPendingSharesForEmail("claimed@corp.example", "claimed-user")).toBe(1);

    expect(await invited(route, "revoked@corp.example")).toBe(false);
    expect(await invited(route, "claimed@corp.example")).toBe(false);
  });

  it("answers a caller without the key as an unknown route", async () => {
    const { h, route } = await relay();
    await createShare(h, OWNER, WORKSPACE, { recipientEmail: "late@corp.example", paths: ["docs"] });

    for (const key of [null, "wrong-key", `${KEY}x`]) {
      const response = await ask(route, "late@corp.example", key);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ ok: false, error: "not found" });
    }
    const get = await route(new Request(`http://sync-relay:1788${SIGN_UP_INVITE_PATH}`, { headers: { [SIGN_UP_INVITE_KEY_HEADER]: KEY } }));
    expect(get.status).toBe(404);
  });

  it("answers 503 instead of an invite once the relay retires its storage", async () => {
    let owner!: RelayWriteOwner;
    const path = join(await tempRoot("db"), "relay.sqlite");
    new DatabaseSync(path).close();
    const storage = openSyncRelayStorage(path, {}, (db) => (owner = new RelayWriteOwner(db)));
    try {
      const h = testHandler(storage);
      await claimWorkspace(h, OWNER, WORKSPACE);
      await createShare(h, OWNER, WORKSPACE, { recipientEmail: "late@corp.example", paths: ["docs"] });
      const route = createSignUpInviteRoute({ storage, key: KEY, inviteLinkKey: LINK_KEY });
      expect(await invited(route, "late@corp.example")).toBe(true);

      owner.invalidate();
      const response = await ask(route, "late@corp.example");
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ ok: false, error: "service unavailable" });
    } finally {
      storage.close();
    }
  });

  it("refuses a body without an address", async () => {
    const { route } = await relay();
    for (const email of [undefined, 42, "   ", "a".repeat(321)]) {
      expect((await ask(route, email)).status).toBe(400);
    }
  });

  describe("through a workspace invite link", () => {
    async function inviteLink(h: ReturnType<typeof testHandler>, action: string): Promise<string | null> {
      const response = await h(request(OWNER, `/sync/${WORKSPACE}/members/invite-link`, jsonBody({ action, workspaceName: "Community" })));
      expect(response.status, await response.clone().text()).toBe(200);
      const url = ((await json(response)).inviteLink as { url: string | null }).url;
      return url === null ? null : url.slice(`${SHARE_WEB_ORIGIN}/join#`.length);
    }

    it("admits any address that presents a link that is turned on", async () => {
      const { h, route } = await relay();
      const token = (await inviteLink(h, "turn-on"))!;
      expect(await invited(route, "newcomer@corp.example", token)).toBe(true);
      expect(await invited(route, "newcomer@corp.example")).toBe(false);
      expect(await invited(route, "newcomer@corp.example", `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`)).toBe(false);
      expect(await invited(route, "newcomer@corp.example", "short")).toBe(false);
    });

    it("stops admitting once the link is turned off or reset", async () => {
      const { h, route } = await relay();
      const first = (await inviteLink(h, "turn-on"))!;
      const second = (await inviteLink(h, "reset"))!;
      expect(await invited(route, "newcomer@corp.example", first)).toBe(false);
      expect(await invited(route, "newcomer@corp.example", second)).toBe(true);
      await inviteLink(h, "turn-off");
      expect(await invited(route, "newcomer@corp.example", second)).toBe(false);
    });

    it("admits nobody through a link while invite-link sign-up is off", async () => {
      const { storage, h } = await relay();
      const token = (await inviteLink(h, "turn-on"))!;
      const off = createSignUpInviteRoute({ storage, key: KEY, inviteLinkKey: null });
      expect(await invited(off, "newcomer@corp.example", token)).toBe(false);
    });

    it("refuses a token that is not a string", async () => {
      const { route } = await relay();
      expect((await ask(route, "newcomer@corp.example", KEY, { inviteToken: 42 })).status).toBe(400);
    });
  });
});
