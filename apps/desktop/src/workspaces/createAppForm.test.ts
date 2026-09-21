import { mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CollectionGetResult } from "@dohc/workspace-contracts/collection";
import { createTestScratch } from "./testTemp";
import { createAppForm } from "./createAppForm";

const request = { workspaceId: "workspace", collectionPath: "Participants", appRoot: "apps/registration", publicFields: ["name"] };
const collection: CollectionGetResult = { path: "Participants", status: "valid", reasons: [], recordCount: 12,
  schema: { name: "Registration", description: null, fields: [{ name: "name", type: "text" }], views: [] } };
async function fixture() {
  const root = await createTestScratch("app-form-create-");
  await mkdir(join(root, "Participants"));
  await writeFile(join(root, "Participants", "collection.yaml"), "name: Registration\nfields:\n  name:\n    type: text\n");
  const controller = new AbortController();
  const getCollection = vi.fn(async () => structuredClone(collection));
  return { root, controller, getCollection, input: { workspaceRoot: root, request, signal: controller.signal, assertCurrent() {}, getCollection, captureFiles: vi.fn(async () => {}) } };
}
describe("create app form", () => {
  it("writes source from the parsed schema without copying records or altering the collection", async () => {
    const f = await fixture();
    const result = await createAppForm(f.input);
    expect(result).toMatchObject({ appRoot: request.appRoot, schemaSource: "Participants/collection.yaml", recordsCopied: 0 });
    expect(result.files).toContain("apps/registration/app.publish.json");
    expect(f.getCollection).toHaveBeenCalledExactlyOnceWith("Participants");
    for (const path of result.files) expect(await readFile(join(f.root, path), "utf8")).not.toBe("");
    expect(await readdir(join(f.root, "Participants"))).toEqual(["collection.yaml"]);
  });
  it("refuses an occupied destination without overwriting it", async () => {
    const f = await fixture();
    await mkdir(join(f.root, request.appRoot), { recursive: true });
    await writeFile(join(f.root, request.appRoot, "keep.txt"), "keep");
    await expect(createAppForm(f.input)).rejects.toThrow("already exists");
    expect(await readdir(join(f.root, request.appRoot))).toEqual(["keep.txt"]);
  });
  it("validates generated paths and selected fields before creating any folders", async () => {
    const f = await fixture();
    await expect(createAppForm({ ...f.input, request: { ...request, appRoot: "apps/registration form" } })).rejects.toThrow();
    await expect(createAppForm({ ...f.input, request: { ...request, publicFields: ["unknown"] } })).rejects.toThrow();
    expect(await readdir(f.root)).toEqual(["Participants"]);
  });
  it.each(["../escape", ".dohc/form", "shared-with-me/form", "/absolute"])("refuses destination %s", async appRoot => {
    const f = await fixture();
    await expect(createAppForm({ ...f.input, request: { ...request, appRoot } })).rejects.toThrow();
    expect(f.getCollection).not.toHaveBeenCalled();
  });
  it("refuses symbolic-link ancestors even within the workspace", async () => {
    const f = await fixture();
    await mkdir(join(f.root, "elsewhere"));
    await symlink(join(f.root, "elsewhere"), join(f.root, "apps"), "junction");
    await expect(createAppForm(f.input)).rejects.toThrow("symbolic links");
    expect(await readdir(join(f.root, "elsewhere"))).toEqual([]);
  });
  it("refuses a collection reached through a symbolic link", async () => {
    const f = await fixture();
    await symlink(join(f.root, "Participants"), join(f.root, "Linked"), "junction");
    await expect(createAppForm({ ...f.input, request: { ...request, collectionPath: "Linked" } })).rejects.toThrow("symbolic links");
    expect(f.getCollection).not.toHaveBeenCalled();
  });
  it("lets only one concurrent creation claim a destination", async () => {
    const f = await fixture();
    const results = await Promise.allSettled([createAppForm(f.input), createAppForm(f.input)]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const refused = results.find(result => result.status === "rejected") as PromiseRejectedResult;
    expect(refused.reason.message).toContain("already exists");
  });
  it("does not claim success when source capture fails and preserves the saved files", async () => {
    const f = await fixture();
    f.input.captureFiles.mockRejectedValueOnce(new Error("capture unavailable"));
    await expect(createAppForm(f.input)).rejects.toThrow("files were saved");
    expect(await readFile(join(f.root, request.appRoot, "app.publish.json"), "utf8")).toContain("frontend.js");
    expect(f.input.captureFiles).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      "apps/registration/app.publish.json": expect.any(String), "apps/registration/schema.sql": expect.any(String),
    }));
  });
  it("refuses degraded schemas and retired workspaces before creating source", async () => {
    const f = await fixture();
    f.getCollection.mockResolvedValueOnce({ ...collection, status: "degraded" });
    await expect(createAppForm(f.input)).rejects.toThrow("Fix the collection schema");
    f.getCollection.mockImplementationOnce(async () => { f.controller.abort(); return collection; });
    await expect(createAppForm(f.input)).rejects.toThrow();
    expect(await readdir(f.root)).toEqual(["Participants"]);
  });
});
