import { SIGN_UP_INVITE_KEY_HEADER } from "@dohc/workspace-auth/signUp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSignUpAdmission } from "./signUpAdmission";

const KEY = "derived-sign-up-key";
const RELAY = "http://sync-relay:1788";

afterEach(() => vi.restoreAllMocks());

/** A relay stand-in that knows one pending invite and records what it was asked. */
function relay(invites: string[]) {
  const asked: Array<{ url: string; key: string | null; email: unknown }> = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const { email } = JSON.parse(String(init?.body)) as { email: unknown };
    asked.push({ url: String(input), key: headers.get(SIGN_UP_INVITE_KEY_HEADER), email });
    return Response.json({ invited: typeof email === "string" && invites.includes(email) });
  });
  return { asked, fetch: fetch as unknown as typeof globalThis.fetch };
}

function admission(fetch: typeof globalThis.fetch, emails = ["owner@example.com"]) {
  return createSignUpAdmission({ emails: new Set(emails), relayUrl: RELAY, key: KEY, fetch });
}

describe("closed sign-up", () => {
  it("admits a listed address without asking the relay, whatever its case or whitespace", async () => {
    const { asked, fetch } = relay([]);
    const admit = admission(fetch);
    expect(await admit("owner@example.com")).toBe("admitted");
    expect(await admit("  Owner@EXAMPLE.com\t")).toBe("admitted");
    expect(asked).toEqual([]);
  });

  it("admits an address with a pending invite, asking the relay with the key and the normalized address", async () => {
    const { asked, fetch } = relay(["guest@example.com"]);
    expect(await admission(fetch)(" Guest@Example.com ")).toBe("admitted");
    expect(asked).toEqual([{ url: `${RELAY}/internal/sign-up-invite`, key: KEY, email: "guest@example.com" }]);
  });

  it("refuses an address that is neither listed nor invited", async () => {
    const { fetch } = relay(["guest@example.com"]);
    expect(await admission(fetch)("stranger@example.com")).toBe("refused");
  });

  it("reports the check as unavailable when the relay fails or does not answer", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = [
      async () => new Response("not found", { status: 404 }),
      // A relay that retired its storage answers every request this way.
      async () => Response.json({ ok: false, error: "service unavailable" }, { status: 503 }),
      async () => Response.json({ invited: "yes" }),
      async () => {
        throw new TypeError("fetch failed");
      },
    ];
    for (const fetch of failing) {
      expect(await admission(fetch as unknown as typeof globalThis.fetch)("stranger@example.com")).toBe("unavailable");
    }
  });
});
