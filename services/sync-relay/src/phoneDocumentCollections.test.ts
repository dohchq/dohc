import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  UnauthorizedError,
  type AccountSession,
  type ResolveAccountSession,
} from "@dohc/workspace-auth/session";
import { markdownToYDoc } from "@dohc/ydoc-projection";
import { patchFrontmatter } from "@dohc/ydoc-projection/frontmatter-map";
import { assertOutsideCollection } from "./accountFileWrites";
import { PHONE_DOC_COLLECTION_MAX_SCAN } from "./phoneDocumentCollections";
import type { StorageContext } from "./storage/context";
import {
  appendLog,
  claimWorkspace,
  closeTestStorages,
  denialBytes,
  moment,
  putBlob,
  resetOpSeq,
  testHandler,
  testStorage,
} from "./testing";

afterEach(() => {
  resetOpSeq();
  return closeTestStorages();
});

const resolveAccountSession: ResolveAccountSession = async (req) => {
  const match = /^Bearer session:([\w-]+):([\w-]+)$/u.exec(req.headers.get("authorization") ?? "");
  if (!match) throw new UnauthorizedError();
  return {
    userId: match[1]!,
    sessionId: match[2]!,
    expiresAtMs: Number.MAX_SAFE_INTEGER,
    clientKind: "phone",
  } satisfies AccountSession;
};

const postOp = (
  workspaceId: string,
  operation: string,
  userId: string,
  body: Record<string, unknown>,
) =>
  new Request(`http://relay.test/sync/${encodeURIComponent(workspaceId)}/ops/${operation}`, {
    method: "POST",
    headers: {
      authorization: `Bearer session:${userId}:phone`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

async function seedTextFiles(
  h: ReturnType<typeof testHandler>,
  workspaceId: string,
  entries: ReadonlyArray<{
    readonly path: string;
    readonly text: string;
    readonly objectId?: string;
  }>,
) {
  const ops = [];
  for (const entry of entries) {
    await putBlob(h, "ana", workspaceId, entry.text);
    ops.push(moment(entry.path, entry.text, entry.objectId ? { objectId: entry.objectId } : {}));
  }
  await appendLog(h, "ana", workspaceId, ops);
}

describe("Document Collection ops: Member/Admin 404 isolation", () => {
  for (const hasCopies of [false, true]) {
    it(`returns byte-identical 404 to members and admins across all 5 ops when copies=${String(hasCopies)}`, async () => {
      const storage = (await testStorage()) as StorageContext;
      const h = testHandler(storage, {
        resolvePhoneCapableAccountSession: resolveAccountSession,
        ...(hasCopies ? { serverCopies: () => ({ endHold() {} }) as never } : {}),
      });
      await claimWorkspace(h, "ana", "trip");
      storage.claimWorkspaceIdentity({
        workspaceId: "trip",
        replicationEpoch: "epoch",
        streamIdentity: "stream",
      });
      expect(
        storage.inviteWorkspaceMember({
          workspaceId: "trip",
          actorUserId: "ana",
          workspaceName: "Lisbon",
          email: "ben@dohc.test",
          recipientUserId: "ben",
          newMemberId: () => "member-ben",
          newGrantId: () => "grant-ben",
          newShareId: () => "share-trip",
          nowMs: 1,
        }),
      ).toMatchObject({ ok: true });

      const ops: Array<[string, Record<string, unknown>]> = [
        ["documentCollections", {}],
        ["documentCollectionRecords", { collectionPath: "Tasks" }],
        ["createDocumentCollection", { folder: "Tasks", requestId: "req-1" }],
        ["createDocumentRecord", { collectionPath: "Tasks", name: "Item", requestId: "req-2" }],
        [
          "editDocumentRecordFields",
          {
            path: "Tasks/Item.md",
            expectedObjectId: "obj-1",
            fields: { Name: "X" },
            requestId: "req-3",
          },
        ],
      ];
      for (const [op, args] of ops) {
        const missing = await denialBytes(await h(postOp("nowhere", op, "ben", args)));
        expect(await denialBytes(await h(postOp("trip", op, "ben", args))), `member ${op}`).toBe(
          missing,
        );
      }

      storage.setWorkspaceMemberRole({
        workspaceId: "trip",
        actorUserId: "ana",
        memberId: "member-ben",
        role: "admin",
      });
      for (const [op, args] of ops) {
        const missing = await denialBytes(await h(postOp("nowhere", op, "ben", args)));
        expect(await denialBytes(await h(postOp("trip", op, "ben", args))), `admin ${op}`).toBe(
          missing,
        );
      }

      if (!hasCopies) {
        // Owner read browsing works WITHOUT ServerCopies; writes return 503.
        expect((await h(postOp("trip", "documentCollections", "ana", {}))).status).toBe(200);
        expect(
          (
            await h(
              postOp("trip", "createDocumentCollection", "ana", {
                folder: "Tasks",
                requestId: "req-4",
              }),
            )
          ).status,
        ).toBe(503);
      }
    });
  }
});

describe("Document Collection relay-table reads (zero ServerCopies)", () => {
  it("lists valid collections, excludes hidden & dataset-nested folders, overlays live frontmatter, resolves relations, and handles >16 KiB body notes", async () => {
    const storage = (await testStorage()) as StorageContext;
    const h = testHandler(storage, { resolvePhoneCapableAccountSession: resolveAccountSession });
    await claimWorkspace(h, "ana", "ws");
    const schema = [
      "name: Tasks",
      "fields:",
      "  Status:",
      "    type: select",
      "    options: [Todo, Done]",
      "  Project:",
      "    type: relation",
      "    collection: Projects",
      "    many: false",
      "  __proto__:",
      "    type: text",
    ].join("\n");
    const projectRecId = "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa";
    const largeBody = "x".repeat(25_000);
    await seedTextFiles(h, "ws", [
      { path: "Tasks/collection.yaml", text: schema },
      {
        path: "Projects/collection.yaml",
        text: `name: "${"P".repeat(600)}"\nfields:\n  Name:\n    type: text\n`,
      },
      { path: ".secret/collection.yaml", text: "name: Secret\nfields:\n  Name:\n    type: text\n" },
      { path: ".dohc/collection.yaml", text: "name: Internal\nfields:\n  Name:\n    type: text\n" },
      { path: "Transactional/dataset.json", text: "{}" },
      {
        path: "Transactional/Sub/collection.yaml",
        text: "name: Nested\nfields:\n  Name:\n    type: text\n",
      },
      {
        path: "Projects/Launch.md",
        text: `---\nid: ${projectRecId}\n---\nLaunch project\n`,
        objectId: "obj-proj",
      },
      {
        path: "Tasks/Alpha.md",
        text: `---\nid: rec_bbbbbbbbbbbbbbbbbbbbbbbbbb\nStatus: Todo\nProject: ${projectRecId}\n---\n${largeBody}\n`,
        objectId: "obj-alpha",
      },
      {
        path: "Tasks/Beta.md",
        text: `---   \ntitle: "${"LongTitle".repeat(200)}"\nStatus: Done\n__proto__: safe-val\n---  \nBody\n`,
        objectId: "obj-beta",
      },
      { path: "Tasks/.hidden.md", text: "---\nStatus: Secret\n---\n" },
    ]);

    // Accepted live frontmatter cut overrides stale settled Status: Todo -> Done.
    const liveDoc = markdownToYDoc(
      `---\nid: rec_bbbbbbbbbbbbbbbbbbbbbbbbbb\nStatus: Todo\nProject: ${projectRecId}\n---\nBody\n`,
    );
    const checkpoint = Y.encodeStateAsUpdate(liveDoc);
    const updates: Uint8Array[] = [];
    liveDoc.on("update", (u: Uint8Array) => updates.push(u));
    patchFrontmatter(liveDoc, new Map<string, unknown>([["Status", "Done"]]));
    vi.spyOn(storage, "readAcceptedLiveDocument").mockImplementation((wsId, path) =>
      wsId === "ws" && path === "Tasks/Alpha.md"
        ? ({
            kind: "cut",
            cut: {
              document: {
                workspaceId: "ws",
                mainVersionId: "main",
                objectId: "obj-alpha",
                lineageClaimId: "claim-1",
              },
              checkpoint: { bytes: checkpoint },
              suffix: [{ bytes: updates[0]! }],
            },
          } as never)
        : { kind: "none" },
    );

    const listResp = await h(postOp("ws", "documentCollections", "ana", {}));
    expect(listResp.status).toBe(200);
    const listBody = (await listResp.json()) as {
      ok: true;
      result: { ok: true; collections: Array<{ path: string; name: string }> };
    };
    expect(listBody.result.collections.map((c) => c.path)).toEqual(["Projects", "Tasks"]);
    expect(listBody.result.collections[0]?.name.length).toBeLessThanOrEqual(256);

    const recResp = await h(
      postOp("ws", "documentCollectionRecords", "ana", { collectionPath: "Tasks" }),
    );
    expect(recResp.status).toBe(200);
    const recBody = (await recResp.json()) as {
      ok: true;
      result: {
        ok: true;
        records: Array<{ path: string; title: string; values: Record<string, unknown> }>;
        relationLabels: Record<string, string>;
      };
    };
    expect(recBody.result.records.map((r) => r.path)).toEqual(["Tasks/Alpha.md", "Tasks/Beta.md"]);
    expect(recBody.result.records[0]?.values).toEqual({
      Status: "Done",
      Project: projectRecId,
    });
    expect(recBody.result.records[1]?.values).toMatchObject({ Status: "Done" });
    expect(Object.hasOwn(recBody.result.records[1]!.values, "__proto__")).toBe(true);
    expect(recBody.result.records[1]?.values["__proto__"]).toBe("safe-val");
    expect(recBody.result.records[1]?.title.length).toBeLessThanOrEqual(256);
    expect(recBody.result.relationLabels).toEqual({ [projectRecId]: "Launch" });
  });

  it("paginates >200 collections, binds conflicted records to currentFileObjectId, and bounds record search to <= 200 records", async () => {
    const storage = (await testStorage()) as StorageContext;
    const h = testHandler(storage, { resolvePhoneCapableAccountSession: resolveAccountSession });
    await claimWorkspace(h, "ana", "big");
    await seedTextFiles(h, "big", [
      {
        path: ".hidden-col/collection.yaml",
        text: "name: Hidden\nfields:\n  Name:\n    type: text\n",
      },
      ...Array.from({ length: 201 }, (_, idx) => ({
        path: `Col-${String(idx + 1).padStart(3, "0")}/collection.yaml`,
        text: `name: Col ${idx + 1}\nfields:\n  Name:\n    type: text\n`,
      })),
      { path: "Items/collection.yaml", text: "name: Items\nfields:\n  Rank:\n    type: number\n" },
      ...Array.from({ length: 250 }, (_, idx) => {
        const i = idx + 1;
        return {
          path: `Items/Item-${String(i).padStart(3, "0")}.md`,
          text: `---\nRank: ${251 - i}\n---\n`,
        };
      }),
    ]);

    const cols1 = (await (await h(postOp("big", "documentCollections", "ana", {}))).json()) as {
      result: { collections: Array<{ path: string }>; nextPath: string | null };
    };
    expect(cols1.result.collections).toHaveLength(200);
    expect(cols1.result.nextPath).toBeTruthy();
    const cols2 = (await (
      await h(postOp("big", "documentCollections", "ana", { afterPath: cols1.result.nextPath }))
    ).json()) as { result: { collections: Array<{ path: string }>; nextPath: string | null } };
    expect(cols2.result.collections.map((c) => c.path)).toEqual(["Col-201", "Items"]);
    expect(cols2.result.nextPath).toBeNull();

    // Two conflicting creates at the same path: record objectId must match currentFileObjectId.
    const firstText = "---\nName: First\n---\n";
    const secondText = "---\nName: Second\n---\n";
    await putBlob(h, "ana", "big", firstText);
    await putBlob(h, "ana", "big", secondText);
    await appendLog(h, "ana", "big", [
      moment("Col-001/Follow-up.md", firstText, {
        objectId: "obj-first",
        momentId: "mom-a",
        recordedAtMs: 100,
      }),
    ]);
    await appendLog(
      h,
      "ana",
      "big",
      [
        {
          ...moment("Col-001/Follow-up.md", secondText, {
            objectId: "obj-second",
            momentId: "mom-b",
            recordedAtMs: 50,
          }),
          originSeq: 0,
        },
      ],
      { originId: "origin-b" },
    );
    const conflictRecs = (await (
      await h(postOp("big", "documentCollectionRecords", "ana", { collectionPath: "Col-001" }))
    ).json()) as {
      result: { records: Array<{ path: string; objectId: string; values: { Name?: string } }> };
    };
    const winningObjId = storage.currentFileObjectId({
      workspaceId: "big",
      versionId: "main",
      path: "Col-001/Follow-up.md",
    });
    expect(conflictRecs.result.records[0]?.objectId).toBe(winningObjId);
    expect(conflictRecs.result.records[0]?.values.Name).toBe(
      winningObjId === "obj-first" ? "First" : "Second",
    );

    const page1 = (await (
      await h(
        postOp("big", "documentCollectionRecords", "ana", { collectionPath: "Items", limit: 50 }),
      )
    ).json()) as {
      result: { records: Array<{ path: string }>; nextPath: string | null };
    };
    expect(page1.result.records).toHaveLength(50);
    expect(page1.result.nextPath).toBe("Items/Item-050.md");

    const page2 = (await (
      await h(
        postOp("big", "documentCollectionRecords", "ana", {
          collectionPath: "Items",
          limit: 50,
          afterPath: page1.result.nextPath,
        }),
      )
    ).json()) as { result: { records: Array<{ path: string }> } };
    expect(page2.result.records[0]?.path).toBe("Items/Item-051.md");

    const searched = (await (
      await h(
        postOp("big", "documentCollectionRecords", "ana", {
          collectionPath: "Items",
          search: "Item-",
        }),
      )
    ).json()) as {
      result: { records: Array<{ path: string }>; nextPath: string | null };
    };
    expect(searched.result.records.length).toBeLessThanOrEqual(PHONE_DOC_COLLECTION_MAX_SCAN);
    expect(searched.result.nextPath).toBeNull();
  });

  it("refuses invalid query arguments and allows deleteFile inside collection.yaml while blocking dataset.json", async () => {
    const storage = (await testStorage()) as StorageContext;
    const h = testHandler(storage, {
      resolvePhoneCapableAccountSession: resolveAccountSession,
      serverCopies: () => ({ endHold() {} }) as never,
    });
    await claimWorkspace(h, "ana", "v");
    await seedTextFiles(h, "v", [
      {
        path: "Tasks/collection.yaml",
        text: "name: Tasks\nfields:\n  Tags:\n    type: multi-select\n    options: [A, B]\n",
      },
    ]);

    expect(
      (await h(postOp("v", "documentCollectionRecords", "ana", { collectionPath: "../escape" })))
        .status,
    ).toBe(400);
    expect(
      (
        await h(
          postOp("v", "documentCollectionRecords", "ana", { collectionPath: "Tasks", limit: 99 }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await h(
          postOp("v", "editDocumentRecordFields", "ana", {
            path: "Tasks/Sketch.excalidraw",
            expectedObjectId: "obj-1",
            fields: { Name: "X" },
            requestId: "req-non-md",
          }),
        )
      ).status,
    ).toBe(400);

    const mockAdapter = (existing: ReadonlySet<string>) =>
      ({
        resolveFiles: async ({ targets }: { targets: Array<{ path: string }> }) => ({
          results: targets.map((t) =>
            existing.has(t.path) ? { status: "found", objectId: "obj" } : { status: "not-found" },
          ),
        }),
      }) as never;

    await expect(
      assertOutsideCollection(
        mockAdapter(new Set(["Tasks/collection.yaml"])),
        "v",
        "Tasks/One.md",
        true,
      ),
    ).resolves.toBeUndefined();
    await expect(
      assertOutsideCollection(
        mockAdapter(new Set(["Tasks/collection.yaml"])),
        "v",
        "Tasks/One.md",
        false,
      ),
    ).rejects.toThrow();
    await expect(
      assertOutsideCollection(
        mockAdapter(new Set(["Tasks/dataset.json"])),
        "v",
        "Tasks/One.md",
        true,
      ),
    ).rejects.toThrow();
  });
});
