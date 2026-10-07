import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { foldScene, insertElementRevision, setAppStateProperty } from "@dohc/excalidraw-scene";
import { markdownToYDoc, yDocToMarkdown } from "@dohc/ydoc-projection";
import { createWorkspaceAuthorityOwner } from "./workspaceAuthorityOwner";
import { createPhysicalWorkspaceRemoval } from "./physicalWorkspaceRemoval";
import { preserveLiveDraft, preserveUnsentLiveDraft, removeWorkspaceLiveDrafts } from "./liveDraftRecovery";

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {...actual, writeFile: vi.fn(actual.writeFile), readFile: vi.fn(actual.readFile), rm: vi.fn(actual.rm)};
});
const directories: string[] = [];
afterEach(async () => {
  vi.mocked(writeFile).mockReset();
  vi.mocked(readFile).mockReset();
  vi.mocked(rm).mockReset();
  for (const directory of directories.splice(0)) await rm(directory, {recursive: true, force: true});
});

it("keeps a complete recovery when a repeated snapshot write fails after partial output", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dohc-atomic-recovery-")); directories.push(directory);
  const draft = {path: "docs/a.md", objectId: "object", remoteWorkspaceId: "owner", update: new Uint8Array([0, 0])};
  await preserveLiveDraft(directory, "recipient", draft);
  const names = await readdir(directory);
  const original = await readFile(join(directory, names[0]!));
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(writeFile).mockImplementationOnce(async (path, _content, options) => {
    await actual.writeFile(path, "partial", options);
    throw new Error("flush failed");
  });
  await expect(preserveLiveDraft(directory, "recipient", draft)).rejects.toThrow("flush failed");
  expect(await readdir(directory)).toEqual(names);
  expect(await readFile(join(directory, names[0]!))).toEqual(original);
  await preserveLiveDraft(directory, "recipient", draft);
  expect(await readdir(directory)).toEqual(names);
  expect(await readFile(join(directory, names[0]!))).toEqual(original);
});

it.each(["plaintext", "richdoc"] as const)("preserves faithful %s text and exact CRDT state in a local set-aside draft", async contentKind => {
  const directory = await mkdtemp(join(tmpdir(), "dohc-unsent-recovery-")); directories.push(directory);
  const text = "# Plan\n\nTyped **before** terminal refusal.\n";
  const doc = contentKind === "richdoc" ? markdownToYDoc(text) : new Y.Doc();
  if (contentKind === "plaintext") doc.getText("plainText").insert(0, text);
  const projection = contentKind === "richdoc" ? yDocToMarkdown(doc) : text;
  try {
    await preserveUnsentLiveDraft(directory, "local-workspace", { path: "notes/plan.md", objectId: "object", contentKind, doc });
    const names = await readdir(directory);
    expect(names).toHaveLength(1);
    const stored = JSON.parse(await readFile(join(directory, names[0]!), "utf8"));
    expect(stored).toMatchObject({ workspaceId: "local-workspace", path: "notes/plan.md", objectId: "object", text: projection });
    expect(stored).not.toHaveProperty("remoteWorkspaceId");
    const recovered = new Y.Doc();
    try {
      Y.applyUpdate(recovered, Buffer.from(stored.updateBase64, "base64"));
      expect(contentKind === "richdoc" ? yDocToMarkdown(recovered) : recovered.getText("plainText").toString()).toBe(projection);
    } finally { recovered.destroy(); }
  } finally { doc.destroy(); }
});

it("writes sensitive recovery records with owner-only permissions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dohc-private-recovery-")); directories.push(directory);
  await preserveLiveDraft(directory, "workspace", {path: "a.md", objectId: "object", remoteWorkspaceId: "owner", update: new Uint8Array([0, 0])});
  expect(vi.mocked(writeFile).mock.calls[0]?.[2]).toMatchObject({mode: 0o600, flush: true, flag: "wx"});
  if (process.platform !== "win32") expect((await stat(join(directory, (await readdir(directory))[0]!))).mode & 0o777).toBe(0o600);
});

it("preserves a scene as an exact CRDT recovery without projecting text", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dohc-scene-recovery-")); directories.push(directory);
  const doc = new Y.Doc();
  const drawing = {id: "rectangle", x: 42, y: 17, type: "rectangle", version: 1, versionNonce: 1, isDeleted: false};
  insertElementRevision(doc, drawing);
  setAppStateProperty(doc, "viewBackgroundColor", "#ffffff");
  const recovered = new Y.Doc();
  try {
    await preserveUnsentLiveDraft(directory, "workspace", {path: "drawing.excalidraw", objectId: "drawing", contentKind: "scene", doc});
    const stored = JSON.parse(await readFile(join(directory, (await readdir(directory))[0]!), "utf8"));
    expect(stored).toMatchObject({workspaceId: "workspace", contentKind: "scene"});
    expect(stored).not.toHaveProperty("text");
    Y.applyUpdate(recovered, Buffer.from(stored.updateBase64, "base64"));
    expect(foldScene(recovered)).toEqual({elements: [drawing], appState: {viewBackgroundColor: "#ffffff"}, assets: {}});
  } finally {doc.destroy(); recovered.destroy();}
});

it("removes all draft records only for the workspace removed from dohc", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dohc-forget-recovery-")); directories.push(directory);
  const draft = {path: "a.md", objectId: "object", remoteWorkspaceId: "owner", update: new Uint8Array([0, 0])};
  await preserveLiveDraft(directory, "removed", draft);
  await preserveLiveDraft(directory, "removed", {...draft, path: "b.md"});
  await preserveLiveDraft(directory, "kept", draft);
  await removeWorkspaceLiveDrafts(directory, "removed");
  const names = await readdir(directory);
  expect(names).toHaveLength(1);
  expect(JSON.parse(await readFile(join(directory, names[0]!), "utf8"))).toMatchObject({workspaceId: "kept"});
  await removeWorkspaceLiveDrafts(directory, "removed");
  expect(await readdir(directory)).toEqual(names);
  await removeWorkspaceLiveDrafts(join(directory, "absent"), "removed");
});

it("forgets matching drafts despite a malformed record and removes interrupted temporary writes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dohc-forget-malformed-")); directories.push(directory);
  const draft = {path: "a.md", objectId: "object", remoteWorkspaceId: "owner", update: new Uint8Array([0, 0])};
  const malformed = `${"0".repeat(64)}.json`;
  await writeFile(join(directory, malformed), "{");
  await writeFile(join(directory, `${"1".repeat(64)}.interrupted.tmp`), '{"text":"partial private text');
  await preserveLiveDraft(directory, "removed", draft);
  await preserveLiveDraft(directory, "kept", draft);
  await removeWorkspaceLiveDrafts(directory, "removed");
  const names = await readdir(directory);
  expect(names).toContain(malformed);
  expect(names).toHaveLength(2);
  const kept = names.find(name => name !== malformed)!;
  expect(JSON.parse(await readFile(join(directory, kept), "utf8"))).toMatchObject({workspaceId: "kept"});
});

it.each(["read", "delete"] as const)("two concurrent forgets tolerate a record that vanishes before %s", async phase => {
  const directory = await mkdtemp(join(tmpdir(), "dohc-forget-concurrent-")); directories.push(directory);
  const draft = {path: "a.md", objectId: "object", remoteWorkspaceId: "owner", update: new Uint8Array([0, 0])};
  await preserveLiveDraft(directory, "first", draft);
  await preserveLiveDraft(directory, "second", draft);
  await preserveLiveDraft(directory, "kept", draft);
  const names = await readdir(directory);
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  let resume!: () => void;
  let reached!: () => void;
  const paused = new Promise<void>(resolve => { reached = resolve; });
  const continued = new Promise<void>(resolve => { resume = resolve; });
  const firstName = (await Promise.all(names.map(async name => ({
    name, record: JSON.parse(await readFile(join(directory, name), "utf8")),
  })))).find(entry => entry.record.workspaceId === "first")!.name;
  const firstPath = join(directory, firstName);
  let blocked = false;
  if (phase === "read") {
    vi.mocked(readFile).mockImplementation(async (path, options) => {
      if (path === firstPath && !blocked) {
        blocked = true;
        reached();
        await continued;
      }
      return actual.readFile(path, options);
    });
  } else {
    vi.mocked(rm).mockImplementation(async (path, options) => {
      if (path === firstPath && !blocked) {
        blocked = true;
        reached();
        await continued;
      }
      return actual.rm(path, options);
    });
  }
  const pausedForget = removeWorkspaceLiveDrafts(directory, phase === "read" ? "second" : "first");
  await paused;
  try { await removeWorkspaceLiveDrafts(directory, "first"); }
  finally { resume(); }
  await pausedForget;
  if (phase === "delete") await removeWorkspaceLiveDrafts(directory, "second");
  const remaining = await readdir(directory);
  expect(remaining).toHaveLength(1);
  expect(JSON.parse(await readFile(join(directory, remaining[0]!), "utf8"))).toMatchObject({workspaceId: "kept"});
});

it("removes leftover temporary drafts without interrupting another workspace's preservation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dohc-forget-writing-")); directories.push(directory);
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const leftover = join(directory, "interrupted.tmp");
  await writeFile(leftover, "private text from an interrupted write");
  let resume!: () => void;
  let reached!: () => void;
  const paused = new Promise<void>(resolve => { reached = resolve; });
  const continued = new Promise<void>(resolve => { resume = resolve; });
  vi.mocked(writeFile).mockImplementationOnce(async (path, content, options) => {
    await actual.writeFile(path, content, options);
    reached();
    await continued;
  });
  const preserving = preserveLiveDraft(directory, "kept", {
    path: "a.md", objectId: "object", remoteWorkspaceId: "owner", update: new Uint8Array([0, 0]),
  });
  await paused;
  try {
    await removeWorkspaceLiveDrafts(directory, "removed");
    expect(await readdir(directory)).toHaveLength(1);
    await expect(readFile(leftover)).rejects.toMatchObject({code: "ENOENT"});
  } finally { resume(); }
  await preserving;
  const names = await readdir(directory);
  expect(names).toHaveLength(1);
  expect(names[0]).toMatch(/\.json$/);
  expect(JSON.parse(await readFile(join(directory, names[0]!), "utf8"))).toMatchObject({workspaceId: "kept"});
});

it.each([false, true])("keeps recovery records until registry removal succeeds: refusal=%s", async refused => {
  const directory = await mkdtemp(join(tmpdir(), "dohc-forget-confirmed-")); directories.push(directory);
  const initial = {workspaceId: "workspace", rootPath: "original-root"};
  let registered: typeof initial | null = initial;
  const owner = createWorkspaceAuthorityOwner({
    findWorkspace: () => registered,
    canonicalizeRoot: path => path,
    createState: () => ({}),
  });
  const binding = owner.currentBinding(initial.workspaceId);
  await preserveLiveDraft(directory, initial.workspaceId, {
    path: "a.md", objectId: "object", remoteWorkspaceId: "owner", update: new Uint8Array([0, 0]),
  });
  const names = await readdir(directory);
  const original = await readFile(join(directory, names[0]!));
  const removeDrafts = vi.fn((workspaceId: string) => removeWorkspaceLiveDrafts(directory, workspaceId));
  const removeWorkspace = vi.fn(() => { registered = null; });
  const removePhysicalWorkspace = createPhysicalWorkspaceRemoval({
    retireBinding: (target, retirement) => owner.retireBinding(target, retirement),
    findWorkspace: () => registered,
    removeWorkspace,
    removeDrafts,
    onError: vi.fn(),
  });
  const removing = removePhysicalWorkspace(binding, () => {
    if (refused) registered = {...initial, rootPath: "replacement-root"};
  });
  if (refused) {
    await expect(removing).rejects.toThrow("The workspace registry binding changed before removal completed.");
    expect(registered).toEqual({...initial, rootPath: "replacement-root"});
    expect(await readdir(directory)).toEqual(names);
    expect(await readFile(join(directory, names[0]!))).toEqual(original);
    expect(removeWorkspace).not.toHaveBeenCalled();
    expect(removeDrafts).not.toHaveBeenCalled();
  } else {
    await removing;
    expect(registered).toBeNull();
    expect(removeWorkspace).toHaveBeenCalledOnce();
    expect(removeDrafts).toHaveBeenCalledExactlyOnceWith(initial.workspaceId);
    expect(removeWorkspace.mock.invocationCallOrder[0]).toBeLessThan(removeDrafts.mock.invocationCallOrder[0]!);
    expect(await readdir(directory)).toEqual([]);
  }
});
