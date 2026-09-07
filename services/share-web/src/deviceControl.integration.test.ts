import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect } from "node:net";
import type { Duplex } from "node:stream";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { WebSocket } from "ws";
import { build } from "esbuild";
import { afterAll, beforeAll, expect, it } from "vitest";
import { openSyncRelayStorage } from "@dohc/sync-relay/storage";
import { DEVICE_CONTROL_PROTOCOL, type DeviceControlLimits } from "@dohc/live-session-contract/device-control";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../../..", import.meta.url));
const certificate = fileURLToPath(new URL("./testing/device-control/localhost-cert.pem", import.meta.url));
const privateKey = fileURLToPath(new URL("./testing/device-control/localhost-key.pem", import.meta.url));
let relayMain: string, shareMain: string, credentialCommand: string, connectorCommand: string;
const limits: DeviceControlLimits = { maxConnections: 8, maxHeaderBytes: 8192, maxCredentialBytes: 4096,
  maxPayloadBytes: 4096, maxPendingBytes: 8192, maxFragments: 8, maxBufferedChunks: 8,
  handshakeTimeoutMs: 5000, heartbeatIntervalMs: 100, heartbeatTimeoutMs: 2000, closeTimeoutMs: 100 };
const exchangeKey = "actual-outbound-device-control-test-key";
const cleanups: (() => Promise<unknown>)[] = [];
let scratch: string;

async function distFingerprint() {
  const files: { path: string; sha256: string; mtimeMs: number }[] = [];
  async function visit(path: string): Promise<void> {
    const entries = await readdir(path, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const entry of entries) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) await visit(full);
      else files.push({ path: full, sha256: createHash("sha256").update(await readFile(full)).digest("hex"),
        mtimeMs: (await stat(full)).mtimeMs });
    }
  }
  await visit(join(root, "services/share-web/dist"));
  await visit(join(root, "services/sync-relay/dist"));
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

beforeAll(async () => {
  const distBefore = await distFingerprint();
  const output = join(root, "services/share-web/.output");
  await mkdir(output, { recursive: true });
  scratch = await mkdtemp(join(output, "outbound-control-"));
  relayMain = join(scratch, "relay-main.mjs");
  shareMain = join(scratch, "share-main.mjs");
  credentialCommand = join(scratch, "device-host-credential.mjs");
  connectorCommand = join(scratch, "device-host-connect.mjs");
  await build({ entryPoints: { "relay-main": join(root, "services/sync-relay/src/main.ts"),
    "device-host-credential": join(root, "services/sync-relay/src/deviceHostCredentialCommand.ts"),
    "device-host-connect": join(root, "services/sync-relay/src/deviceHostConnectCommand.ts") },
    outdir: scratch, outExtension: { ".js": ".mjs" }, bundle: true, platform: "node", format: "esm", target: "node22",
    external: ["better-auth", "better-auth/*", "pg", "ws"], logLevel: "silent" });
  await build({ entryPoints: [join(root, "services/share-web/src/main.ts")], outfile: shareMain,
    bundle: true, platform: "node", format: "esm", target: "node24", external: ["ws"], logLevel: "silent" });
  expect(await distFingerprint(), "integration preparation must leave shared dist untouched").toEqual(distBefore);
}, 60_000);
afterAll(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  if (scratch) await rm(scratch, { recursive: true, force: true });
}, 30_000);

function child(args: string[], env: NodeJS.ProcessEnv = {}) {
  const processChild = spawn(process.execPath, args, { cwd: root, windowsHide: true,
    env: { ...process.env, NODE_OPTIONS: "", NODE_ENV: "test", ...env }, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  processChild.stdout.on("data", bytes => { stdout += String(bytes); });
  processChild.stderr.on("data", bytes => { stderr += String(bytes); });
  const exited = new Promise<number | null>((resolve, reject) => {
    processChild.once("exit", code => resolve(code));
    processChild.once("error", reject);
  });
  cleanups.push(async () => { if (processChild.exitCode === null && processChild.signalCode === null) processChild.kill(); await exited; });
  async function output(pattern: RegExp): Promise<RegExpExecArray> {
    const found = pattern.exec(stdout);
    if (found) return found;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error(`Child output deadline: ${stderr}`)), 30_000);
      const onData = () => { const matched = pattern.exec(stdout); if (matched) finish(undefined, matched); };
      const onExit = () => finish(new Error(`Child exited before expected output: ${stderr}`));
      function finish(error?: Error, matched?: RegExpExecArray) {
        clearTimeout(timer);
        processChild.stdout.removeListener("data", onData);
        processChild.removeListener("exit", onExit);
        if (error) reject(error); else resolve(matched!);
      }
      processChild.stdout.on("data", onData);
      processChild.once("exit", onExit);
      if (processChild.exitCode !== null || processChild.signalCode !== null) onExit();
    });
  }
  return { process: processChild, exited, output, logs: () => stdout + stderr };
}

async function freePort(): Promise<number> {
  const server = createHttpServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error();
  await new Promise<void>(resolve => server.close(() => resolve()));
  return address.port;
}

it.skipIf(process.platform === "darwin")("runs the built connector outbound through actual share-web and relay, with no document authority", async () => {
  const database = join(scratch, "relay.sqlite"), directory = join(scratch, "credential"), assets = join(scratch, "viewer");
  await mkdir(assets);
  await writeFile(join(assets, "index.html"), "<!doctype html><title>Control transport fixture</title>");
  const provision = await exec(process.execPath, [credentialCommand, "provision", "--database", database,
    "--host-id", "outbound-device", "--output-directory", directory], { windowsHide: true, env: { ...process.env, NODE_OPTIONS: "" } });
  const credentialFile = join(directory, "device-host-credential.json"), before = await readFile(credentialFile);
  const permissionBefore = (await stat(credentialFile)).mode;
  const icacls = join(process.env.SystemRoot ?? "C:/Windows", "System32/icacls.exe");
  const aclBefore = process.platform === "win32" ? (await exec(icacls, [credentialFile], { windowsHide: true })).stdout : undefined;
  const credential = JSON.parse(before.toString());
  expect(provision.stdout + provision.stderr).not.toContain(credential.secret);
  const relayPort = await freePort();
  const relay = child([relayMain], { SYNC_RELAY_TEST_AUTH: "1", SYNC_RELAY_PORT: String(relayPort),
    SYNC_RELAY_DB_PATH: database, DOHC_RELAY_EXCHANGE_KEY: exchangeKey, DOHC_DEVICE_CONTROL_LIMITS: JSON.stringify(limits),
    DOHC_RELAY_DEVICE_CONTROL_HOSTS: `127.0.0.1:${relayPort}` });
  await relay.output(/SYNC_RELAY_LISTENING host=127\.0\.0\.1 port=(\d+)/);
  const authority = openSyncRelayStorage(database);
  cleanups.push(async () => authority.close());

  let sharePort = 0;
  const proxySockets = new Set<Duplex>();
  const proxy = createHttpsServer({ cert: await readFile(certificate), key: await readFile(privateKey) });
  proxy.on("connection", socket => { proxySockets.add(socket); socket.once("close", () => proxySockets.delete(socket)); });
  proxy.on("upgrade", (request, socket, head) => {
    const destination = connect(sharePort, "127.0.0.1");
    proxySockets.add(destination);
    destination.once("close", () => { proxySockets.delete(destination); socket.destroy(); });
    destination.on("error", () => socket.destroy());
    socket.on("error", () => destination.destroy());
    socket.once("close", () => destination.destroy());
    destination.once("connect", () => {
      const lines = request.rawHeaders.reduce<string[]>((result, value, index, all) => {
        if (index % 2 === 0) result.push(`${value}: ${all[index + 1]}`);
        return result;
      }, []);
      destination.write(`GET ${request.url} HTTP/1.1\r\n${lines.join("\r\n")}\r\n\r\n`);
      if (head.length) destination.write(head);
      socket.pipe(destination).pipe(socket);
    });
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  const publicAddress = proxy.address();
  if (!publicAddress || typeof publicAddress === "string") throw new Error();
  cleanups.push(async () => {
    for (const socket of proxySockets) socket.destroy();
    await new Promise<void>(resolve => proxy.close(() => resolve()));
  });

  const guard = join(scratch, "network-guard.mjs");
  await writeFile(guard, `import net from 'node:net';
if (process.env.DENY_DEVICE_LISTEN === '1') {
  net.Server.prototype.listen = function () { throw new Error('Device listener forbidden'); };
} else {
  const original = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    const input = Array.isArray(args[0]) ? args[0][0] : args[0];
    const port = typeof input === 'object' ? input.port : input;
    if (Number(port) !== Number(process.env.ALLOWED_RELAY_PORT)) throw new Error('Share-web may connect only to the relay');
    process.stdout.write('OUTBOUND_RELAY_ONLY\\n');
    return original.apply(this, args);
  };
}
`);
  const publicHost = `localhost:${publicAddress.port}`;
  const share = child(["--import", pathToFileURL(guard).href, shareMain], { DOHC_SHARE_WEB_DEV: "1", DOHC_SHARE_WEB_PORT: "0",
    DOHC_SHARE_WEB_RELAY_URL: `http://127.0.0.1:${relayPort}`, DOHC_SHARE_WEB_PUBLIC_RELAY_URL: `http://127.0.0.1:${relayPort}`,
    DOHC_SHARE_WEB_PUBLIC_HOSTS: publicHost, DOHC_SHARE_WEB_RELAY_EXCHANGE_KEY: exchangeKey,
    DOHC_SHARE_WEB_TEST_VIEWER_ASSETS_DIR: assets, DOHC_DEVICE_CONTROL_LIMITS: JSON.stringify(limits),
    DOHC_SHARE_WEB_DEVICE_CONTROL_ADMISSION: JSON.stringify({ capacity: 20, refillPerSecond: 1, maxKeys: 8 }),
    ALLOWED_RELAY_PORT: String(relayPort) });
  sharePort = Number((await share.output(/SHARE_WEB_LISTENING host=127\.0\.0\.1 port=(\d+)/))[1]);
  const args = ["--import", pathToFileURL(guard).href, connectorCommand, "--url", `wss://${publicHost}/api/device-control`,
    "--credential-directory", directory, "--limits-json", JSON.stringify(limits)];
  const connectorEnv = { DENY_DEVICE_LISTEN: "1", NODE_EXTRA_CA_CERTS: certificate };
  const first = child(args, connectorEnv);
  const firstNotice = JSON.parse((await first.output(/(\{"type":"registered"[^\n]+\})/))[1]!);
  expect(authority.getLiveHostControl()).toMatchObject({ configuredMode: "device", configuredHostId: credential.hostId,
    hostEpoch: credential.hostEpoch, registeredInstanceId: credential.instanceId, registeredConnectionId: firstNotice.connectionId });

  const spoof = new WebSocket(`wss://${publicHost}/api/device-control`, DEVICE_CONTROL_PROTOCOL, { ca: await readFile(certificate),
    perMessageDeflate: false, headers: { authorization: "Bearer invalid", "x-dohc-relay-exchange-key": exchangeKey } });
  spoof.on("error", () => {});
  await new Promise<void>(resolve => spoof.once("close", () => resolve()));
  expect(authority.getLiveHostControl()?.registeredConnectionId).toBe(firstNotice.connectionId);

  const second = child(args, connectorEnv);
  const secondNotice = JSON.parse((await second.output(/(\{"type":"registered"[^\n]+\})/))[1]!);
  await first.exited;
  expect(secondNotice.connectionId).not.toBe(firstNotice.connectionId);
  expect(secondNotice.instanceId).toBe(firstNotice.instanceId);
  expect(authority.getLiveHostControl()?.registeredConnectionId).toBe(secondNotice.connectionId);

  second.process.kill();
  await second.exited;
  await expect.poll(() => authority.getLiveHostControl()?.admissionState).toBe("closed");
  const third = child(args, connectorEnv);
  const thirdNotice = JSON.parse((await third.output(/(\{"type":"registered"[^\n]+\})/))[1]!);
  expect(authority.getLiveHostControl()?.registeredConnectionId).toBe(thirdNotice.connectionId);

  const untrusted = child(args, { DENY_DEVICE_LISTEN: "1", NODE_EXTRA_CA_CERTS: "" });
  expect(await untrusted.exited).toBe(1);
  expect(untrusted.logs()).not.toContain('"type":"registered"');
  expect(authority.getLiveHostControl()?.registeredConnectionId).toBe(thirdNotice.connectionId);

  // This command opens a separate real SQLite handle; liveness observes its committed revocation.
  await exec(process.execPath, [credentialCommand, "revoke", "--database", database, "--host-id", credential.hostId,
    "--instance-id", credential.instanceId, "--confirm-revoke"], { windowsHide: true, env: { ...process.env, NODE_OPTIONS: "" } });
  await third.exited;
  expect(authority.getLiveHostControl()?.admissionState).toBe("closed");
  const revoked = child(args, connectorEnv);
  expect(await revoked.exited).toBe(1);
  expect(revoked.logs()).not.toContain('"type":"registered"');
  expect(share.logs()).toContain("OUTBOUND_RELAY_ONLY");
  expect(share.logs()).not.toContain("Share-web may connect only");
  for (const processHandle of [relay, share, first, second, third, untrusted, revoked]) {
    expect(processHandle.logs()).not.toContain(credential.secret);
    expect(processHandle.logs()).not.toContain("Device listener forbidden");
  }
  expect(await readFile(credentialFile)).toEqual(before);
  expect((await stat(credentialFile)).mode).toBe(permissionBefore);
  if (aclBefore !== undefined) expect((await exec(icacls, [credentialFile], { windowsHide: true })).stdout).toBe(aclBefore);
  const sql = new DatabaseSync(database, { readOnly: true });
  try {
    const tables = sql.prepare("SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE '%live%' OR name LIKE '%binding%' OR name LIKE '%journal%')").all();
    for (const row of tables) {
      const name = String(row.name);
      expect(name).toMatch(/^[A-Za-z0-9_]+$/);
      expect(sql.prepare(`SELECT count(*) AS total FROM "${name}"`).get()?.total, name).toBe(0);
    }
  } finally { sql.close(); }
}, 90_000);

it("reports invalid control configuration without echoing its value or a stack trace", async () => {
  const assets = join(scratch, "config-viewer");
  await mkdir(assets);
  await writeFile(join(assets, "index.html"), "<!doctype html><title>Configuration fixture</title>");
  const invalid = "do-not-echo-this-config-value";
  const relay = child([relayMain], { SYNC_RELAY_TEST_AUTH: "1", SYNC_RELAY_PORT: "0",
    SYNC_RELAY_DB_PATH: join(scratch, "invalid-config.sqlite"), DOHC_RELAY_EXCHANGE_KEY: exchangeKey,
    DOHC_DEVICE_CONTROL_LIMITS: invalid, DOHC_RELAY_DEVICE_CONTROL_HOSTS: "relay.test" });
  expect(await relay.exited).toBe(1);
  const share = child([shareMain], { DOHC_SHARE_WEB_DEV: "1", DOHC_SHARE_WEB_PORT: "0",
    DOHC_SHARE_WEB_RELAY_URL: "http://127.0.0.1:1", DOHC_SHARE_WEB_PUBLIC_RELAY_URL: "http://127.0.0.1:1",
    DOHC_SHARE_WEB_PUBLIC_HOSTS: "share.test", DOHC_SHARE_WEB_RELAY_EXCHANGE_KEY: exchangeKey,
    DOHC_SHARE_WEB_TEST_VIEWER_ASSETS_DIR: assets, DOHC_DEVICE_CONTROL_LIMITS: JSON.stringify(limits),
    DOHC_SHARE_WEB_DEVICE_CONTROL_ADMISSION: invalid });
  expect(await share.exited).toBe(1);
  for (const processHandle of [relay, share]) {
    expect(processHandle.logs()).toContain("FATAL: Invalid device control configuration.");
    expect(processHandle.logs()).not.toContain(invalid);
    expect(processHandle.logs()).not.toContain("SyntaxError");
    expect(processHandle.logs()).not.toContain("TypeError");
  }
}, 60_000);
