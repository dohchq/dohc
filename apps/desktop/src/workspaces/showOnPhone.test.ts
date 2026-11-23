import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createShowOnPhone,
  SHOW_ON_PHONE_REFRESH_MS,
  type ShowOnPhoneSession,
} from "./showOnPhone";

function server(answer: () => Response | Promise<Response>) {
  const requests: Request[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(new Request(input, init));
    return await answer();
  });
  return { fetch, requests };
}

const listing = (rows: Array<{ workspaceId: string; showOnPhone: boolean }>) =>
  Response.json({
    ok: true,
    workspaces: rows.map((row) => ({ ...row, name: null, canOpen: true })),
  });

function setup(answer: () => Response | Promise<Response>) {
  const relay = server(answer);
  let session: ShowOnPhoneSession | null = {
    generation: 1,
    relay: { baseUrl: "https://relay.test/", token: "token-1", fetch: relay.fetch },
    unauthorized: vi.fn(async () => undefined),
  };
  const errors: unknown[] = [];
  const showOnPhone = createShowOnPhone({
    session: async () => session,
    onError: (_message, error) => errors.push(error),
  });
  return {
    showOnPhone,
    relay,
    errors,
    session: () => session,
    setSession: (next: ShowOnPhoneSession | null) => {
      session = next;
    },
  };
}

describe("Show on phone", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("reads the account's workspaces once, with the session's bearer", async () => {
    const { showOnPhone, relay } = setup(() =>
      listing([
        { workspaceId: "shown", showOnPhone: true },
        { workspaceId: "hidden", showOnPhone: false },
      ]),
    );
    const answers = await Promise.all([
      showOnPhone.shows("shown"),
      showOnPhone.shows("hidden"),
      showOnPhone.shows("not-owned"),
    ]);
    expect(answers).toEqual([true, false, false]);
    expect(relay.requests).toHaveLength(1);
    expect(relay.requests[0]!.method).toBe("GET");
    expect(relay.requests[0]!.url).toBe("https://relay.test/sync/account/workspaces");
    expect(relay.requests[0]!.headers.get("authorization")).toBe("Bearer token-1");
  });

  it("reads again once the last read is a few minutes old", async () => {
    let shown = true;
    const { showOnPhone, relay } = setup(() => listing([{ workspaceId: "w", showOnPhone: shown }]));
    expect(await showOnPhone.shows("w")).toBe(true);
    shown = false;
    vi.advanceTimersByTime(SHOW_ON_PHONE_REFRESH_MS - 1);
    expect(await showOnPhone.shows("w")).toBe(true);
    vi.advanceTimersByTime(1);
    expect(await showOnPhone.shows("w")).toBe(false);
    expect(relay.requests).toHaveLength(2);
  });

  it("reads again when the account's session changes, and answers no when signed out", async () => {
    const { showOnPhone, relay, session, setSession } = setup(() =>
      listing([{ workspaceId: "w", showOnPhone: true }]),
    );
    expect(await showOnPhone.shows("w")).toBe(true);
    setSession({ ...session()!, generation: 2 });
    expect(await showOnPhone.shows("w")).toBe(true);
    expect(relay.requests).toHaveLength(2);
    setSession(null);
    expect(await showOnPhone.shows("w")).toBe(false);
    expect(relay.requests).toHaveLength(2);
  });

  it("confirms nothing when the read fails, and doesn't ask again until the next refresh", async () => {
    const { showOnPhone, relay, errors } = setup(() => new Response("down", { status: 503 }));
    expect(await showOnPhone.shows("w")).toBe(false);
    expect(await showOnPhone.shows("w")).toBe(false);
    expect(relay.requests).toHaveLength(1);
    expect(errors).toHaveLength(1);
  });

  it("confirms nothing from an answer of the wrong shape", async () => {
    const { showOnPhone, errors } = setup(() => Response.json({ ok: true, workspaces: [{}] }));
    expect(await showOnPhone.shows("w")).toBe(false);
    expect(errors).toHaveLength(1);
  });

  it("hands an expired session to the sign-in handling", async () => {
    const { showOnPhone, session, errors } = setup(() => new Response(null, { status: 401 }));
    expect(await showOnPhone.shows("w")).toBe(false);
    expect(session()!.unauthorized).toHaveBeenCalledOnce();
    expect(errors).toEqual([]);
  });
});
