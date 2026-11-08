import { describe, expect, it, vi } from "vitest";
import { createWorkLinks } from "./workLinks";

const reference = "aB_9-".repeat(8) + "aB_";

interface Entry {
  workspaceId: string;
  sync?: "on" | "paused";
  remote?: { serverUrl: string };
}

// The engine leaves a file's conversation without a chat; a Group's or DM's
// thread carries its channel.
function found(messageId: string, state: "live" | "deleted" | "unchecked" = "live", channelId?: string | null) {
  return {
    status: "found" as const, reference, state, createdAtMs: 1, registration: "registered" as const,
    target: { kind: "message" as const, messageId, threadId: `thread-${messageId}`, ...(channelId === undefined ? {} : { channelId }) },
  };
}

function links(entries: Entry[], resolveReference: (entry: Entry, reference: string) => Promise<ReturnType<typeof found> | { status: "unknown" } | null>) {
  return createWorkLinks<Entry>({ workspaces: () => entries, summaryOf: (entry) => entry, resolveReference });
}

describe("message links", () => {
  const synced: Entry = { workspaceId: "synced", sync: "on", remote: { serverUrl: "https://Dohc.Example/api/" } };

  it("links to the message on the origin of the workspace's server", async () => {
    const mint = vi.fn(async () => reference);
    await expect(links([synced], vi.fn()).messageLink(synced, mint)).resolves.toBe(`https://dohc.example/l/${reference}`);
    expect(mint).toHaveBeenCalledOnce();
  });

  it.each<[string, Entry]>([
    ["a local-only workspace", { workspaceId: "local" }],
    ["a paused workspace", { workspaceId: "paused", sync: "paused" }],
  ])("gives %s no link and makes no reference", async (_name, entry) => {
    const mint = vi.fn(async () => reference);
    await expect(links([entry], vi.fn()).messageLink(entry, mint)).resolves.toBeNull();
    expect(mint).not.toHaveBeenCalled();
  });

  it("says so when the engine cannot make the reference", async () => {
    await expect(links([synced], vi.fn()).messageLink(synced, async () => null)).rejects.toThrow("The workspace engine is not running.");
  });
});

describe("opening a work link", () => {
  const link = { server: "https://dohc.example", reference };
  const a: Entry = { workspaceId: "a", sync: "on", remote: { serverUrl: "https://dohc.example" } };
  const b: Entry = { workspaceId: "b", sync: "on", remote: { serverUrl: "https://dohc.example/" } };
  const elsewhere: Entry = { workspaceId: "elsewhere", sync: "on", remote: { serverUrl: "https://other.example" } };
  const local: Entry = { workspaceId: "local" };

  it("asks the window's own workspace first and stops at the first that holds the message", async () => {
    const asked: string[] = [];
    const resolve = vi.fn(async (entry: Entry) => {
      asked.push(entry.workspaceId);
      return entry.workspaceId === "b" ? found("m1", "live", "group-1") : { status: "unknown" as const };
    });
    await expect(links([a, b, elsewhere, local], resolve).resolve(link, "b"))
      .resolves.toEqual({ workspaceId: "b", channelId: "group-1", threadId: "thread-m1", messageId: "m1" });
    expect(asked).toEqual(["b"]);
  });

  it.each([null, undefined])("names no chat for a message in a file's conversation (engine channel %s)", async (channelId) => {
    const resolve = vi.fn(async () => found("m4", "live", channelId));
    await expect(links([a], resolve).resolve(link, "a"))
      .resolves.toEqual({ workspaceId: "a", channelId: null, threadId: "thread-m4", messageId: "m4" });
  });

  it("asks only workspaces that sync with the link's server", async () => {
    const asked: string[] = [];
    const resolve = vi.fn(async (entry: Entry) => {
      asked.push(entry.workspaceId);
      return entry.workspaceId === "b" ? found("m2") : { status: "unknown" as const };
    });
    await expect(links([local, elsewhere, a, b], resolve).resolve(link, "local"))
      .resolves.toEqual({ workspaceId: "b", channelId: null, threadId: "thread-m2", messageId: "m2" });
    expect(asked).toEqual(["a", "b"]);
  });

  it("skips a deleted message and a workspace that cannot answer", async () => {
    const resolve = vi.fn(async (entry: Entry) => {
      if (entry.workspaceId === "a") throw new Error("engine stopped");
      return found("m3", "deleted");
    });
    await expect(links([a, b], resolve).resolve(link, undefined)).resolves.toBeNull();
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("finds nothing when no workspace syncs with the server", async () => {
    const resolve = vi.fn();
    await expect(links([local, elsewhere], resolve).resolve(link, "local")).resolves.toBeNull();
    expect(resolve).not.toHaveBeenCalled();
  });
});
