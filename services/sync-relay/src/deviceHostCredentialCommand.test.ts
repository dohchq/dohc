import { execFile } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { initializeRelayDeployment, openRelayDeployment } from "./relayDeployment.js";
import { parseDeviceHostCredential } from "./deviceHostCredential.js";

// On Windows each command starts Windows PowerShell for ACL checks. Tests took
// 16-25 s on a busy host; beside 32 CPU burners one command overran a 30 s run
// bound.
// Each run gets up to 60 s, cut to what is left of its test's
// 120 s, so a stalled run fails as itself.
const TEST_TIMEOUT_MS = 120_000;
const RUN_TIMEOUT_MS = 60_000;
vi.setConfig({ testTimeout: TEST_TIMEOUT_MS });
let testDeadline = 0;
beforeEach(() => {
  testDeadline = Date.now() + TEST_TIMEOUT_MS - 5_000;
});
const runTimeout = () => Math.max(1, Math.min(RUN_TIMEOUT_MS, testDeadline - Date.now()));

const exec = promisify(execFile);
let root: string, command: string;
beforeAll(async () => {
  const scratch = fileURLToPath(new URL("../.output", import.meta.url));
  await mkdir(scratch, { recursive: true });
  root = await mkdtemp(join(scratch, "device-operator-"));
  command = join(root, "device-host-credential.mjs");
  await build({
    entryPoints: [fileURLToPath(new URL("./deviceHostCredentialCommand.ts", import.meta.url))],
    outfile: command,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    external: ["better-auth", "better-auth/*", "pg"],
    logLevel: "silent",
  });
}, 30_000);
afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

function deployment(name: string): string {
  const directory = join(root, name);
  const configPath = join(directory, "deployment.json");
  initializeRelayDeployment({
    configPath,
    relayPath: join(directory, "relay", "relay.sqlite"),
    continuityDirectory: join(directory, "continuity"),
  });
  return configPath;
}

async function run(args: string[], umask?: number, platform?: "darwin", preload?: string) {
  try {
    const invocation =
      umask === undefined && platform === undefined
        ? [command, ...args]
        : [
            "--input-type=module",
            "--eval",
            `if (${umask !== undefined}) process.umask(${umask}); if (${platform !== undefined}) Object.defineProperty(process, "platform", { value: ${JSON.stringify(platform)} }); process.argv = [process.execPath, ${JSON.stringify(command)}, ...${JSON.stringify(args)}]; await import(${JSON.stringify(pathToFileURL(command).href)});`,
          ];
    if (preload) invocation.unshift("--import", pathToFileURL(preload).href);
    const result = await exec(process.execPath, invocation, {
      windowsHide: true,
      timeout: runTimeout(),
      env: { ...process.env, NODE_OPTIONS: "" },
    });
    return { code: 0, ...result };
  } catch (error) {
    const result = error as Error & { code: number; stdout: string; stderr: string };
    return { code: result.code, stdout: result.stdout, stderr: result.stderr };
  }
}

it.skipIf(process.platform === "darwin")(
  "runs the actual provision/replay/revoke commands without printing the credential or changing its instance",
  async () => {
    const config = deployment("relay"),
      directory = join(root, "credential");
    const args = [
      "provision",
      "--deployment-config",
      config,
      "--host-id",
      "configured-device",
      "--output-directory",
      directory,
    ];
    const provision = await run(args);
    expect(provision, provision.stderr).toMatchObject({ code: 0 });
    const file = join(directory, "device-host-credential.json"),
      bytes = await readFile(file);
    const credential = parseDeviceHostCredential(JSON.parse(bytes.toString()));
    expect(credential.secret).toHaveLength(43);
    expect(provision.stdout).toBe(
      `Device host credential provisioned.\nDeployment config: ${JSON.stringify(config)}\nInstance ID: ${JSON.stringify(credential.instanceId)}\nCredential file: ${JSON.stringify(file)}\n`,
    );
    expect(provision.stdout + provision.stderr).not.toContain(credential.secret);
    if (process.platform !== "win32") {
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
      expect((await stat(file)).mode & 0o777).toBe(0o600);
    }
    const replay = await run(args);
    expect(replay, replay.stderr).toMatchObject({ code: 0 });
    expect(await readFile(file)).toEqual(bytes);
    expect(replay.stdout).toBe(provision.stdout);
    const storage = openRelayDeployment(config).storage;
    try {
      expect(
        storage.registerDeviceHost({
          credential,
          connectionId: "real-registration",
          updatedAtMs: Date.now(),
        }).ok,
      ).toBe(true);
    } finally {
      storage.close();
    }
    const revoke = [
      "revoke",
      "--deployment-config",
      config,
      "--host-id",
      credential.hostId,
      "--instance-id",
      credential.instanceId,
    ];
    expect((await run(revoke)).code).toBe(1);
    const revoked = await run([...revoke, "--confirm-revoke"], undefined, "darwin");
    expect(revoked).toMatchObject({
      code: 0,
      stdout: `Device host credential revoked.\nDeployment config: ${JSON.stringify(config)}\nHost admission: closed\n`,
    });
    expect((await run([...revoke, "--confirm-revoke"])).code).toBe(0);
    const revokedReplay = await run(args);
    expect(revokedReplay.code).toBe(1);
    expect(revokedReplay.stdout + revokedReplay.stderr).not.toContain(credential.secret);
    const reopened = openRelayDeployment(config).storage;
    try {
      expect(reopened.getLiveHostControl()).toMatchObject({
        admissionState: "closed",
        registeredInstanceId: credential.instanceId,
      });
      expect(
        reopened.registerDeviceHost({
          credential,
          connectionId: "after-revoke",
          updatedAtMs: Date.now(),
        }).ok,
      ).toBe(false);
    } finally {
      reopened.close();
    }
  },
);

it.skipIf(process.platform === "darwin")(
  "refuses to read an existing credential file after its permissions widen",
  async () => {
    const config = deployment("permissions"),
      directory = join(root, "permissions-credential");
    const args = [
      "provision",
      "--deployment-config",
      config,
      "--host-id",
      "permission-device",
      "--output-directory",
      directory,
    ];
    const provision = await run(args);
    expect(provision, provision.stderr).toMatchObject({ code: 0 });
    const file = join(directory, "device-host-credential.json"),
      before = await readFile(file);
    if (process.platform === "win32") {
      await exec(
        join(process.env.SystemRoot ?? "C:/Windows", "System32/icacls.exe"),
        [file, "/grant", "*S-1-1-0:R"],
        { windowsHide: true },
      );
    } else {
      await chmod(file, 0o644);
    }
    const result = await run(args);
    expect(result.code).toBe(1);
    expect(result.stdout + result.stderr).not.toContain(
      parseDeviceHostCredential(JSON.parse(before.toString())).secret,
    );
    expect(await readFile(file)).toEqual(before);
  },
);

it.skipIf(process.platform === "darwin")(
  "requires publication and retry sync barriers before activating SQLite credentials",
  async () => {
    const directory = join(root, "barrier-credential"),
      config = deployment("barrier");
    const args = [
      "provision",
      "--deployment-config",
      config,
      "--host-id",
      "barrier-device",
      "--output-directory",
      directory,
    ];
    const preload = join(root, "fail-credential-sync.mjs");
    const failSync = async (flags: "wx" | "r+", after: number) => {
      await writeFile(
        preload,
        `import fs from "node:fs/promises"; import { syncBuiltinESMExports } from "node:module";
const open = fs.open; fs.open = async (...args) => {
  const handle = await open(...args);
  if (args[1] === ${JSON.stringify(flags)}) { let calls = 0; const sync = handle.sync.bind(handle);
    handle.sync = async () => { if (++calls === ${after}) throw new Error("injected credential sync failure"); await sync(); };
  } return handle;
}; syncBuiltinESMExports();`,
      );
      const result = await run(args, undefined, undefined, preload);
      expect(result).toMatchObject({ code: 1, stdout: "" });
      const raw = new DatabaseSync(JSON.parse(await readFile(config, "utf8")).relayPath, {
        readOnly: true,
      });
      try {
        expect(
          raw.prepare("SELECT count(*) AS n FROM sync_relay_device_host_credential").get(),
        ).toMatchObject({ n: 0 });
      } finally {
        raw.close();
      }
    };
    await failSync("wx", 2);
    const path = join(directory, "device-host-credential.json"),
      bytes = await readFile(path),
      before = await stat(path, { bigint: true });
    await failSync("r+", 1);
    expect(await readFile(path)).toEqual(bytes);
    const recovered = await run(args);
    expect(recovered, recovered.stderr).toMatchObject({ code: 0 });
    expect(await readFile(path)).toEqual(bytes);
    const after = await stat(path, { bigint: true });
    expect({ dev: after.dev, ino: after.ino, mtimeNs: after.mtimeNs }).toEqual({
      dev: before.dev,
      ino: before.ino,
      mtimeNs: before.mtimeNs,
    });
    const storage = openRelayDeployment(config).storage;
    try {
      expect(
        storage.registerDeviceHost({
          credential: parseDeviceHostCredential(JSON.parse(bytes.toString())),
          connectionId: "after-barrier",
          updatedAtMs: Date.now(),
        }).ok,
      ).toBe(true);
    } finally {
      storage.close();
    }
  },
);
