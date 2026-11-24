import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { markdownToYDoc, yDocToMarkdown } from "@dohc/ydoc-projection";
import type { MomentWriteAuthor } from "@dohc/workspace-contracts/engine";
import {
  INBOX_COLLECTION_PATH,
  INBOX_FILES_DIR,
  INBOX_SCHEMA_PATH,
  MAX_INBOX_IMAGE_BYTES,
} from "@dohc/workspace-contracts/inbox";
import {
  addInboxItem,
  archiveInboxItem,
  captureFilesToInbox,
  listInboxItems,
  moveInboxItem,
  undoArchiveInboxItem,
  undoMoveInboxItem,
  type InboxOperationLike,
  type WorkspaceInboxHost,
} from "./workspaceInbox";
import { AuthoredTextChangedError } from "./workspaceEngineCapture";
import { createInboxIpcHandlers } from "../ipc/inboxIpc";

vi.mock("electron", () => ({
  app: { isPackaged: false },
  dialog: {
    showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })),
  },
}));

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await rm(dir, { recursive: true, force: true });
  }
});

const personAuthor: Extract<MomentWriteAuthor, { kind: "human" }> = {
  kind: "human",
  humanId: "user-1",
};

async function makeWorkspace(overrides?: Partial<InboxOperationLike["workspace"]>) {
  const rootPath = await mkdtemp(join(tmpdir(), "dohc-inbox-test-"));
  tempDirs.push(rootPath);
  const movedOps: Array<{ fromPath: string; toPath: string; operationId: string }> = [];
  const operation: InboxOperationLike = {
    workspace: {
      workspaceId: "ws-inbox-1",
      rootPath,
      ...overrides,
    },
    signal: new AbortController().signal,
    assertCurrent: () => undefined,
  };
  const host: WorkspaceInboxHost = {
    capture: {
      writeAuthoredFile: async (absolutePath, content, _author, options) => {
        if (options?.expectedContentHash !== undefined) {
          const existing = await readFile(absolutePath, "utf8");
          const actualHash = createHash("sha256").update(existing, "utf8").digest("hex");
          if (actualHash !== options.expectedContentHash) {
            throw new AuthoredTextChangedError(absolutePath);
          }
        }
        await mkdir(dirname(absolutePath), { recursive: true });
        await writeFile(absolutePath, content, options?.createOnly ? { flag: "wx" } : undefined);
        return {
          resolvedAbsolutePath: absolutePath,
          materializeOutcome: "applied",
          objectId: `obj-${createHash("sha256").update(absolutePath).digest("hex").slice(0, 8)}`,
          momentId: `mom-${createHash("sha256").update(absolutePath).digest("hex").slice(0, 8)}`,
          deduped: false,
        };
      },
      openRecordSession: async (relativePath) => {
        const absolutePath = join(rootPath, relativePath);
        const markdown = await readFile(absolutePath, "utf8");
        const doc = markdownToYDoc(markdown);
        return {
          applyDecidedLocalUpdate: async (decide, onArmed) => {
            onArmed();
            const update = decide(doc);
            if (!update) return false;
            Y.applyUpdate(doc, update);
            return true;
          },
          settleNow: async () => {
            await writeFile(absolutePath, yDocToMarkdown(doc), "utf8");
          },
          close: async () => {
            doc.destroy();
          },
        };
      },
    },
    withAdapter: async () => null,
    onCaptureSettled: () => () => undefined,
    moveFile: async ({ fromPath, toPath }) => {
      const fromAbs = join(rootPath, fromPath);
      const toAbs = join(rootPath, toPath);
      await mkdir(dirname(toAbs), { recursive: true });
      await rename(fromAbs, toAbs);
      const operationId = `dohc-operation:11111111-1111-4111-8111-${String(movedOps.length + 1).padStart(12, "0")}`;
      movedOps.push({ fromPath, toPath, operationId });
      return { fromPath, toPath, operationId };
    },
    undoOperation: async (operationId) => {
      const found = movedOps.find((entry) => entry.operationId === operationId);
      if (!found) throw new Error(`Unknown operation ${operationId}`);
      await mkdir(dirname(join(rootPath, found.fromPath)), { recursive: true });
      await rename(join(rootPath, found.toPath), join(rootPath, found.fromPath));
    },
    registeredRoots: () => [rootPath],
    onChanged: vi.fn(),
  };
  return { rootPath, operation, host, movedOps };
}

describe("workspaceInbox", () => {
  it("lists an absent Inbox lazily without creating Inbox/", async () => {
    const { rootPath, operation, host } = await makeWorkspace();
    const result = await listInboxItems(operation.workspace, {}, host);
    expect(result).toEqual({ exists: false, items: [], hasMore: false });
    await expect(readFile(join(rootPath, INBOX_SCHEMA_PATH), "utf8")).rejects.toThrow();
  });

  it("lazily creates Inbox/collection.yaml on first add and lists captured items", async () => {
    const { rootPath, operation, host } = await makeWorkspace();
    const added = await addInboxItem(
      operation,
      {
        title: "Read spec",
        url: "https://example.com/spec",
        body: "Check sections 2 and 3.",
      },
      personAuthor,
      "capture",
      host,
    );
    expect(added.createdInbox).toBe(true);
    expect(added.path).toMatch(/^Inbox\/\d{4}-\d{2}-\d{2}-read-spec\.md$/);
    expect(added.recordId).toMatch(/^rec_[a-z2-7]{26}$/);

    const schema = await readFile(join(rootPath, INBOX_SCHEMA_PATH), "utf8");
    expect(schema).toContain("name: Inbox");

    const listed = await listInboxItems(operation.workspace, { status: "New" }, host);
    expect(listed.exists).toBe(true);
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]).toMatchObject({
      id: added.recordId,
      path: added.path,
      title: "Read spec",
      status: "New",
      source: "capture",
      kind: "link",
      url: "https://example.com/spec",
    });

    const second = await addInboxItem(
      operation,
      { title: "Read spec", body: "Duplicate slug" },
      personAuthor,
      "cli",
      host,
    );
    expect(second.createdInbox).toBe(false);
    expect(second.path).not.toBe(added.path);
  });

  it("refuses .env files, secret ancestor directories, and nested .env.* before copying bytes or creating Inbox", async () => {
    const { rootPath, operation, host } = await makeWorkspace();
    const externalDir = await mkdtemp(join(tmpdir(), "dohc-drop-src-"));
    tempDirs.push(externalDir);

    const envFile = join(externalDir, ".env");
    await writeFile(envFile, "API_KEY=super-secret-value\n", "utf8");
    const secretDir = join(externalDir, ".env.production");
    await mkdir(secretDir, { recursive: true });
    const fileUnderSecretDir = join(secretDir, "notes.txt");
    await writeFile(fileUnderSecretDir, "PROD_SECRET=123\n", "utf8");

    const nestedFolder = join(externalDir, "bundle");
    await mkdir(join(nestedFolder, "config", ".env"), { recursive: true });
    await writeFile(join(nestedFolder, "config", ".env.production"), "DB_PASS=nope\n", "utf8");
    await writeFile(join(nestedFolder, "config", ".env", "inner.txt"), "INNER_SECRET=1\n", "utf8");
    await writeFile(join(nestedFolder, "receipt.txt"), "Lunch $12\n", "utf8");

    // Dropping ONLY .env or a file inside .env.production/ must NOT lazily create Inbox/.
    const onlySecret = await captureFilesToInbox(
      operation,
      { droppedPaths: [envFile, fileUnderSecretDir] },
      personAuthor,
      host,
    );
    expect(onlySecret.createdInbox).toBe(false);
    expect(onlySecret.items).toEqual([]);
    expect(onlySecret.skipped).toBe(2);
    expect(onlySecret.skippedSources).toEqual([
      { name: ".env", reason: "secret-file" },
      { name: "notes.txt", reason: "secret-file" },
    ]);
    await expect(readFile(join(rootPath, INBOX_SCHEMA_PATH), "utf8")).rejects.toThrow();

    // Picking a file inside a secret ancestor directory is also refused before creating Inbox/.
    const pickedSecret = await captureFilesToInbox(
      operation,
      { pickedPaths: [fileUnderSecretDir] },
      personAuthor,
      host,
    );
    expect(pickedSecret.createdInbox).toBe(false);
    expect(pickedSecret.items).toEqual([]);
    expect(pickedSecret.skippedSources).toEqual([{ name: "notes.txt", reason: "secret-file" }]);
    await expect(readFile(join(rootPath, INBOX_SCHEMA_PATH), "utf8")).rejects.toThrow();

    // Dropping a folder prunes nested secret files & secret directories, capturing only receipt.txt.
    const mixed = await captureFilesToInbox(
      operation,
      { droppedPaths: [nestedFolder] },
      personAuthor,
      host,
    );
    expect(mixed.createdInbox).toBe(true);
    expect(mixed.items).toHaveLength(1);
    expect(mixed.items[0]!.attachments).toEqual([`${INBOX_FILES_DIR}/receipt.txt`]);
    expect(mixed.skippedSources).toContainEqual({
      name: "bundle/config/.env.production",
      reason: "secret-file",
    });
    expect(mixed.skippedSources).toContainEqual({
      name: "bundle/config/.env",
      reason: "secret-file",
    });
    const capturedBytes = await readFile(join(rootPath, INBOX_FILES_DIR, "receipt.txt"), "utf8");
    expect(capturedBytes).toBe("Lunch $12\n");
    await expect(readFile(join(rootPath, INBOX_FILES_DIR, "inner.txt"), "utf8")).rejects.toThrow();
  });

  it("does not create an empty Inbox when only oversized files are dropped and rolls back orphan attachments on mid-batch write failure", async () => {
    const { rootPath, operation, host } = await makeWorkspace();
    const externalDir = await mkdtemp(join(tmpdir(), "dohc-drop-oversize-"));
    tempDirs.push(externalDir);

    const hugeFile = join(externalDir, "huge.bin");
    await writeFile(hugeFile, Buffer.alloc(MAX_INBOX_IMAGE_BYTES + 16, 0x41));

    const oversizedOnly = await captureFilesToInbox(
      operation,
      { droppedPaths: [hugeFile] },
      personAuthor,
      host,
    );
    expect(oversizedOnly.createdInbox).toBe(false);
    expect(oversizedOnly.items).toEqual([]);
    expect(oversizedOnly.skippedSources).toEqual([{ name: "huge.bin", reason: "too-large" }]);
    await expect(readFile(join(rootPath, INBOX_SCHEMA_PATH), "utf8")).rejects.toThrow();

    // Oversized pasted image (> 5 MiB) is rejected upfront before writing earlier images in the same batch.
    const smallPng = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64");
    const hugePng = Buffer.alloc(MAX_INBOX_IMAGE_BYTES + 8, 0x55).toString("base64");
    await expect(
      captureFilesToInbox(
        operation,
        {
          title: "Batch",
          pastedImages: [
            { name: "small.png", mimeType: "image/png", bytesBase64: smallPng },
            { name: "huge.png", mimeType: "image/png", bytesBase64: hugePng },
          ],
        },
        personAuthor,
        host,
      ),
    ).rejects.toThrow(/exceeds 5 MiB/);
    await expect(readFile(join(rootPath, INBOX_SCHEMA_PATH), "utf8")).rejects.toThrow();

    // Mid-batch write failure cleans up the uncommitted attachment and newly created schema.
    const realWrite = host.capture.writeAuthoredFile;
    let writeCalls = 0;
    const failingHost: WorkspaceInboxHost = {
      ...host,
      capture: {
        ...host.capture,
        writeAuthoredFile: async (absPath, content, author, opts) => {
          writeCalls += 1;
          if (writeCalls === 3) {
            throw new Error("Simulated note write failure");
          }
          return realWrite(absPath, content, author, opts);
        },
      },
    };
    await expect(
      captureFilesToInbox(
        operation,
        {
          title: "Fail on note",
          pastedImages: [{ name: "orphan.png", mimeType: "image/png", bytesBase64: smallPng }],
        },
        personAuthor,
        failingHost,
      ),
    ).rejects.toThrow(/Simulated note write failure/);
    await expect(readFile(join(rootPath, INBOX_SCHEMA_PATH), "utf8")).rejects.toThrow();
  });

  it("refuses in-workspace symlinks at Inbox or Inbox/files across capture and move", async () => {
    const { rootPath, operation, host } = await makeWorkspace();
    await mkdir(join(rootPath, "Projects"), { recursive: true });
    await writeFile(join(rootPath, "Projects", "important.txt"), "Do not steal\n", "utf8");
    await mkdir(join(rootPath, INBOX_COLLECTION_PATH), { recursive: true });
    await writeFile(
      join(rootPath, INBOX_SCHEMA_PATH),
      "version: 1\nname: Inbox\nfields:\n  Title:\n    type: text\n",
      "utf8",
    );

    let symlinkCreated = false;
    try {
      await symlink(join(rootPath, "Projects"), join(rootPath, INBOX_FILES_DIR), "junction");
      symlinkCreated = true;
    } catch {
      symlinkCreated = false;
    }
    if (!symlinkCreated) return;

    const pngBase64 = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64");
    await expect(
      captureFilesToInbox(
        operation,
        {
          title: "Escape attempt",
          pastedImages: [{ name: "escape.png", mimeType: "image/png", bytesBase64: pngBase64 }],
        },
        personAuthor,
        host,
      ),
    ).rejects.toThrow(/not a real folder|symbolic link|outside/i);

    await writeFile(
      join(rootPath, INBOX_COLLECTION_PATH, "trick.md"),
      "---\nid: rec_aaaaaaaaaaaaaaaaaaaaaaaaaa\nTitle: Trick\nStatus: New\nAttachment: Inbox/files/important.txt\n---\n\n[important](files/important.txt)\n",
      "utf8",
    );
    await expect(
      moveInboxItem(
        operation,
        { item: "Inbox/trick.md", targetFolder: "Projects" },
        personAuthor,
        host,
      ),
    ).rejects.toThrow(/not a real folder|symbolic link|outside/i);
    await expect(readFile(join(rootPath, "Projects", "important.txt"), "utf8")).resolves.toBe(
      "Do not steal\n",
    );
  });

  it("archives an Inbox item via live Y.Doc and derives previousStatus from live canonical state", async () => {
    const { rootPath, operation, host } = await makeWorkspace();
    const added = await addInboxItem(
      operation,
      { title: "Old receipt", body: "Done" },
      personAuthor,
      "capture",
      host,
    );

    // Simulate a live Y.Doc whose canonical Status is already "Filed" even though on-disk Markdown still says "New".
    const liveHost: WorkspaceInboxHost = {
      ...host,
      capture: {
        ...host.capture,
        openRecordSession: async (relativePath) => {
          const absolutePath = join(rootPath, relativePath);
          const markdown = (await readFile(absolutePath, "utf8")).replace(
            "Status: New",
            "Status: Filed",
          );
          const doc = markdownToYDoc(markdown);
          return {
            applyDecidedLocalUpdate: async (decide, onArmed) => {
              onArmed();
              const update = decide(doc);
              if (!update) return false;
              Y.applyUpdate(doc, update);
              return true;
            },
            settleNow: async () => {
              await writeFile(absolutePath, yDocToMarkdown(doc), "utf8");
            },
            close: async () => {
              doc.destroy();
            },
          };
        },
      },
    };

    const archived = await archiveInboxItem(
      operation,
      { item: added.path },
      personAuthor,
      personAuthor,
      liveHost,
    );
    expect(archived).toEqual({ path: added.path, previousStatus: "Filed", changed: true });

    const noteText = await readFile(join(rootPath, added.path), "utf8");
    expect(noteText).toContain("Status: Archived");

    // Re-archiving an already Archived record reports changed: false.
    const again = await archiveInboxItem(
      operation,
      { item: added.path },
      personAuthor,
      personAuthor,
      host,
    );
    expect(again).toEqual({ path: added.path, previousStatus: "Archived", changed: false });
  });

  it("moves all attachments, rewrites moved note links, and rolls back if any move fails", async () => {
    const { rootPath, operation, host } = await makeWorkspace();
    await mkdir(join(rootPath, "Projects"), { recursive: true });
    const pngBase64 = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64");
    const captured = await captureFilesToInbox(
      operation,
      {
        title: "Invoice bundle",
        body: "Two attachments",
        pastedImages: [
          { name: "front.png", mimeType: "image/png", bytesBase64: pngBase64 },
          { name: "back.png", mimeType: "image/png", bytesBase64: pngBase64 },
        ],
      },
      personAuthor,
      host,
    );
    const item = captured.items[0]!;
    expect(item.attachments).toHaveLength(2);

    // If moving the second attachment fails, the first attachment and note are rolled back and stay in Inbox/.
    let moveCount = 0;
    const failingMoveHost: WorkspaceInboxHost = {
      ...host,
      moveFile: async (moveInput) => {
        moveCount += 1;
        if (moveCount === 3) {
          throw new Error("History excludes this attachment");
        }
        return host.moveFile(moveInput);
      },
    };
    await expect(
      moveInboxItem(
        operation,
        { item: item.path, targetFolder: "Projects" },
        personAuthor,
        failingMoveHost,
      ),
    ).rejects.toThrow(/History excludes this attachment/);
    await expect(readFile(join(rootPath, item.path), "utf8")).resolves.toContain("Invoice bundle");
    await expect(readFile(join(rootPath, item.attachments[0]!))).resolves.toBeTruthy();
    await expect(readFile(join(rootPath, item.attachments[1]!))).resolves.toBeTruthy();

    // Now perform the move cleanly: BOTH attachments move and note links + Attachment frontmatter are rewritten.
    const moved = await moveInboxItem(
      operation,
      { item: item.path, targetFolder: "Projects" },
      personAuthor,
      host,
    );
    expect(moved.fromPath).toBe(item.path);
    expect(moved.toPath).toMatch(/^Projects\/\d{4}-\d{2}-\d{2}-invoice-bundle\.md$/);
    expect(moved.operationId).toMatch(/^dohc-operation:/);
    expect(moved.attachments).toHaveLength(2);

    const movedNoteText = await readFile(join(rootPath, moved.toPath), "utf8");
    const firstLeaf = moved.attachments[0]!.toPath.split("/").at(-1)!;
    const secondLeaf = moved.attachments[1]!.toPath.split("/").at(-1)!;
    expect(movedNoteText).toContain(`Attachment: ${moved.attachments[0]!.toPath}`);
    expect(movedNoteText).toContain(`![front.png](${firstLeaf})`);
    expect(movedNoteText).toContain(`![back.png](${secondLeaf})`);
    expect(movedNoteText).not.toContain("(files/");

    // Refuses moving into Inbox/ or shared-with-me/.
    const another = await addInboxItem(operation, { title: "Stay" }, personAuthor, "cli", host);
    await expect(
      moveInboxItem(
        operation,
        { item: another.path, targetFolder: INBOX_COLLECTION_PATH },
        personAuthor,
        host,
      ),
    ).rejects.toThrow(/outside Inbox/);
    await expect(
      moveInboxItem(
        operation,
        { item: another.path, targetFolder: "shared-with-me/team" },
        personAuthor,
        host,
      ),
    ).rejects.toThrow(/shared-with-me/);
  });

  it("does not publish a Quick Capture draft when the native file picker is cancelled", async () => {
    const { rootPath, operation, host } = await makeWorkspace();
    const handlers = createInboxIpcHandlers({
      exactRendererWorkspaceReferences: {
        capture: async () => "ref-1",
        withReference: async (_sender, _ref, _msg, work) => work(operation),
      },
      withRendererWorkspaceOperation: async (_sender, _wsId, _msg, work) => work(operation),
      localPerson: async () => personAuthor,
      hostFor: () => host,
    });

    const outcome = await handlers.desktop.inboxCaptureFiles(
      {
        workspaceId: operation.workspace.workspaceId,
        pick: true,
        title: "Unfinished draft title",
        body: "Should never publish on Cancel",
      },
      { event: { sender: {} as never } },
    );
    expect(outcome).toEqual({
      items: [],
      skipped: 0,
      skippedSources: [],
      createdInbox: false,
    });
    await expect(readFile(join(rootPath, INBOX_SCHEMA_PATH), "utf8")).rejects.toThrow();
  });

  it("refuses read-only workspaces and received share views at every entry point", async () => {
    const readOnly = await makeWorkspace({ readOnly: true });
    await expect(listInboxItems(readOnly.operation.workspace, {}, readOnly.host)).rejects.toThrow(
      /owning writable workspace/,
    );
    await expect(
      addInboxItem(
        readOnly.operation,
        { title: "Blocked" },
        personAuthor,
        "capture",
        readOnly.host,
      ),
    ).rejects.toThrow(/owning writable workspace/);
    await expect(
      archiveInboxItem(
        readOnly.operation,
        { item: "Inbox/a.md" },
        personAuthor,
        personAuthor,
        readOnly.host,
      ),
    ).rejects.toThrow(/owning writable workspace/);
    await expect(
      moveInboxItem(
        readOnly.operation,
        { item: "Inbox/a.md", targetFolder: "" },
        personAuthor,
        readOnly.host,
      ),
    ).rejects.toThrow(/owning writable workspace/);

    const shared = await makeWorkspace({ shareView: { shareId: "s1" } });
    await expect(listInboxItems(shared.operation.workspace, {}, shared.host)).rejects.toThrow(
      /owning writable workspace/,
    );
    await expect(
      addInboxItem(shared.operation, { title: "Blocked" }, personAuthor, "capture", shared.host),
    ).rejects.toThrow(/owning writable workspace/);
    await expect(
      archiveInboxItem(
        shared.operation,
        { item: "Inbox/a.md" },
        personAuthor,
        personAuthor,
        shared.host,
      ),
    ).rejects.toThrow(/owning writable workspace/);
    await expect(
      moveInboxItem(
        shared.operation,
        { item: "Inbox/a.md", targetFolder: "" },
        personAuthor,
        shared.host,
      ),
    ).rejects.toThrow(/owning writable workspace/);
  });

  it("skips files whose normalized destination becomes a secret path without creating Inbox and ignores unrelated Inbox/files/probe", async () => {
    const { rootPath, operation, host } = await makeWorkspace();
    const externalDir = await mkdtemp(join(tmpdir(), "dohc-drop-norm-secret-"));
    tempDirs.push(externalDir);

    const normalizedSecret = join(externalDir, "invoice.eñnv");
    await writeFile(normalizedSecret, "SECRET=1\n", "utf8");

    const skippedOnly = await captureFilesToInbox(
      operation,
      { droppedPaths: [normalizedSecret] },
      personAuthor,
      host,
    );
    expect(skippedOnly.createdInbox).toBe(false);
    expect(skippedOnly.items).toEqual([]);
    expect(skippedOnly.skippedSources).toEqual([{ name: "invoice.eñnv", reason: "secret-file" }]);
    await expect(readFile(join(rootPath, INBOX_SCHEMA_PATH), "utf8")).rejects.toThrow();

    // An unrelated file or symlink named Inbox/files/probe does not block valid captures.
    await mkdir(join(rootPath, INBOX_FILES_DIR), { recursive: true });
    await writeFile(join(rootPath, INBOX_FILES_DIR, "probe"), "unrelated\n", "utf8");
    const goodFile = join(externalDir, "receipt.txt");
    await writeFile(goodFile, "Coffee $5\n", "utf8");
    const captured = await captureFilesToInbox(
      operation,
      { droppedPaths: [goodFile] },
      personAuthor,
      host,
    );
    expect(captured.items).toHaveLength(1);
    expect(captured.items[0]!.attachments).toEqual([`${INBOX_FILES_DIR}/receipt.txt`]);
  });

  it("trusts an empty engine query result and passes singular CollectionQueryParams.filter", async () => {
    const { operation, host } = await makeWorkspace();
    await addInboxItem(operation, { title: "New item" }, personAuthor, "capture", host);
    let capturedQuery: Record<string, unknown> | null = null;
    const indexedHost: WorkspaceInboxHost = {
      ...host,
      withAdapter: async (work) =>
        work({
          queryCollectionRecords: async (params: Record<string, unknown>) => {
            capturedQuery = params;
            return {
              records: [],
              nextCursor: null,
            };
          },
        } as never),
    };
    const archived = await listInboxItems(operation.workspace, { status: "Archived" }, indexedHost);
    expect(archived).toEqual({ exists: true, items: [], hasMore: false });
    expect(capturedQuery).toEqual({
      collectionPath: INBOX_COLLECTION_PATH,
      filter: { field: "Status", operator: "equals", value: "Archived" },
      sort: [{ field: "Received", direction: "desc" }],
      limit: 51,
    });
    expect(capturedQuery).not.toHaveProperty("filters");
  });

  it("preserves settled live edits during move link rewrite and guards Archive/Move Undo", async () => {
    const { rootPath, operation, host } = await makeWorkspace();
    await mkdir(join(rootPath, "Projects"), { recursive: true });
    const pngBase64 = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64");
    const captured = await captureFilesToInbox(
      operation,
      {
        title: "Receipts",
        body: "Initial note",
        pastedImages: [{ name: "back [2].png", mimeType: "image/png", bytesBase64: pngBase64 }],
      },
      personAuthor,
      host,
    );
    const item = captured.items[0]!;

    // Archive Undo restores Status only when canonical Y.Doc still holds "Archived".
    const archived = await archiveInboxItem(
      operation,
      { item: item.path },
      personAuthor,
      personAuthor,
      host,
    );
    expect(archived).toEqual({ path: item.path, previousStatus: "New", changed: true });

    // Simulate a concurrent canonical change to "Filed" before Undo runs.
    const noteAbs = join(rootPath, item.path);
    const archivedText = await readFile(noteAbs, "utf8");
    await writeFile(noteAbs, archivedText.replace("Status: Archived", "Status: Filed"), "utf8");
    const skippedUndoArchive = await undoArchiveInboxItem(
      operation,
      { item: item.path, previousStatus: "New" },
      personAuthor,
      host,
    );
    expect(skippedUndoArchive).toEqual({
      path: item.path,
      restored: false,
      currentStatus: "Filed",
    });
    expect(await readFile(noteAbs, "utf8")).toContain("Status: Filed");

    // Re-archive then undo while still "Archived" -> restores "Filed".
    const reArchived = await archiveInboxItem(
      operation,
      { item: item.path },
      personAuthor,
      personAuthor,
      host,
    );
    expect(reArchived.previousStatus).toBe("Filed");
    const restoredArchive = await undoArchiveInboxItem(
      operation,
      { item: item.path, previousStatus: reArchived.previousStatus },
      personAuthor,
      host,
    );
    expect(restoredArchive).toEqual({
      path: item.path,
      restored: true,
      currentStatus: "Filed",
    });

    // Simulate beforeMove settling a live Y.Doc prose edit right as moveFile moves the note.
    const settlingHost: WorkspaceInboxHost = {
      ...host,
      moveFile: async (moveInput) => {
        const result = await host.moveFile(moveInput);
        if (moveInput.fromPath === item.path) {
          const movedAbs = join(rootPath, result.toPath);
          const current = await readFile(movedAbs, "utf8");
          await writeFile(movedAbs, `${current}\nSettled right before move.\n`, "utf8");
        }
        return result;
      },
    };
    const moved = await moveInboxItem(
      operation,
      { item: item.path, targetFolder: "Projects" },
      personAuthor,
      settlingHost,
    );
    const movedText = await readFile(join(rootPath, moved.toPath), "utf8");
    expect(movedText).toContain("Settled right before move.");
    expect(movedText).toContain(`Attachment: ${moved.attachments[0]!.toPath}`);
    expect(movedText).toContain(
      `![back \\[2\\].png](${moved.attachments[0]!.toPath.split("/").at(-1)})`,
    );

    // Edit the filed note after moving, then block old path: Move Undo refuses WITHOUT mutating the filed note.
    const editedFiledText = `${movedText}\nAdded follow-up after filing.\n`;
    await writeFile(join(rootPath, moved.toPath), editedFiledText, "utf8");
    await writeFile(join(rootPath, moved.fromPath), "blocker file\n", "utf8");
    await expect(
      undoMoveInboxItem(
        operation,
        {
          fromPath: moved.fromPath,
          toPath: moved.toPath,
          operationId: moved.operationId,
          attachments: moved.attachments,
        },
        personAuthor,
        host,
      ),
    ).rejects.toThrow(/occupies the old path/i);
    expect(await readFile(join(rootPath, moved.toPath), "utf8")).toBe(editedFiledText);

    // Clear blocker: Move Undo moves both files back, restores links, AND preserves later prose edits!
    await rm(join(rootPath, moved.fromPath));
    const undone = await undoMoveInboxItem(
      operation,
      {
        fromPath: moved.fromPath,
        toPath: moved.toPath,
        operationId: moved.operationId,
        attachments: moved.attachments,
      },
      personAuthor,
      host,
    );
    expect(undone).toEqual({ ok: true });
    const restoredNote = await readFile(join(rootPath, moved.fromPath), "utf8");
    expect(restoredNote).toContain(`Attachment: ${moved.attachments[0]!.fromPath}`);
    expect(restoredNote).toContain(
      `![back \\[2\\].png](files/${moved.attachments[0]!.fromPath.slice(`${INBOX_FILES_DIR}/`.length)})`,
    );
    expect(restoredNote).toContain("Settled right before move.");
    expect(restoredNote).toContain("Added follow-up after filing.");
    await expect(readFile(join(rootPath, moved.attachments[0]!.fromPath))).resolves.toBeTruthy();
  });

  it("discovers attachments added during note beforeMove settlement and rolls back cleanly on Undo link-rewrite or cached-history retry failures", async () => {
    const { rootPath, operation, host } = await makeWorkspace();
    await mkdir(join(rootPath, "Projects"), { recursive: true });
    await mkdir(join(rootPath, INBOX_FILES_DIR), { recursive: true });
    await writeFile(join(rootPath, INBOX_FILES_DIR, "late-receipt.png"), Buffer.from([1, 2, 3]));

    const added = await addInboxItem(
      operation,
      { title: "Live edited note", body: "No link yet on disk." },
      personAuthor,
      "capture",
      host,
    );

    // Simulate beforeMove flushing a live edit that adds ![late-receipt.png](files/late-receipt.png).
    const lateLinkHost: WorkspaceInboxHost = {
      ...host,
      moveFile: async (moveInput) => {
        const result = await host.moveFile(moveInput);
        if (moveInput.fromPath === added.path) {
          const movedAbs = join(rootPath, result.toPath);
          const text = await readFile(movedAbs, "utf8");
          await writeFile(
            movedAbs,
            `${text}\n![late-receipt.png](files/late-receipt.png)\n`,
            "utf8",
          );
        }
        return result;
      },
    };
    const moved = await moveInboxItem(
      operation,
      { item: added.path, targetFolder: "Projects" },
      personAuthor,
      lateLinkHost,
    );
    expect(moved.attachments).toHaveLength(1);
    expect(moved.attachments[0]!.fromPath).toBe(`${INBOX_FILES_DIR}/late-receipt.png`);
    expect(moved.attachments[0]!.toPath).toBe("Projects/late-receipt.png");
    const movedText = await readFile(join(rootPath, moved.toPath), "utf8");
    expect(movedText).toContain("![late-receipt.png](late-receipt.png)");

    // Simulate History caching the first undoOperation result (matching workspaceMoveRecovery record.result).
    const consumedUndoOps = new Set<string>();
    let failAttUndoOnce = true;
    let failLinkRewriteOnce = true;
    const retryHost: WorkspaceInboxHost = {
      ...host,
      undoOperation: async (operationId, author) => {
        if (operationId === moved.attachments[0]!.operationId && failAttUndoOnce) {
          failAttUndoOnce = false;
          throw new Error("Attachment locked on first try");
        }
        if (consumedUndoOps.has(operationId)) {
          // Cached record.result: returns without moving disk files.
          return;
        }
        consumedUndoOps.add(operationId);
        await host.undoOperation!(operationId, author);
      },
      capture: {
        ...host.capture,
        writeAuthoredFile: async (absPath, content, author, opts) => {
          if (failLinkRewriteOnce && absPath === join(rootPath, moved.fromPath)) {
            failLinkRewriteOnce = false;
            throw new Error("Transient link rewrite failure");
          }
          return host.capture.writeAuthoredFile(absPath, content, author, opts);
        },
      },
    };

    const undoPayload = {
      fromPath: moved.fromPath,
      toPath: moved.toPath,
      operationId: moved.operationId,
      attachments: moved.attachments,
    };

    // Attempt 1: note undo succeeds (and is cached in History), attachment undo fails -> note rolled back to Projects/.
    await expect(
      undoMoveInboxItem(operation, undoPayload, personAuthor, retryHost),
    ).rejects.toThrow(/Attachment locked on first try/);
    expect(await readFile(join(rootPath, moved.toPath), "utf8")).toContain(
      "![late-receipt.png](late-receipt.png)",
    );
    await expect(readFile(join(rootPath, moved.attachments[0]!.toPath))).resolves.toBeTruthy();

    // Attempt 2: cached note undo is recovered via moveFile, attachment undo succeeds, link rewrite fails -> BOTH rolled back to Projects/!
    await expect(
      undoMoveInboxItem(operation, undoPayload, personAuthor, retryHost),
    ).rejects.toThrow(/Transient link rewrite failure/);
    expect(await readFile(join(rootPath, moved.toPath), "utf8")).toContain(
      "![late-receipt.png](late-receipt.png)",
    );
    await expect(readFile(join(rootPath, moved.attachments[0]!.toPath))).resolves.toBeTruthy();

    // Attempt 3: both History undo ops are already cached, yet retry succeeds cleanly and restores links!
    await expect(
      undoMoveInboxItem(operation, undoPayload, personAuthor, retryHost),
    ).resolves.toEqual({ ok: true });
    expect(await readFile(join(rootPath, moved.fromPath), "utf8")).toContain(
      "![late-receipt.png](files/late-receipt.png)",
    );
    await expect(readFile(join(rootPath, moved.attachments[0]!.fromPath))).resolves.toBeTruthy();

    // Oversized attachment source path (> 4096 chars) is refused before moving, rolling back the note.
    const deepSegments = Array.from(
      { length: 42 },
      (_, i) => `seg-${String(i).padStart(2, "0")}-${"a".repeat(90)}`,
    ).join("/");
    const oversizedRel = `files/${deepSegments}/leaf.txt`;
    expect(`${INBOX_COLLECTION_PATH}/${oversizedRel}`.length).toBeGreaterThan(4096);
    const oversizedNote = await addInboxItem(
      operation,
      { title: "Oversized link", body: `[deep](${oversizedRel})` },
      personAuthor,
      "capture",
      host,
    );
    await expect(
      moveInboxItem(
        operation,
        { item: oversizedNote.path, targetFolder: "Projects" },
        personAuthor,
        host,
      ),
    ).rejects.toThrow(/exceeding the 4096-character limit/);
    await expect(readFile(join(rootPath, oversizedNote.path), "utf8")).resolves.toContain(
      "Oversized link",
    );
  });

  it("rolls back earlier committed items when a multi-file capture fails mid-batch and rebases ordinary relative links on Move/Undo", async () => {
    const { rootPath, operation, host } = await makeWorkspace();
    const externalDir = await mkdtemp(join(tmpdir(), "dohc-drop-rollback-"));
    tempDirs.push(externalDir);
    const firstFile = join(externalDir, "first.txt");
    const secondFile = join(externalDir, "second.txt");
    await writeFile(firstFile, "first content\n", "utf8");
    await writeFile(secondFile, "second content\n", "utf8");

    let failOnFourthWrite = true;
    let writeCount = 0;
    const flakyHost: WorkspaceInboxHost = {
      ...host,
      capture: {
        ...host.capture,
        writeAuthoredFile: async (absPath, content, author, opts) => {
          writeCount += 1;
          // 1: Inbox/collection.yaml, 2: first.txt, 3: first note, 4: second.txt (or second note)
          if (failOnFourthWrite && writeCount === 4) {
            failOnFourthWrite = false;
            throw new Error("Simulated disk failure on second file");
          }
          return host.capture.writeAuthoredFile(absPath, content, author, opts);
        },
      },
    };

    await expect(
      captureFilesToInbox(
        operation,
        { droppedPaths: [firstFile, secondFile] },
        personAuthor,
        flakyHost,
      ),
    ).rejects.toThrow(/Simulated disk failure on second file/);

    // Earlier item and newly created Inbox schema were rolled back cleanly.
    const afterFailure = await listInboxItems(operation.workspace, {}, host);
    expect(afterFailure).toEqual({ exists: false, items: [], hasMore: false });

    // Retrying the same selection creates exactly 2 items with zero duplicates.
    const retried = await captureFilesToInbox(
      operation,
      { droppedPaths: [firstFile, secondFile] },
      personAuthor,
      host,
    );
    expect(retried.items).toHaveLength(2);
    expect(retried.createdInbox).toBe(true);

    // Moving a note with ordinary relative Markdown links (and no attachments) rebases and restores them on Undo.
    const noteWithLink = await addInboxItem(
      operation,
      { title: "Brief pointer", body: "Check [Brief](../Docs/brief.md#q4) for details." },
      personAuthor,
      "capture",
      host,
    );
    const movedToRoot = await moveInboxItem(
      operation,
      { item: noteWithLink.path, targetFolder: "" },
      personAuthor,
      host,
    );
    expect(await readFile(join(rootPath, movedToRoot.toPath), "utf8")).toContain(
      "Check [Brief](Docs/brief.md#q4) for details.",
    );
    await undoMoveInboxItem(
      operation,
      {
        fromPath: movedToRoot.fromPath,
        toPath: movedToRoot.toPath,
        operationId: movedToRoot.operationId,
        attachments: movedToRoot.attachments,
      },
      personAuthor,
      host,
    );
    expect(await readFile(join(rootPath, movedToRoot.fromPath), "utf8")).toContain(
      "Check [Brief](../Docs/brief.md#q4) for details.",
    );
  });
});
