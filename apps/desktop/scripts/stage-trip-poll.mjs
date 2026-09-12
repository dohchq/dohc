import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Copies inspectable example source and installed React dependencies into a workspace. */
export async function stageTripPoll(workspaceRoot) {
  if (!isAbsolute(workspaceRoot)) throw new Error("The example workspace path must be absolute.");
  const appRoot = join(workspaceRoot, "trip-poll");
  if (await readdir(appRoot).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; })) throw new Error("The trip-poll folder already exists.");
  const require = createRequire(import.meta.url);
  const react = dirname(require.resolve("react/package.json"));
  const dom = dirname(require.resolve("react-dom/package.json"));
  const scheduler = dirname(createRequire(join(dom, "package.json")).resolve("scheduler/package.json"));
  const sources = ["main.tsx", "Poll.tsx", "broker.ts", "style.css"];
  const dependencies = [
    [react, "react", "index.js"], [react, "react", "cjs/react.production.js"],
    [react, "react", "jsx-runtime.js"], [react, "react", "cjs/react-jsx-runtime.production.js"],
    [dom, "react-dom", "index.js"], [dom, "react-dom", "cjs/react-dom.production.js"],
    [dom, "react-dom", "client.js"], [dom, "react-dom", "cjs/react-dom-client.production.js"],
    [scheduler, "scheduler", "index.js"], [scheduler, "scheduler", "cjs/scheduler.production.js"],
  ];
  // Resolve every source before creating the destination.
  const template = fileURLToPath(new URL("../../../examples/trip-poll/", import.meta.url));
  const files = await Promise.all([
    ...sources.map(async path => [path, await readFile(join(template, path))]),
    ...dependencies.map(async ([root, name, path]) => [`deps/${name}/${path}`, await readFile(join(root, path))]),
    ...[[react, "react"], [dom, "react-dom"], [scheduler, "scheduler"]].map(async ([root, name]) => [`deps/${name}/LICENSE`, await readFile(join(root, "LICENSE"))]),
    readFile(join(template, "collection.yaml")).then(bytes => ["responses/collection.yaml", bytes]),
  ]);
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(appRoot); // Refuse a concurrent creator instead of overwriting work.
  for (const [path, bytes] of files) { await mkdir(dirname(join(appRoot, path)), { recursive: true }); await writeFile(join(appRoot, path), bytes); }
  const inputs = [...sources, ...dependencies.map(([, name, path]) => `deps/${name}/${path}`)];
  const packageMap = { react: "deps/react/index.js", "react/jsx-runtime": "deps/react/jsx-runtime.js",
    "react-dom": "deps/react-dom/index.js", "react-dom/client": "deps/react-dom/client.js", scheduler: "deps/scheduler/index.js" };
  const declaration = { entryPath: "main.tsx", inputs, packageMap, collection: {kind: "collection-create", collectionPath: "responses",
    allowedFields: ["destination", "name"], requiredFields: ["destination"], readFields: ["destination", "name"]} };
  await writeFile(join(appRoot, "app.publish.json"), JSON.stringify(declaration, null, 2) + "\n");
  return { appRoot, declaration };
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (!process.argv[2]) throw new Error("Pass an absolute workspace directory.");
  console.log(JSON.stringify(await stageTripPoll(process.argv[2])));
}
