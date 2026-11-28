import { describe, expect, it } from "vitest";
import { createServerClient } from "./client";
import { canWriteFiles } from "./fileWrites";
import {
  coerceDocumentFieldValue,
  documentCollectionWrites,
  readDocumentCollectionRecords,
  readDocumentCollections,
  validateCollectionFolderName,
} from "./phoneDocumentCollections";
import { testServer } from "./testServer";

const ops = (result: unknown, cursor = "0.1.1") => ({
  status: 200,
  body: { ok: true, result, cursor },
});
const clientOf = (server: ReturnType<typeof testServer>) =>
  createServerClient({
    origin: server.origin,
    token: "tok",
    fetch: server.fetch,
    signal: new AbortController().signal,
  });

describe("phoneDocumentCollections client & validation", () => {
  it("reads paginated documentCollections and documentCollectionRecords pages", async () => {
    const server = testServer();
    server.on("POST", "/sync/ws-1/ops/documentCollections", (req) => {
      const body = (req.body ?? {}) as { afterPath?: string };
      return body.afterPath
        ? ops(
            {
              ok: true,
              collections: [
                {
                  path: "Trips",
                  name: "Trips",
                  description: null,
                  status: "valid",
                  fields: [{ name: "Name", type: "text" }],
                },
              ],
              nextPath: null,
            },
            "0.2.1",
          )
        : ops(
            {
              ok: true,
              collections: [
                {
                  path: "Tasks",
                  name: "Tasks",
                  description: null,
                  status: "valid",
                  fields: [
                    { name: "Name", type: "text" },
                    { name: "Status", type: "select", options: ["Todo", "Done"] },
                    { name: "Project", type: "relation", collection: "Projects", many: false },
                  ],
                },
              ],
              nextPath: "Tasks/collection.yaml",
            },
            "0.1.1",
          );
    });
    server.on(
      "POST",
      "/sync/ws-1/ops/documentCollectionRecords",
      ops({
        ok: true,
        collection: {
          path: "Tasks",
          name: "Tasks",
          description: null,
          status: "valid",
          fields: [{ name: "Name", type: "text" }],
        },
        records: [
          {
            path: "Tasks/Alpha.md",
            objectId: "obj-1",
            recordId: "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa",
            title: "Alpha",
            values: { Name: "Alpha" },
          },
        ],
        relationLabels: { rec_bbbbbbbbbbbbbbbbbbbbbbbbbb: "Beta" },
        nextPath: "Tasks/Alpha.md",
      }),
    );
    const client = clientOf(server);
    const list = await readDocumentCollections(client, "ws-1", new AbortController().signal);
    expect(list.cursor).toBe("0.1.1");
    expect(list.value.map((c) => c.path)).toEqual(["Tasks", "Trips"]);
    expect(list.value[0]?.fields[2]).toEqual({
      name: "Project",
      type: "relation",
      collection: "Projects",
      many: false,
    });
    const page = await readDocumentCollectionRecords(
      client,
      "ws-1",
      { collectionPath: "Tasks", search: "alp" },
      new AbortController().signal,
    );
    expect(page.value).toMatchObject({
      kind: "ready",
      records: [{ path: "Tasks/Alpha.md", title: "Alpha" }],
      relationLabels: { rec_bbbbbbbbbbbbbbbbbbbbbbbbbb: "Beta" },
      nextPath: "Tasks/Alpha.md",
    });
  });

  it("handles missing collection and write refusals cleanly", async () => {
    const server = testServer();
    server.on(
      "POST",
      "/sync/ws-1/ops/documentCollectionRecords",
      ops({ ok: false, refusal: "not-found", reason: "Gone." }),
    );
    server.on(
      "POST",
      "/sync/ws-1/ops/createDocumentCollection",
      ops({ ok: false, refusal: "folder-occupied", reason: "Exists." }),
    );
    server.on(
      "POST",
      "/sync/ws-1/ops/createDocumentRecord",
      ops({
        ok: true,
        path: "Tasks/One.md",
        objectId: "obj-1",
        recordId: "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa",
      }),
    );
    const client = clientOf(server);
    const missing = await readDocumentCollectionRecords(
      client,
      "ws-1",
      { collectionPath: "Tasks" },
      new AbortController().signal,
    );
    expect(missing.value).toEqual({ kind: "missing" });
    const writes = documentCollectionWrites(client, "ws-1");
    expect(await writes.createCollection({ folder: "Tasks", requestId: "req-1" })).toEqual({
      ok: false,
      refusal: "folder-occupied",
      reason: "Exists.",
    });
    expect(
      await writes.createRecord({ collectionPath: "Tasks", name: "One", requestId: "req-2" }),
    ).toEqual({
      ok: true,
      path: "Tasks/One.md",
      objectId: "obj-1",
      recordId: "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
  });

  it("validates collection folder names and field values against contract rules", () => {
    expect(validateCollectionFolderName("  Trip Tasks  ")).toEqual({
      ok: true,
      folder: "Trip Tasks",
    });
    expect(validateCollectionFolderName("")).toMatchObject({ ok: false });
    expect(validateCollectionFolderName(".hidden")).toMatchObject({ ok: false });
    expect(validateCollectionFolderName("a/b")).toMatchObject({ ok: false });
    expect(validateCollectionFolderName("CON")).toMatchObject({ ok: false });

    expect(coerceDocumentFieldValue({ name: "Count", type: "number" }, "42")).toEqual({
      ok: true,
      value: 42,
    });
    expect(coerceDocumentFieldValue({ name: "Count", type: "number" }, "abc")).toMatchObject({
      ok: false,
    });
    expect(coerceDocumentFieldValue({ name: "Link", type: "url" }, "https://dohc.app")).toEqual({
      ok: true,
      value: "https://dohc.app",
    });
    expect(coerceDocumentFieldValue({ name: "Link", type: "url" }, "not a url")).toMatchObject({
      ok: false,
    });
    expect(coerceDocumentFieldValue({ name: "Owner", type: "person" }, "  Ada  ")).toEqual({
      ok: true,
      value: "Ada",
    });
    expect(coerceDocumentFieldValue({ name: "Done", type: "checkbox" }, true)).toEqual({
      ok: true,
      value: true,
    });
    expect(
      coerceDocumentFieldValue({ name: "Status", type: "select", options: ["Open", "Done"] }, [
        "Done",
      ]),
    ).toEqual({ ok: true, value: "Done" });
    expect(coerceDocumentFieldValue({ name: "Action", type: "button" }, "run")).toMatchObject({
      ok: false,
    });
  });

  it("follows >20 documentCollections pages to completion and rejects repeated cursors", async () => {
    const server = testServer();
    server.on("POST", "/sync/ws-many/ops/documentCollections", (req) => {
      const body = (req.body ?? {}) as { afterPath?: string };
      const idx = body.afterPath ? Number(body.afterPath.slice(2, 4)) + 1 : 1;
      const key = `C-${String(idx).padStart(2, "0")}`;
      return ops(
        {
          ok: true,
          collections: [{ path: key, name: key, description: null, status: "valid", fields: [] }],
          nextPath: idx < 22 ? `${key}/collection.yaml` : null,
        },
        `0.${idx}.1`,
      );
    });
    server.on(
      "POST",
      "/sync/ws-loop/ops/documentCollections",
      ops({
        ok: true,
        collections: [{ path: "A", name: "A", description: null, status: "valid", fields: [] }],
        nextPath: "A/collection.yaml",
      }),
    );
    const client = clientOf(server);
    const all = await readDocumentCollections(client, "ws-many", new AbortController().signal);
    expect(all.value).toHaveLength(22);
    expect(all.value.at(-1)?.path).toBe("C-22");
    expect(all.cursor).toBe("0.1.1");
    await expect(
      readDocumentCollections(client, "ws-loop", new AbortController().signal),
    ).rejects.toThrow();
  });

  it("gates mobile write controls on fileWritesAvailable (false hides writes while keeping reads)", () => {
    const ownerData = { joined: false } as const;
    const joinedData = { joined: true } as const;
    expect(canWriteFiles(ownerData, { fileWritesAvailable: false })).toBe(false);
    expect(canWriteFiles(joinedData, { fileWritesAvailable: true })).toBe(false);
    expect(canWriteFiles(null, { fileWritesAvailable: true })).toBe(false);
  });
});
