import { SIGN_UP_INVITE_KEY_HEADER, SIGN_UP_INVITE_PATH } from "@dohc/workspace-auth/signUp";
import { afterEach, describe, expect, it } from "vitest";
import { createSignUpInviteRoute } from "./signUpInviteRoute";
import { claimWorkspace, closeTestStorages, createShare, testHandler, testStorage } from "./testing";

afterEach(closeTestStorages);

const KEY = "derived-sign-up-key";
const OWNER = "owner";
const WORKSPACE = "workspace-a";

async function relay() {
  const storage = await testStorage();
  const h = testHandler(storage);
  await claimWorkspace(h, OWNER, WORKSPACE);
  return { storage, h, route: createSignUpInviteRoute({ storage, key: KEY }) };
}

function ask(route: (request: Request) => Promise<Response>, email: unknown, key: string | null = KEY): Promise<Response> {
  return route(
    new Request(`http://sync-relay:1788${SIGN_UP_INVITE_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(key === null ? {} : { [SIGN_UP_INVITE_KEY_HEADER]: key }) },
      body: JSON.stringify({ email }),
    }),
  );
}

async function invited(route: (request: Request) => Promise<Response>, email: string): Promise<unknown> {
  const response = await ask(route, email);
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

  it("refuses a body without an address", async () => {
    const { route } = await relay();
    for (const email of [undefined, 42, "   ", "a".repeat(321)]) {
      expect((await ask(route, email)).status).toBe(400);
    }
  });
});
