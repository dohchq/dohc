import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";
import { afterAll, beforeAll, expect, it } from "vitest";
import { openRelayDeployment } from "./relayDeployment.js";

const exec = promisify(execFile);
let root: string, command: string;

beforeAll(async () => {
  const scratch = fileURLToPath(new URL("../.output", import.meta.url));
  await mkdir(scratch, { recursive: true });
  root = await mkdtemp(join(scratch, "relay-deployment-command-"));
  command = join(root, "relay-deployment.mjs");
  await build({
    entryPoints: [fileURLToPath(new URL("./relayDeploymentCommand.ts", import.meta.url))],
    outfile: command, bundle: true, platform: "node", format: "esm", target: "node24",
    external: ["better-auth", "better-auth/*", "pg"], logLevel: "silent",
  });
});

afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });

async function run(args: string[]) {
  try {
    const result = await exec(process.execPath, [command, ...args], {
      windowsHide: true, timeout: 30_000, env: { ...process.env, NODE_OPTIONS: "" },
    });
    return { code: 0, ...result };
  } catch (error) {
    const result = error as Error & { code: number; stdout: string; stderr: string };
    return { code: result.code, stdout: result.stdout, stderr: result.stderr };
  }
}

function paths(name: string) {
  const directory = join(root, name);
  const config = join(directory, "deployment.json");
  const database = join(directory, "relay", "relay.sqlite");
  const continuity = join(directory, "continuity");
  return { directory, config, database, continuity,
    args: ["initialize", "--config", config, "--database", database, "--continuity-directory", continuity] };
}

it("initializes a fresh deployment once and preserves it on a repeated command", async () => {
  const target = paths("fresh");
  const result = await run(target.args);
  expect(result, result.stderr).toMatchObject({ code: 0,
    stdout: `Relay deployment initialized.\nDeployment config: ${JSON.stringify(target.config)}\n` });
  const before = await readFile(target.config);
  const { storage } = openRelayDeployment(target.config);
  try {
    expect(storage.claimWorkspace({ workspaceId: "workspace", ownerUserId: "owner", createdAtMs: 1 })).toBe("created");
  } finally {
    storage.close();
  }
  expect(await run(target.args)).toMatchObject({ code: 1, stdout: "" });
  expect(await readFile(target.config)).toEqual(before);
  const reopened = openRelayDeployment(target.config).storage;
  try { expect(reopened.workspaceIsOwnedBy("workspace", "owner")).toBe(true); }
  finally { reopened.close(); }
});

it("refuses to adopt an existing database", async () => {
  const target = paths("existing");
  await mkdir(join(target.directory, "relay"), { recursive: true });
  await writeFile(target.database, "existing operator data");
  expect(await run(target.args)).toMatchObject({ code: 1, stdout: "" });
  expect(await readFile(target.database, "utf8")).toBe("existing operator data");
  await expect(stat(target.config)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(stat(target.continuity)).rejects.toMatchObject({ code: "ENOENT" });
});

it.each(["restore", "reset"])("refuses the unsupported %s action before creating files", async action => {
  const target = paths(action);
  expect(await run([action, ...target.args.slice(1)])).toMatchObject({ code: 1, stdout: "" });
  await expect(stat(target.directory)).rejects.toMatchObject({ code: "ENOENT" });
});

it("refuses duplicate arguments, relative paths, and bypass flags", async () => {
  const target = paths("invalid");
  for (const args of [
    [...target.args, "--config", target.config],
    [...target.args.slice(0, 2), "relative.json", ...target.args.slice(3)],
    [...target.args, "--bypass"],
  ]) {
    expect(await run(args)).toMatchObject({ code: 1, stdout: "" });
  }
  await expect(stat(target.directory)).rejects.toMatchObject({ code: "ENOENT" });
});
