import { mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { foldScene, insertElementRevision, setAppStateProperty } from "@dohc/excalidraw-scene";
import { markdownToYDoc, yDocToMarkdown } from "@dohc/ydoc-projection";
import { createWorkspaceAuthorityOwner } from "./workspaceAuthorityOwner";
import { createPhysicalWorkspaceRemoval } from "./physicalWorkspaceRemoval";
import { hasRetainedLiveDraft, listLiveDraftRecovery, preserveLiveDraft, preserveUnsentLiveDraft, removeLiveDraftCopies, removeWorkspaceLiveDrafts } from "./liveDraftRecovery";
const snapshotSha = (update: Uint8Array) => createHash("sha256").update(update).digest("hex");

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

it("finds retained drafts by workspace and object or path without blocking unrelated files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dohc-restore-recovery-")); directories.push(directory);
  const draft = {path: "a.md", objectId: "object", remoteWorkspaceId: "owner", update: new Uint8Array([0, 0])};
  await preserveLiveDraft(directory, "workspace", draft);
  expect(await hasRetainedLiveDraft(directory, "workspace", "renamed.md", "object")).toBe(true);
  expect(await hasRetainedLiveDraft(directory, "workspace", "a.md", "replacement")).toBe(true);
  expect(await hasRetainedLiveDraft(directory, "other", "a.md", "object")).toBe(false);
  expect(await hasRetainedLiveDraft(directory, "workspace", "b.md", "other")).toBe(false);
  expect(await hasRetainedLiveDraft(join(directory, "absent"), "workspace", "a.md", "object")).toBe(false);
});

it.each(["malformed", "incomplete"] as const)("does not block restore with %s recovery state nobody can review", async kind => {
  const directory = await mkdtemp(join(tmpdir(), "dohc-restore-recovery-")); directories.push(directory);
  await writeFile(join(directory, `${"0".repeat(64)}.${kind === "incomplete" ? "tmp" : "json"}`), "{");
  expect(await hasRetainedLiveDraft(directory, "workspace", "a.md", "object")).toBe(false);
});

it.each(["half-written temp", "invalid path", "non-string update", "untracked path", "invalid CRDT"])("does not hide other drafts or fail dismissal beside a %s record", async kind => {
  const directory = await mkdtemp(join(tmpdir(), "dohc-bad-recovery-")); directories.push(directory);
  const update = new Uint8Array([0, 0]);
  const draft = {path: "a.txt", objectId: "object", contentKind: "plaintext" as const, text: "seen", update};
  await preserveLiveDraft(directory, "workspace", draft);
  await preserveLiveDraft(directory, "workspace", {...draft, text: "survivor"});
  const bad = join(directory, `${"0".repeat(64)}.${kind === "half-written temp" ? "tmp" : "json"}`);
  await writeFile(bad, kind === "half-written temp" ? '{"workspaceId":"workspace","path":"a.txt",' : JSON.stringify({
    workspaceId: "workspace", objectId: "object", path: kind === "invalid path" ? 7 : kind === "untracked path" ? ".env" : "a.txt",
    updateBase64: kind === "non-string update" ? 7 : "AAE=",
  }));
  const records = await listLiveDraftRecovery(directory, "workspace");
  expect(records.map(record => record.text).sort()).toEqual(["seen", "survivor"]);
  const seen = records.find(record => record.text === "seen")!;
  const after = await removeLiveDraftCopies(directory, "workspace", "object", snapshotSha(update), Date.now(), "a.txt", seen.recordId);
  expect(after.map(record => record.text)).toEqual(["survivor"]);
  expect(await hasRetainedLiveDraft(directory, "workspace", "a.txt", "object")).toBe(true);
  await removeLiveDraftCopies(directory, "workspace", "object", snapshotSha(update), Date.now(), "a.txt", after[0]!.recordId);
  expect(await hasRetainedLiveDraft(directory, "workspace", "a.txt", "object")).toBe(false);
  expect(await readdir(directory)).toEqual([bad.slice(directory.length + 1)]);
});

it.each(["EBUSY", "EACCES", "EMFILE"])("reports %s as a read failure and refuses to prove restore safe", async code => {
  const directory = await mkdtemp(join(tmpdir(), "dohc-recovery-io-")); directories.push(directory);
  await preserveLiveDraft(directory, "workspace", {path: "a.txt", objectId: "object", contentKind: "plaintext", text: "unseen typing", update: new Uint8Array([0, 0])});
  const error = Object.assign(new Error("temporary read failure"), {code});
  vi.mocked(readFile).mockRejectedValue(error);
  await expect(listLiveDraftRecovery(directory, "workspace")).rejects.toBe(error);
  await expect(hasRetainedLiveDraft(directory, "workspace", "a.txt", "object")).rejects.toBe(error);
  await expect(removeLiveDraftCopies(directory, "workspace", "object", snapshotSha(new Uint8Array([0, 0])), Date.now(), "a.txt")).rejects.toBe(error);
  expect(await readdir(directory)).toHaveLength(1);
});

it("includes a draft saved after the initial dismiss scan in the reply", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dohc-dismiss-newer-")); directories.push(directory);
  const draft = {path: "a.txt", objectId: "object", contentKind: "plaintext" as const, text: "seen", update: new Uint8Array([0, 0])};
  await preserveLiveDraft(directory, "workspace", draft);
  const seen = (await listLiveDraftRecovery(directory, "workspace"))[0]!;
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(rm).mockImplementationOnce(async (path, options) => {
    await actual.rm(path, options);
    await preserveLiveDraft(directory, "workspace", {...draft, text: "saved during dismiss"});
  });
  await expect(removeLiveDraftCopies(directory, "workspace", "object", snapshotSha(draft.update), Date.now(), "a.txt", seen.recordId))
    .resolves.toEqual([expect.objectContaining({text: "saved during dismiss"})]);
});

it("skips an active half-written temporary record until preserve completes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dohc-active-recovery-")); directories.push(directory);
  const draft = {path: "a.txt", objectId: "object", contentKind: "plaintext" as const, text: "seen", update: new Uint8Array([0, 0])};
  await preserveLiveDraft(directory, "workspace", draft);
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const writing = new Promise<void>(resolve => { started = resolve; });
  vi.mocked(writeFile).mockImplementationOnce(async (path, content, options) => {
    await actual.writeFile(path, '{"workspaceId":"workspace","path":"other.txt",', options);
    started(); await gate;
    await actual.writeFile(path, content, {encoding: "utf8"});
  });
  const preserving = preserveLiveDraft(directory, "workspace", {...draft, path: "other.txt", objectId: "other", text: "active copy"});
  try {
    await writing;
    const records = await listLiveDraftRecovery(directory, "workspace");
    expect(records.map(record => record.text)).toEqual(["seen"]);
    expect(await hasRetainedLiveDraft(directory, "workspace", "other.txt", "other")).toBe(false);
    await expect(removeLiveDraftCopies(directory, "workspace", "object", snapshotSha(draft.update), Date.now(), "a.txt", records[0]!.recordId)).resolves.toEqual([]);
  } finally { release(); await preserving; }
  expect((await listLiveDraftRecovery(directory, "workspace")).map(record => record.text)).toEqual(["active copy"]);
});

it("falls back to known survivors when a disk read fails after deletion", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dohc-dismiss-reply-")); directories.push(directory);
  const draft = {path: "a.txt", objectId: "object", contentKind: "plaintext" as const, text: "seen", update: new Uint8Array([0, 0])};
  await preserveLiveDraft(directory, "workspace", draft);
  await preserveLiveDraft(directory, "workspace", {...draft, text: "survivor"});
  const records = await listLiveDraftRecovery(directory, "workspace");
  const seen = records.find(record => record.text === "seen")!;
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(rm).mockImplementationOnce(async (path, options) => {
    await actual.rm(path, options);
    vi.mocked(readFile).mockRejectedValue(new Error("reading stopped after delete"));
  });
  await expect(removeLiveDraftCopies(directory, "workspace", "object", snapshotSha(draft.update), Date.now(), "a.txt", seen.recordId))
    .resolves.toEqual([expect.objectContaining({text: "survivor"})]);
  expect(await readdir(directory)).toHaveLength(1);
});

it("reports a projection import failure without treating the valid record as absent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dohc-recovery-import-")); directories.push(directory);
  await preserveLiveDraft(directory, "workspace", {path: "a.md", objectId: "object", remoteWorkspaceId: "owner", update: new Uint8Array([0, 0])});
  const error = new Error("projection import failed");
  vi.resetModules();
  vi.doMock("@dohc/ydoc-projection", () => {throw error;});
  try {
    const recovery = await import("./liveDraftRecovery");
    await expect(recovery.listLiveDraftRecovery(directory, "workspace")).rejects.toThrow();
    await expect(recovery.hasRetainedLiveDraft(directory, "workspace", "a.md", "object")).rejects.toThrow();
  } finally {vi.doUnmock("@dohc/ydoc-projection"); vi.resetModules();}
});

it.each(["richdoc", "scene"] as const)("skips one %s record whose projection throws without hiding other drafts or failing dismiss", async kind => {
  const directory = await mkdtemp(join(tmpdir(), "dohc-recovery-projection-")); directories.push(directory);
  const draft = {path: "a.txt", objectId: "object", contentKind: "plaintext" as const, text: "seen", update: new Uint8Array([0, 0])};
  await preserveLiveDraft(directory, "workspace", draft);
  await preserveLiveDraft(directory, "workspace", {...draft, text: "survivor"});
  const bad = new Y.Doc();
  bad.getText("badContent").insert(0, "invalid projection");
  try {
    const update = Y.encodeStateAsUpdate(bad);
    await preserveLiveDraft(directory, "workspace", kind === "scene"
      ? {path: "a.txt", objectId: "object", contentKind: "scene", update}
      : {path: "a.txt", objectId: "object", remoteWorkspaceId: "owner", update});
  } finally {bad.destroy();}
  const scene = await vi.importActual<typeof import("@dohc/excalidraw-scene")>("@dohc/excalidraw-scene");
  const markdown = await vi.importActual<typeof import("@dohc/ydoc-projection")>("@dohc/ydoc-projection");
  const project = () => {throw new Error("invalid document content");};
  vi.resetModules();
  if (kind === "scene") vi.doMock("@dohc/excalidraw-scene", () => ({...scene, exportPortableScene: project}));
  else vi.doMock("@dohc/ydoc-projection", () => ({...markdown, yDocToMarkdown: project}));
  try {
    const recovery = await import("./liveDraftRecovery");
    const records = await recovery.listLiveDraftRecovery(directory, "workspace");
    expect(records.map(record => record.text).sort()).toEqual(["seen", "survivor"]);
    const seen = records.find(record => record.text === "seen")!;
    const after = await recovery.removeLiveDraftCopies(directory, "workspace", "object", snapshotSha(draft.update), Date.now(), "a.txt", seen.recordId);
    expect(after.map(record => record.text)).toEqual(["survivor"]);
    await recovery.removeLiveDraftCopies(directory, "workspace", "object", snapshotSha(draft.update), Date.now(), "a.txt", after[0]!.recordId);
    expect(await recovery.hasRetainedLiveDraft(directory, "workspace", "a.txt", "object")).toBe(false);
    expect(await readdir(directory)).toHaveLength(1);
  } finally {vi.doUnmock("@dohc/excalidraw-scene"); vi.doUnmock("@dohc/ydoc-projection"); vi.resetModules();}
});

it("skips a record removed during the scan", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dohc-recovery-removed-")); directories.push(directory);
  await preserveLiveDraft(directory, "workspace", {path: "a.txt", objectId: "object", contentKind: "plaintext", text: "already removed", update: new Uint8Array([0, 0])});
  vi.mocked(readFile).mockRejectedValue(Object.assign(new Error("removed"), {code: "ENOENT"}));
  await expect(listLiveDraftRecovery(directory, "workspace")).resolves.toEqual([]);
});

it("ignores another workspace's malformed and temporary records", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dohc-scoped-recovery-")); directories.push(directory);
  await writeFile(join(directory, `${"0".repeat(64)}.json`), '{"workspaceId":"other",');
  await writeFile(join(directory, `${"1".repeat(64)}.tmp`), JSON.stringify({workspaceId: "other", path: "a.md", objectId: "object"}));
  expect(await hasRetainedLiveDraft(directory, "workspace", "a.md", "object")).toBe(false);
});

it("quarantines a stale incomplete temporary draft so a later try can prove safety", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dohc-stale-recovery-")); directories.push(directory);
  const name = `${"0".repeat(64)}.tmp`;
  await writeFile(join(directory, name), "{");
  const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
  await utimes(join(directory, name), old, old);
  expect(await hasRetainedLiveDraft(directory, "workspace", "a.md", "object")).toBe(false);
  expect(await readFile(join(directory, "quarantine", name), "utf8")).toBe("{");
  expect(await hasRetainedLiveDraft(directory, "workspace", "a.md", "object")).toBe(false);
});

it("stops blocking a path after its recovery is discarded and preserves other drafts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dohc-retired-recovery-")); directories.push(directory);
  const draft = {path: "a.md", objectId: "object", remoteWorkspaceId: "owner", update: new Uint8Array([0, 0])};
  await preserveLiveDraft(directory, "workspace", draft);
  await preserveLiveDraft(directory, "other", draft);
  await removeLiveDraftCopies(directory, "workspace", "object", snapshotSha(draft.update), Date.now(), "a.md");
  expect(await hasRetainedLiveDraft(directory, "workspace", "a.md", "object")).toBe(false);
  expect(await hasRetainedLiveDraft(directory, "other", "a.md", "object")).toBe(true);
});

it("keeps recovery written after a dismissal request", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dohc-newer-recovery-")); directories.push(directory);
  await preserveLiveDraft(directory, "workspace", {path: "a.md", objectId: "object", remoteWorkspaceId: "owner", update: new Uint8Array([0, 0])});
  const file = join(directory, (await readdir(directory))[0]!);
  const newer = new Date(Date.now() + 1000);
  await utimes(file, newer, newer);
  await removeLiveDraftCopies(directory, "workspace", "object", snapshotSha(new Uint8Array([0, 0])), Date.now(), "a.md");
  expect(await hasRetainedLiveDraft(directory, "workspace", "a.md", "object")).toBe(true);
});

it("discards only the captured snapshot by object after a rename, preserving unseen copies", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dohc-exact-recovery-")); directories.push(directory);
  const update = new Uint8Array([0, 0]);
  const draft = {path: "old.md", objectId: "object", remoteWorkspaceId: "owner", update};
  await preserveLiveDraft(directory, "workspace", draft);
  await preserveLiveDraft(directory, "workspace", {...draft, path: "renamed.md"});
  const unseen = markdownToYDoc("Unseen copy\n");
  const unseenUpdate = Y.encodeStateAsUpdate(unseen);
  unseen.destroy();
  await preserveLiveDraft(directory, "workspace", {...draft, update: unseenUpdate});
  await preserveLiveDraft(directory, "workspace", {...draft, objectId: "replacement"});
  await preserveLiveDraft(directory, "other", draft);
  const remaining = await removeLiveDraftCopies(directory, "workspace", "object", snapshotSha(update), Date.now(), "renamed.md");
  expect(remaining.map(record => record.text)).toEqual(["Unseen copy"]);
  const records = await Promise.all((await readdir(directory)).map(async name => JSON.parse(await readFile(join(directory, name), "utf8"))));
  expect(records).toHaveLength(3);
  expect(records).toEqual(expect.arrayContaining([
    expect.objectContaining({workspaceId: "workspace", objectId: "object", updateBase64: Buffer.from(unseenUpdate).toString("base64")}),
    expect.objectContaining({workspaceId: "workspace", objectId: "replacement"}),
    expect.objectContaining({workspaceId: "other"}),
  ]));
});

it("returns every remaining record for the object or path, and discards a listed record exactly", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dohc-listed-recovery-")); directories.push(directory);
  const seen = new Y.Doc(), unseen = new Y.Doc();
  try {
    seen.getText("plainText").insert(0, "seen"); unseen.getText("plainText").insert(0, "unseen");
    const seenUpdate = Y.encodeStateAsUpdate(seen), unseenUpdate = Y.encodeStateAsUpdate(unseen);
    const draft = {path: "a.txt", objectId: "object", contentKind: "plaintext" as const, text: "seen", update: seenUpdate};
    await preserveLiveDraft(directory, "workspace", draft);
    await preserveLiveDraft(directory, "workspace", {...draft, text: "unseen", update: unseenUpdate});
    await preserveLiveDraft(directory, "workspace", {...draft, path: "renamed.txt", text: "unseen", update: unseenUpdate});
    await preserveLiveDraft(directory, "workspace", {...draft, objectId: "replacement", text: "replacement"});
    await preserveLiveDraft(directory, "workspace", {...draft, path: "other.txt", objectId: "other"});
    await preserveLiveDraft(directory, "other-workspace", draft);
    const remaining = await removeLiveDraftCopies(directory, "workspace", "object", snapshotSha(seenUpdate), Date.now(), "a.txt");
    expect(remaining).toHaveLength(3);
    expect(remaining).toEqual(expect.arrayContaining([
      expect.objectContaining({path: "a.txt", objectId: "object", text: "unseen"}),
      expect.objectContaining({path: "renamed.txt", objectId: "object", text: "unseen"}),
      expect.objectContaining({path: "a.txt", objectId: "replacement", text: "replacement"}),
    ]));
    const target = remaining.find(record => record.path === "a.txt" && record.objectId === "object")!;
    const after = await removeLiveDraftCopies(directory, "workspace", "object", snapshotSha(unseenUpdate), Date.now(), "a.txt", target.recordId);
    expect(after).toHaveLength(2);
    expect(after.some(record => record.recordId === target.recordId)).toBe(false);
    expect(after.some(record => record.path === "renamed.txt")).toBe(true);
    expect(await hasRetainedLiveDraft(directory, "other-workspace", "a.txt", "object")).toBe(true);
    expect(await listLiveDraftRecovery(directory, "workspace")).toHaveLength(3);
  } finally { seen.destroy(); unseen.destroy(); }
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
    expect(await listLiveDraftRecovery(directory, "local-workspace")).toEqual([expect.objectContaining({text: projection, objectId: "object"})]);
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
    const listed = await listLiveDraftRecovery(directory, "workspace");
    expect(JSON.parse(listed[0]!.text)).toMatchObject({type: "excalidraw", elements: [expect.objectContaining({id: "rectangle", x: 42, y: 17})]});
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
  const temporary = join(directory, `${"1".repeat(64)}.interrupted.tmp`);
  await writeFile(temporary, '{"text":"partial private text');
  const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
  await utimes(temporary, old, old);
  await preserveLiveDraft(directory, "removed", draft);
  await preserveLiveDraft(directory, "kept", draft);
  await removeWorkspaceLiveDrafts(directory, "removed");
  const names = await readdir(directory);
  expect(names).toContain(malformed);
  expect(names).toHaveLength(3);
  expect(names).toContain("quarantine");
  const kept = names.find(name => name !== malformed && name !== "quarantine")!;
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
  const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
  await utimes(leftover, old, old);
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
    expect(await readdir(directory)).toHaveLength(2);
    await expect(readFile(leftover)).rejects.toMatchObject({code: "ENOENT"});
  } finally { resume(); }
  await preserving;
  const names = (await readdir(directory)).filter(name => name.endsWith(".json"));
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
