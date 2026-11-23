import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Copies inspectable example source into a workspace using dohc's built-in React runtime. */
export async function stageTripPoll(workspaceRoot) {
  if (!isAbsolute(workspaceRoot)) throw new Error("The example workspace path must be absolute.");
  const appRoot = join(workspaceRoot, "trip-poll");
  if (
    await readdir(appRoot).then(
      () => true,
      (error) => {
        if (error.code === "ENOENT") return false;
        throw error;
      },
    )
  )
    throw new Error("The trip-poll folder already exists.");
  const sources = ["main.tsx", "Poll.tsx", "broker.ts", "style.css", "style.d.ts"];
  const template = fileURLToPath(new URL("../../../examples/trip-poll/", import.meta.url));
  const files = await Promise.all([
    ...sources.map(async (path) => [path, await readFile(join(template, path))]),
    readFile(join(template, "responses/collection.yaml")).then((bytes) => [
      "responses/collection.yaml",
      bytes,
    ]),
  ]);
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(appRoot);
  for (const [path, bytes] of files) {
    await mkdir(dirname(join(appRoot, path)), { recursive: true });
    await writeFile(join(appRoot, path), bytes);
  }
  const declaration = {
    version: 1,
    entryPath: "main.tsx",
    inputs: sources,
    packageMap: {},
    collection: {
      kind: "collection-create",
      collectionPath: "responses",
      allowedFields: ["destination", "name"],
      requiredFields: ["destination"],
      readFields: ["destination", "name"],
    },
  };
  await writeFile(join(appRoot, "app.publish.json"), JSON.stringify(declaration, null, 2) + "\n");
  return { appRoot, declaration };
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (!process.argv[2]) throw new Error("Pass an absolute workspace directory.");
  console.log(JSON.stringify(await stageTripPoll(process.argv[2])));
}
