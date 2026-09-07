import { execFile } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { afterAll, beforeAll, expect, it } from "vitest";
import { openSyncRelayStorage } from "./storage.js";
import { parseDeviceHostCredential } from "./deviceHostCredential.js";

const exec = promisify(execFile);
let root: string, command: string;
beforeAll(async () => {
  const scratch = fileURLToPath(new URL("../.output", import.meta.url));
  await mkdir(scratch, { recursive: true });
  root = await mkdtemp(join(scratch, "device-operator-"));
  command = join(root, "device-host-credential.mjs");
  await build({ entryPoints: [fileURLToPath(new URL("./deviceHostCredentialCommand.ts", import.meta.url))], outfile: command,
    bundle: true, platform: "node", format: "esm", target: "node24", external: ["better-auth", "better-auth/*", "pg"], logLevel: "silent" });
});
afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });

async function run(args: string[], umask?: number, platform?: "darwin", preload?: string) {
  try {
    const invocation = umask === undefined && platform === undefined ? [command, ...args] : ["--input-type=module", "--eval",
      `if (${umask !== undefined}) process.umask(${umask}); if (${platform !== undefined}) Object.defineProperty(process, "platform", { value: ${JSON.stringify(platform)} }); process.argv = [process.execPath, ${JSON.stringify(command)}, ...${JSON.stringify(args)}]; await import(${JSON.stringify(pathToFileURL(command).href)});`];
    if (preload) invocation.unshift("--import", pathToFileURL(preload).href);
    const result = await exec(process.execPath, invocation, { windowsHide: true, timeout: 30_000, env: { ...process.env, NODE_OPTIONS: "" } });
    return { code: 0, ...result };
  } catch (error) {
    const result = error as Error & { code: number; stdout: string; stderr: string };
    return { code: result.code, stdout: result.stdout, stderr: result.stderr };
  }
}

it.each(["missing", "existing"] as const)("refuses unsupported provisioning before touching a %s database", async kind => {
  const directory = join(root, "darwin-credential-" + kind), database = join(root, "darwin-" + kind + ".sqlite");
  if (kind === "existing") await writeFile(database, "operator-owned non-database bytes");
  const result = await run(["provision", "--database", database, "--host-id", "darwin-device", "--output-directory", directory], undefined, "darwin");
  expect(result).toMatchObject({ code: 1, stdout: "" });
  expect(result.stderr).toBe("Device host credential files are unavailable on macOS because ACL validation is not implemented.\n");
  await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
  if (kind === "existing") expect(await readFile(database, "utf8")).toBe("operator-owned non-database bytes");
  else await expect(stat(database)).rejects.toMatchObject({ code: "ENOENT" });
  for (const suffix of ["-wal", "-shm", "-journal"]) await expect(stat(database + suffix)).rejects.toMatchObject({ code: "ENOENT" });
});

it("explains durable credential storage and unrecoverable loss in help", async () => {
  const result = await run(["--help"], undefined, "darwin");
  expect(result).toMatchObject({ code: 0, stderr: "" });
  expect(result.stdout).toContain("Store the credential file on durable storage. The relay does not keep a recoverable copy.");
  expect(result.stdout).toContain("Losing the file prevents recovery at the current host epoch.");
});

it.skipIf(process.platform === "darwin")("runs the actual provision/replay/revoke commands without printing the credential or changing its instance", async () => {
  const database = join(root, "relay.sqlite"), directory = join(root, "credential");
  const args = ["provision", "--database", database, "--host-id", "configured-device", "--output-directory", directory];
  const provision = await run(args);
  expect(provision, provision.stderr).toMatchObject({ code: 0 });
  const file = join(directory, "device-host-credential.json"), bytes = await readFile(file);
  const credential = parseDeviceHostCredential(JSON.parse(bytes.toString()));
  expect(credential.secret).toHaveLength(43);
  expect(provision.stdout).toBe(`Device host credential provisioned.\nDatabase: ${JSON.stringify(database)}\nInstance ID: ${JSON.stringify(credential.instanceId)}\nCredential file: ${JSON.stringify(file)}\n`);
  expect(provision.stdout + provision.stderr).not.toContain(credential.secret);
  if (process.platform !== "win32") {
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  }
  const replay = await run(args); expect(replay, replay.stderr).toMatchObject({ code: 0 });
  expect(await readFile(file)).toEqual(bytes);
  expect(replay.stdout).toBe(provision.stdout);
  const storage = openSyncRelayStorage(database);
  try {
    expect(storage.registerDeviceHost({ credential, connectionId: "real-registration", updatedAtMs: Date.now() }).ok).toBe(true);
  } finally { storage.close(); }
  const revoke = ["revoke", "--database", database, "--host-id", credential.hostId, "--instance-id", credential.instanceId];
  expect((await run(revoke)).code).toBe(1);
  const revoked = await run([...revoke, "--confirm-revoke"], undefined, "darwin");
  expect(revoked).toMatchObject({ code: 0, stdout: `Device host credential revoked.\nDatabase: ${JSON.stringify(database)}\nHost admission: closed\n` });
  expect((await run([...revoke, "--confirm-revoke"])).code).toBe(0);
  const revokedReplay = await run(args);
  expect(revokedReplay.code).toBe(1);
  expect(revokedReplay.stdout + revokedReplay.stderr).not.toContain(credential.secret);
  const reopened = openSyncRelayStorage(database);
  try {
    expect(reopened.getLiveHostControl()).toMatchObject({ admissionState: "closed", registeredInstanceId: credential.instanceId });
    expect(reopened.registerDeviceHost({ credential, connectionId: "after-revoke", updatedAtMs: Date.now() }).ok).toBe(false);
  } finally { reopened.close(); }
}, 60_000);

it.skipIf(process.platform === "darwin")("refuses linked output and duplicate arguments and leaves existing files unchanged", async () => {
  const database = join(root, "other.sqlite"), directory = join(root, "other-credential");
  const args = ["provision", "--database", database, "--host-id", "other-device", "--output-directory", directory];
  expect((await run(args)).code).toBe(0);
  const file = join(directory, "device-host-credential.json"), before = await readFile(file);
  const alias = join(root, "alias");
  await symlink(directory, alias, process.platform === "win32" ? "junction" : "dir");
  expect((await run([...args.slice(0, -1), alias])).code).toBe(1);
  expect((await run([...args, "--database", database])).code).toBe(1);
  expect(await readFile(file)).toEqual(before);
});

it.skipIf(process.platform === "darwin")("refuses to read an existing credential file after its permissions widen", async () => {
  const database = join(root, "permissions.sqlite"), directory = join(root, "permissions-credential");
  const args = ["provision", "--database", database, "--host-id", "permission-device", "--output-directory", directory];
  const provision = await run(args); expect(provision, provision.stderr).toMatchObject({ code: 0 });
  const file = join(directory, "device-host-credential.json"), before = await readFile(file);
  if (process.platform === "win32") {
    await exec(join(process.env.SystemRoot ?? "C:/Windows", "System32/icacls.exe"), [file, "/grant", "*S-1-1-0:R"], { windowsHide: true });
  } else { await chmod(file, 0o644); }
  const result = await run(args);
  expect(result.code).toBe(1);
  expect(result.stdout + result.stderr).not.toContain(parseDeviceHostCredential(JSON.parse(before.toString())).secret);
  expect(await readFile(file)).toEqual(before);
});

it.skipIf(process.platform === "darwin")("retries after preparation left a private directory without a credential file", async () => {
  const directory = join(root, "interrupted-credential"), database = join(root, "interrupted.sqlite");
  const args = ["provision", "--database", database, "--host-id", "interrupted-device", "--output-directory", directory];
  const seed = [...args]; seed[2] = join(root, "private-directory-seed.sqlite");
  expect((await run(seed)).code).toBe(0);
  const file = join(directory, "device-host-credential.json");
  await rm(file);
  const marker = join(directory, "operator-note"); await writeFile(marker, "keep this file");
  const result = await run(args); expect(result, result.stderr).toMatchObject({ code: 0 });
  const bytes = await readFile(file), credential = parseDeviceHostCredential(JSON.parse(bytes.toString()));
  expect((await run(args)).code).toBe(0);
  expect(await readFile(file)).toEqual(bytes);
  expect(await readFile(marker, "utf8")).toBe("keep this file");
  const storage = openSyncRelayStorage(database);
  try { expect(storage.registerDeviceHost({ credential, connectionId: "recovered", updatedAtMs: Date.now() }).ok).toBe(true); }
  finally { storage.close(); }
}, 60_000);

it.skipIf(process.platform === "darwin")("does not overwrite a malformed existing credential or reuse a credential from another host", async () => {
  const directory = join(root, "refused-credential"), database = join(root, "refused.sqlite");
  const args = ["provision", "--database", database, "--host-id", "original-host", "--output-directory", directory];
  expect((await run(args)).code).toBe(0);
  const file = join(directory, "device-host-credential.json"), before = await readFile(file);
  const wrongHost = [...args]; wrongHost[4] = "different-host";
  expect((await run(wrongHost)).code).toBe(1);
  expect(await readFile(file)).toEqual(before);
  await writeFile(file, "interrupted credential bytes");
  expect((await run(args)).code).toBe(1);
  expect(await readFile(file, "utf8")).toBe("interrupted credential bytes");
});

it.skipIf(process.platform === "darwin")("reports the retained admission state when revocation occurs during maintenance", async () => {
  const directory = join(root, "transition-credential"), database = join(root, "transition.sqlite");
  expect((await run(["provision", "--database", database, "--host-id", "transition-device", "--output-directory", directory])).code).toBe(0);
  const credential = parseDeviceHostCredential(JSON.parse(await readFile(join(directory, "device-host-credential.json"), "utf8")));
  const storage = openSyncRelayStorage(database);
  try {
    expect(storage.registerDeviceHost({ credential, connectionId: "transition-device", updatedAtMs: Date.now() }).ok).toBe(true);
    expect(storage.beginLiveHostTransition({ from: { mode: "device", hostId: credential.hostId, hostEpoch: credential.hostEpoch,
      instanceId: credential.instanceId, connectionId: "transition-device" }, toMode: "service", toHostId: "service",
      transitionId: "operator-transition", startedAtMs: Date.now(), guard: () => {} }).ok).toBe(true);
  } finally { storage.close(); }
  const result = await run(["revoke", "--database", database, "--host-id", credential.hostId,
    "--instance-id", credential.instanceId, "--confirm-revoke"]);
  expect(result).toMatchObject({ code: 0, stdout: `Device host credential revoked.\nDatabase: ${JSON.stringify(database)}\nHost admission: draining\n` });
});

it.skipIf(process.platform === "win32" || process.platform === "darwin")("creates private entries despite a restrictive POSIX umask", async () => {
  const directory = join(root, "umask-credential"), database = join(root, "umask.sqlite");
  const storage = openSyncRelayStorage(database); storage.close();
  const args = ["provision", "--database", database, "--host-id", "umask-device", "--output-directory", directory];
  const result = await run(args, 0o377); expect(result, result.stderr).toMatchObject({ code: 0 });
  expect((await stat(directory)).mode & 0o777).toBe(0o700);
  const file = join(directory, "device-host-credential.json"), before = await readFile(file);
  expect((await stat(file)).mode & 0o777).toBe(0o600);
  expect((await run(args)).code).toBe(0);
  expect(await readFile(file)).toEqual(before);
});

it.skipIf(process.platform === "win32" || process.platform === "darwin")("rejects a POSIX parent redirect that differs only by case", async ({ skip }) => {
  const parent = join(root, "CaseParent"), alias = join(root, "caseparent");
  await mkdir(parent);
  try { await stat(alias); skip(); return; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const directory = join(parent, "credential"), database = join(root, "case-sensitive.sqlite");
  const args = ["provision", "--database", database, "--host-id", "case-device", "--output-directory", directory];
  expect((await run(args)).code).toBe(0);
  const file = join(directory, "device-host-credential.json"), before = await readFile(file);
  await symlink(parent, alias, "dir");
  const redirected = [...args]; redirected[6] = join(alias, "credential");
  expect((await run(redirected)).code).toBe(1);
  expect(await readFile(file)).toEqual(before);
});

it.skipIf(process.platform === "darwin")("requires publication and retry sync barriers before activating SQLite credentials", async () => {
  const directory = join(root, "barrier-credential"), database = join(root, "barrier.sqlite");
  const args = ["provision", "--database", database, "--host-id", "barrier-device", "--output-directory", directory];
  const preload = join(root, "fail-credential-sync.mjs");
  const failSync = async (flags: "wx" | "r+", after: number) => {
    await writeFile(preload, `import fs from "node:fs/promises"; import { syncBuiltinESMExports } from "node:module";
const open = fs.open; fs.open = async (...args) => {
  const handle = await open(...args);
  if (args[1] === ${JSON.stringify(flags)}) { let calls = 0; const sync = handle.sync.bind(handle);
    handle.sync = async () => { if (++calls === ${after}) throw new Error("injected credential sync failure"); await sync(); };
  } return handle;
}; syncBuiltinESMExports();`);
    const result = await run(args, undefined, undefined, preload);
    expect(result).toMatchObject({ code: 1, stdout: "" });
    const raw = new DatabaseSync(database);
    try { expect(raw.prepare("SELECT count(*) AS n FROM sync_relay_device_host_credential").get()).toMatchObject({ n: 0 }); }
    finally { raw.close(); }
  };
  await failSync("wx", 2);
  const path = join(directory, "device-host-credential.json"), bytes = await readFile(path), before = await stat(path, { bigint: true });
  await failSync("r+", 1);
  expect(await readFile(path)).toEqual(bytes);
  const recovered = await run(args); expect(recovered, recovered.stderr).toMatchObject({ code: 0 });
  expect(await readFile(path)).toEqual(bytes);
  const after = await stat(path, { bigint: true });
  expect({ dev: after.dev, ino: after.ino, mtimeNs: after.mtimeNs }).toEqual({ dev: before.dev, ino: before.ino, mtimeNs: before.mtimeNs });
  const storage = openSyncRelayStorage(database);
  try { expect(storage.registerDeviceHost({ credential: parseDeviceHostCredential(JSON.parse(bytes.toString())), connectionId: "after-barrier", updatedAtMs: Date.now() }).ok).toBe(true); }
  finally { storage.close(); }
}, 60_000);
