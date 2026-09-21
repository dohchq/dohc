import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { OwnerAppFormRequest, type OwnerAppFormResult } from "@dohc/cli/protocol";
import { validateUserMaterializePath, validateUserReadPath, isSharedWithMePath } from "@dohc/workspace-core";
import type { CollectionGetResult } from "@dohc/workspace-contracts/collection";
import { generateAppForm } from "./appFormGenerator";
import { assertResolvedWorkspacePath } from "./workspaceRealPath";

async function rejectSymlinks(root: string, path: string): Promise<void> {
  let current = root;
  for (const segment of relative(root, path).split(/[\\/]/).filter(Boolean)) {
    current = join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error("Choose a folder without symbolic links.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

export async function createAppForm(input: {
  workspaceRoot: string;
  request: OwnerAppFormRequest;
  signal: AbortSignal;
  assertCurrent(): void;
  getCollection(collectionPath: string): Promise<CollectionGetResult>;
  captureFiles(files: Record<string, string>): Promise<void>;
}): Promise<OwnerAppFormResult> {
  const request = OwnerAppFormRequest.parse(input.request);
  const check = () => { input.signal.throwIfAborted(); input.assertCurrent(); };
  check();
  const source = validateUserReadPath(request.collectionPath);
  const destination = validateUserMaterializePath(request.appRoot);
  if (!source.ok || source.normalized !== request.collectionPath || isSharedWithMePath(request.collectionPath)) {
    throw new Error("Choose a collection in the owning workspace.");
  }
  if (!destination.ok || destination.normalized !== request.appRoot || isSharedWithMePath(request.appRoot)) {
    throw new Error("Choose a new app folder in the owning workspace.");
  }
  const root = await realpath(input.workspaceRoot);
  const target = resolve(root, request.appRoot);
  await rejectSymlinks(root, target);
  await assertResolvedWorkspacePath({ rootPath: root, absolutePath: target, spelled: request.appRoot, label: "App folder", access: "write" });
  const schemaSource = `${request.collectionPath}/collection.yaml`;
  await rejectSymlinks(root, resolve(root, schemaSource));
  await assertResolvedWorkspacePath({ rootPath: root, absolutePath: resolve(root, schemaSource), spelled: schemaSource, label: "Collection schema", access: "read" });
  check();
  const collection = await input.getCollection(request.collectionPath);
  check();
  if (collection.status !== "valid" || collection.path !== request.collectionPath) {
    throw new Error("Fix the collection schema before creating a form.");
  }
  const { files } = generateAppForm({ schema: structuredClone(collection.schema), schemaSource, appRoot: request.appRoot, publicFields: [...request.publicFields] });
  const entries = Object.entries(files);
  if (!entries.length || entries.length > 64 || entries.some(([name, text]) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || typeof text !== "string") ||
      entries.reduce((bytes, [, text]) => bytes + Buffer.byteLength(text), 0) > 2 * 1024 * 1024) {
    throw new Error("The generated app files are invalid.");
  }
  check();
  await mkdir(dirname(target), { recursive: true });
  await rejectSymlinks(root, target);
  await assertResolvedWorkspacePath({ rootPath: root, absolutePath: target, spelled: request.appRoot, label: "App folder", access: "write" });
  check();
  try {
    await mkdir(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("The app folder already exists. Choose a new folder.");
    throw error;
  }
  try {
    // Publish the declaration last so an interrupted generation cannot look ready to approve.
    entries.sort(([a], [b]) => Number(a === "app.publish.json") - Number(b === "app.publish.json"));
    for (const [name, text] of entries) {
      check();
      await rejectSymlinks(root, target);
      await writeFile(join(target, name), text, { flag: "wx", signal: input.signal });
    }
    check();
  } catch (error) {
    throw new Error(`The form files are incomplete in ${request.appRoot}. Inspect that folder before trying again.`, { cause: error });
  }
  check();
  try {
    await input.captureFiles(Object.fromEntries(entries.map(([name, text]) => [`${request.appRoot}/${name}`, text])));
  } catch (error) {
    throw new Error(`The form files were saved in ${request.appRoot}, but dohc could not capture them. Keep the files and retry preparation.`, { cause: error });
  }
  check();
  return { appRoot: request.appRoot, schemaSource, files: entries.map(([name]) => `${request.appRoot}/${name}`), recordsCopied: 0 };
}
