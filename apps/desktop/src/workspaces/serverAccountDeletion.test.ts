import { describe, expect, it, vi } from "vitest";
import { serverAccountOperations } from "../ipc/bridgeContract";
import { registerServerAccountIpc } from "../ipc/serverAccountIpc";
import type { CloudCredentials } from "./cloudCredentialStore";
import { createServerAccountDeletion } from "./serverAccountDeletion";

const credentials: CloudCredentials = {
  serverUrl: "https://account.example.test", relayUrl: "https://relay.example.test", serverName: "Example",
  token: "session-token", userId: "member", email: "member@example.test",
};
const scope = {
  email: credentials.email, serverOrigin: credentials.serverUrl, workspaceIds: ["ws-elsewhere", "ws-notes", "ws-trip"],
  workspaceCount: 3, ownedShareCount: 2, heldGrantCount: 1, storedBytes: 5 * 1024 * 1024,
  passwordRequired: true, previewToken: "expiry.digest.signature",
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function harness(answer: (path: string, body: Record<string, unknown>) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit; body: Record<string, unknown> }[] = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ url: String(url), init: init!, body });
    return await answer(new URL(String(url)).pathname, body);
  });
  const disconnect = vi.fn(async (_deleted: CloudCredentials) => undefined);
  let current: CloudCredentials | null = credentials;
  const deletion = createServerAccountDeletion({
    credentials: async () => current,
    workspaces: () => [
      { workspaceId: "ws-trip", rootPath: "C:\\Users\\me\\Trip to Lisbon\\" },
      { workspaceId: "ws-notes", rootPath: "/home/me/Notes" },
      { workspaceId: "ws-local-only", rootPath: "/home/me/Drafts" },
    ],
    disconnect,
    fetch: fetch as typeof globalThis.fetch,
  });
  return { deletion, calls, fetch, disconnect, switchTo: (next: CloudCredentials | null) => { current = next; } };
}

const deleteInput = { server: credentials.serverUrl, previewToken: scope.previewToken, password: "correct horse" };

describe("server account deletion", () => {
  it("previews with the stored session and names the owned workspaces this computer has", async () => {
    const h = harness(() => json(200, scope));
    await expect(h.deletion.preview()).resolves.toEqual({
      email: credentials.email, server: credentials.serverUrl,
      workspaces: [{ workspaceId: "ws-notes", name: "Notes" }, { workspaceId: "ws-trip", name: "Trip to Lisbon" }],
      workspacesElsewhere: 1, storedBytes: scope.storedBytes, ownedShareCount: 2, heldGrantCount: 1,
      previewToken: scope.previewToken,
    });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.url).toBe("https://account.example.test/api/auth/account/deletion-preview");
    expect(h.calls[0]!.init).toMatchObject({ method: "POST", redirect: "error", credentials: "omit" });
    expect((h.calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer session-token");
  });

  it.each([
    ["a preview without the password requirement", { ...scope, passwordRequired: false }],
    ["a preview without a token", { ...scope, previewToken: undefined }],
    ["a negative size", { ...scope, storedBytes: -1 }],
  ])("refuses %s", async (_name, body) => {
    const h = harness(() => json(200, body));
    await expect(h.deletion.preview()).rejects.toThrow("invalid deletion preview");
  });

  it.each([
    [401, {}, "session expired"],
    [429, {}, "too many attempts"],
    [503, { code: "DELETION_UNAVAILABLE", message: "This server cannot delete accounts yet. Contact the server owner." }, "cannot delete accounts yet"],
    [500, { message: "internal detail" }, "answered 500"],
  ])("explains a preview the server answered %i", async (status, body, words) => {
    const h = harness(() => json(status, body));
    await expect(h.deletion.preview()).rejects.toThrow(words);
  });

  it("explains an unreachable server and a missing session", async () => {
    const h = harness(() => { throw new TypeError("fetch failed"); });
    await expect(h.deletion.preview()).rejects.toThrow("could not reach this server");
    h.switchTo(null);
    await expect(h.deletion.preview()).rejects.toThrow("Connect to a server first.");
    expect(h.fetch).toHaveBeenCalledOnce();
  });

  it("sends the token and password only to the reviewed server, then disconnects that account", async () => {
    const h = harness(() => json(200, { finished: true }));
    await expect(h.deletion.delete(deleteInput)).resolves.toEqual({
      ok: true, finished: true, email: credentials.email, server: credentials.serverUrl,
    });
    expect(h.calls.map((call) => [call.url, call.body])).toEqual([[
      "https://account.example.test/api/auth/account/delete",
      { previewToken: scope.previewToken, password: "correct horse" },
    ]]);
    expect(h.disconnect).toHaveBeenCalledWith(credentials);
  });

  it("reports a pending deletion as unfinished and still disconnects", async () => {
    const h = harness(() => json(200, { finished: false, pending: true }));
    await expect(h.deletion.delete(deleteInput)).resolves.toMatchObject({ ok: true, finished: false });
    expect(h.disconnect).toHaveBeenCalledOnce();
  });

  it("keeps a completed deletion when the disconnect fails", async () => {
    const h = harness(() => json(200, { finished: true }));
    h.disconnect.mockRejectedValueOnce(new Error("store failed"));
    await expect(h.deletion.delete(deleteInput)).resolves.toMatchObject({ ok: true, finished: true });
  });

  it("never sends the password after the session moved to another server", async () => {
    const h = harness(() => json(200, { finished: true }));
    h.switchTo({ ...credentials, serverUrl: "https://other.example.test" });
    await expect(h.deletion.delete(deleteInput)).resolves.toMatchObject({ ok: false, code: "preview-changed" });
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.disconnect).not.toHaveBeenCalled();
  });

  it.each([
    [409, { code: "PREVIEW_CHANGED" }, "preview-changed"],
    [400, { code: "PREVIEW_REQUIRED" }, "preview-changed"],
    [400, { code: "INVALID_PASSWORD" }, "wrong-password"],
    [400, { code: "PASSWORD_REQUIRED" }, "wrong-password"],
    [429, {}, "rate-limited"],
  ] as const)("refuses a delete the server answered %i %j", async (status, body, code) => {
    const h = harness(() => json(status, body));
    await expect(h.deletion.delete(deleteInput)).resolves.toMatchObject({ ok: false, code });
    expect(h.disconnect).not.toHaveBeenCalled();
  });

  it.each([
    [401, {}, "session expired"],
    [503, { code: "DELETION_PENDING", message: "Account deletion is waiting for the server. Try again later." }, "waiting for the server"],
    [502, {}, "could not delete this account"],
  ])("fails a delete the server answered %i", async (status, body, words) => {
    const h = harness(() => json(status, body));
    await expect(h.deletion.delete(deleteInput)).rejects.toThrow(words);
    expect(h.disconnect).not.toHaveBeenCalled();
  });
});

describe("server account IPC", () => {
  it("checks the sender and the payload before main calls the server", async () => {
    const handlers = new Map<string, (trusted: boolean, payload: unknown) => Promise<unknown>>();
    const deletion = { preview: vi.fn(async () => { throw new Error("unused"); }), delete: vi.fn(async () => ({ ok: false as const, code: "rate-limited" as const, reason: "Wait." })) };
    registerServerAccountIpc<boolean, never>({
      handle: (channel, handler) => { handlers.set(channel, handler); },
      assertTrustedSender: (trusted) => { if (!trusted) throw new Error("Untrusted sender"); },
      withActiveWorkspace: () => { throw new Error("device scope"); },
    }, deletion);
    expect([...handlers.keys()]).toEqual([
      serverAccountOperations.previewServerAccountDeletion.channel,
      serverAccountOperations.deleteServerAccount.channel,
    ]);
    const remove = handlers.get(serverAccountOperations.deleteServerAccount.channel)!;
    await expect(remove(false, deleteInput)).rejects.toThrow("Untrusted sender");
    await expect(remove(true, { ...deleteInput, password: "" })).rejects.toThrow();
    await expect(remove(true, { ...deleteInput, userId: "someone-else" })).rejects.toThrow();
    expect(deletion.delete).not.toHaveBeenCalled();
    await expect(remove(true, deleteInput)).resolves.toEqual({ ok: false, code: "rate-limited", reason: "Wait." });
    expect(deletion.delete).toHaveBeenCalledWith(deleteInput);
  });
});
