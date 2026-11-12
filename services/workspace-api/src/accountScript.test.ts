import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { ACCOUNT_JS } from "./assets";

const TOKEN = "AbCdEfGhIjKlMnOpQrStUv";

// Run the sign-up page script against a minimal page and return the headers of the sign-up request.
async function signUpHeaders(next: string, stored: string | null, storageThrows = false) {
  let submit: ((event: { preventDefault(): void }) => Promise<void>) | null = null;
  const input = (value: string) => ({ value });
  const elements: Record<string, unknown> = {
    form: {
      querySelector: () => ({ disabled: false }),
      addEventListener: (_: string, handler: typeof submit) => { submit = handler; },
    },
    name: input("Ada"),
    email: input("ada@example.test"),
    password: input("correct horse battery staple"),
    status: { className: "", textContent: "" },
  };
  const requests: { path: string; headers: Record<string, string> }[] = [];
  runInNewContext(ACCOUNT_JS, {
    document: { body: { dataset: { page: "sign-up", next } }, getElementById: (id: string) => elements[id] ?? null },
    location: { host: "server.example.test", assign: () => {} },
    sessionStorage: {
      getItem: (key: string) => {
        if (storageThrows) throw new Error("blocked");
        return key === "dohc.join.token" ? stored : null;
      },
    },
    fetch: async (path: string, init: { headers: Record<string, string> }) => {
      requests.push({ path, headers: init.headers });
      return { ok: true, json: async () => ({}) };
    },
    AbortSignal,
    crypto,
    encodeURIComponent,
  });
  await submit!({ preventDefault() {} });
  expect(requests.map(({ path }) => path)).toEqual(["/api/auth/sign-up/email"]);
  return requests[0]!.headers;
}

describe("sign-up page", () => {
  it("sends the invite link token when the person came from the join page", async () => {
    expect(await signUpHeaders("/join", TOKEN)).toEqual({ "content-type": "application/json", "x-dohc-invite-link": TOKEN });
  });

  it("sends no token for other pages, malformed tokens, or blocked storage", async () => {
    const plain = { "content-type": "application/json" };
    expect(await signUpHeaders("/account", TOKEN)).toEqual(plain);
    expect(await signUpHeaders("/joined", TOKEN)).toEqual(plain);
    expect(await signUpHeaders("//join", TOKEN)).toEqual(plain);
    expect(await signUpHeaders("/join", "short")).toEqual(plain);
    expect(await signUpHeaders("/join", `${TOKEN}!`)).toEqual(plain);
    expect(await signUpHeaders("/join", null)).toEqual(plain);
    expect(await signUpHeaders("/join", TOKEN, true)).toEqual(plain);
  });
});
