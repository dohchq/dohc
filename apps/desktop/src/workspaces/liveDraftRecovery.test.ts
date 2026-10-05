import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { foldScene, insertElementRevision, setAppStateProperty } from "@dohc/excalidraw-scene";
import { markdownToYDoc, yDocToMarkdown } from "@dohc/ydoc-projection";
import { preserveLiveDraft, preserveUnsentLiveDraft, removeWorkspaceLiveDrafts } from "./liveDraftRecovery";

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {...actual, writeFile: vi.fn(actual.writeFile)};
});
const directories: string[] = [];
afterEach(async () => {
  vi.mocked(writeFile).mockClear();
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
