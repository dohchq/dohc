import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { writeSharedCollectionRules, type RuleFileDelivery } from "./sharedCollectionRules";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

function fixture(stored: Record<string, string>) {
  const files = new Map(Object.entries(stored));
  const changes: Array<{ kind: string; path: string; expectedContentHash?: string }> = [];
  const shareViewFiles = {
    read: vi.fn(async (_target: unknown, { path }: { path: string }) => {
      const text = files.get(path);
      if (text === undefined)
        throw Object.assign(new Error(`Shared file not found: ${path}`), { code: "ENOENT" });
      return { kind: "text" as const, text, truncated: false as const, contentHash: sha256(text) };
    }),
    change: vi.fn(
      async (
        _lease: unknown,
        _target: unknown,
        change:
          | { kind: "save"; path: string; text: string; expectedContentHash: string }
          | { kind: "create"; path: string; initialText: string },
      ) => {
        const text = change.kind === "save" ? change.text : change.initialText;
        changes.push({
          kind: change.kind,
          path: change.path,
          ...(change.kind === "save" ? { expectedContentHash: change.expectedContentHash } : {}),
        });
        files.set(change.path, text);
        return {
          status: "committed" as const,
          kind: change.kind,
          value: { status: "written" as const, contentHash: sha256(text) },
          projection: "current" as const,
        };
      },
    ),
  };
  const push = vi.fn(async () => {});
  const delivery = vi.fn(
    async (paths: string[]): Promise<Record<string, RuleFileDelivery | undefined>> =>
      Object.fromEntries(
        paths.map((path) => [path, { state: "accepted", contentHash: sha256(files.get(path)!) }]),
      ),
  );
  const write = (next: Record<string, string>, exclusive = false) =>
    writeSharedCollectionRules({
      workspaceId: "joined",
      files: next,
      exclusive,
      shareViewFiles: shareViewFiles as never,
      withLease: (work) => work({} as never),
      push,
      delivery,
      signal: new AbortController().signal,
    });
  return { files, changes, shareViewFiles, push, delivery, write };
}

it("saves changed rule files in place, creates new ones, and sends dataset.json last", async () => {
  const f = fixture({ "people/dataset.json": "old", "people/schema.sql": "SCHEMA" });
  await f.write({
    "people/dataset.json": "new",
    "people/schema.sql": "SCHEMA",
    "people/0002.sql": "ALTER",
  });
  expect(f.changes).toEqual([
    { kind: "create", path: "people/0002.sql" },
    { kind: "save", path: "people/dataset.json", expectedContentHash: sha256("old") },
  ]);
  expect(f.push).toHaveBeenCalledOnce();
  expect(f.delivery).toHaveBeenCalledWith([
    "people/schema.sql",
    "people/0002.sql",
    "people/dataset.json",
  ]);
});

it("creates a new Collection's files only where nothing else is, and leaves the copy unchanged otherwise", async () => {
  const f = fixture({ "registrations/schema.sql": "SCHEMA", "registrations/dataset.json": "old" });
  const created = {
    "registrations/schema.sql": "SCHEMA",
    "registrations/operations.js": "OPS",
    "registrations/dataset.json": "new",
  };
  await expect(f.write(created, true)).rejects.toThrow(
    "A file is already at registrations/dataset.json. Choose another name for the Collection.",
  );
  expect(f.changes).toEqual([]);
  expect(f.files.get("registrations/dataset.json")).toBe("old");
  expect(f.push).not.toHaveBeenCalled();
  f.files.set("registrations/dataset.json", "new");
  await f.write(created, true);
  expect(f.changes).toEqual([{ kind: "create", path: "registrations/operations.js" }]);
});

it("asks the server again once while a rule file waits, then says it couldn't send", async () => {
  const f = fixture({});
  f.delivery.mockResolvedValue({ "people/dataset.json": { state: "pending", contentHash: null } });
  await expect(f.write({ "people/dataset.json": "new" })).rejects.toThrow(
    "dohc could not send this Collection's rules to the workspace. Check your connection, then try again.",
  );
  expect(f.push).toHaveBeenCalledTimes(2);
});

it("passes on the server's refusal, as a demoted Admin gets it", async () => {
  const f = fixture({});
  f.delivery.mockResolvedValue({
    "people/dataset.json": {
      state: "refused",
      contentHash: null,
      reason: "Only the Owner or an Admin can change this Collection's rules.",
    },
  });
  await expect(f.write({ "people/dataset.json": "new" })).rejects.toThrow(
    "The server refused people/dataset.json: Only the Owner or an Admin can change this Collection's rules.",
  );
});

it("refuses when the server holds other text than this copy sent", async () => {
  const f = fixture({});
  f.delivery.mockResolvedValue({
    "people/dataset.json": { state: "accepted", contentHash: sha256("other") },
  });
  await expect(f.write({ "people/dataset.json": "new" })).rejects.toThrow(
    "dohc could not send this Collection's rules",
  );
});

it("stops before sending when a rule file changed while it saved", async () => {
  const f = fixture({ "people/dataset.json": "old" });
  f.shareViewFiles.change.mockResolvedValueOnce({
    status: "committed",
    kind: "save",
    value: { status: "conflict", currentContentHash: sha256("theirs") } as never,
    projection: "current",
  });
  await expect(f.write({ "people/dataset.json": "new" })).rejects.toThrow(
    "people/dataset.json changed while dohc saved it. Try again.",
  );
  expect(f.push).not.toHaveBeenCalled();
});
