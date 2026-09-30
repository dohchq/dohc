import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const run = promisify(execFile);
const packageRoot = fileURLToPath(new URL("../", import.meta.url));

it("builds when invoked through a linked checkout and stays idle when imported", async () => {
  const root = await mkdtemp(join(tmpdir(), "dohc-relay-build-"));
  try {
    const checkout = join(root, "checkout");
    const linked = join(root, "linked");
    await Promise.all(["scripts", "src", "dist", "node_modules"].map(path => mkdir(join(checkout, path), { recursive: true })));
    await copyFile(join(packageRoot, "scripts/build.mjs"), join(checkout, "scripts/build.mjs"));
    await symlink(await realpath(join(packageRoot, "node_modules/esbuild")), join(checkout, "node_modules/esbuild"), process.platform === "win32" ? "junction" : "dir");
    await symlink(checkout, linked, process.platform === "win32" ? "junction" : "dir");
    const entries = ["main", "liveValidationWorker", "deviceHostConnectCommand", "relayDeploymentCommand", "deviceHostCredentialCommand"];
    await Promise.all(entries.map(name => writeFile(join(checkout, "src", `${name}.ts`), `export const entry: string = ${JSON.stringify(name)};\n`)));
    await writeFile(join(checkout, "dist/stale.txt"), "previous build");

    await run(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(pathToFileURL(join(linked, "scripts/build.mjs")).href)})`]);
    expect(await readdir(join(checkout, "dist"))).toEqual(["stale.txt"]);

    await run(process.execPath, [join(linked, "scripts/build.mjs")]);
    const output = await readdir(join(checkout, "dist"));
    expect(output).not.toContain("stale.txt");
    for (const name of ["main", "liveValidationWorker", "device-host-connect", "relay-deployment", "device-host-credential"]) {
      expect(output).toContain(`${name}.js`);
      expect(output).toContain(`${name}.js.map`);
    }
    expect(await readFile(join(checkout, "dist/liveValidationWorker.js"), "utf8")).toContain("liveValidationWorker");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
