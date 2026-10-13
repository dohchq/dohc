import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, it } from "vitest";
import { parseAppPublicationCandidate, type AppPublicationCandidate } from "@dohc/security-contract/app-publication";
import { buildRelay } from "../scripts/build.mjs";
import { initializeRelayDeployment, openRelayDeployment } from "./relayDeployment";
import { operatorSocketPath } from "./appPublicationOperatorProtocol";
import { hashLinkBearer } from "./linkSecurity";

const limits = { maxFiles: 10, maxMetadataBytes: 16_384, maxBundleBytes: 4 * 1024 * 1024 };
const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const script = Buffer.alloc(2 * 1024 * 1024, 65);
const style = Buffer.from("body { color: red }");
const candidate = (): AppPublicationCandidate => ({
  versionId: "main", appRoot: "app", entryPath: "app/index.ts", packageMap: {}, sourceRevision: "1".repeat(64), sourceDigest: "2".repeat(64),
  dependencyLockDigest: "6".repeat(64), bundleDigest: "7".repeat(64), buildDigest: "8".repeat(64),
  compilerIdentity: {recipe: "closed-esbuild", version: "0.28.1", binarySha256: "3".repeat(64)},
  inputs: [{path: "app/index.ts", sha256: "4".repeat(64), byteLength: 20}, {path: "shared/util.ts", sha256: "5".repeat(64), byteLength: 10}],
  dependencies: ["app/index.ts", "shared/util.ts"],
  files: [{path: "bundle.js", sha256: digest(script), byteLength: script.byteLength, contentType: "text/javascript; charset=utf-8"},
    {path: "bundle.css", sha256: digest(style), byteLength: style.byteLength, contentType: "text/css; charset=utf-8"}],
  capabilities: [],
});
const owner = {workspaceId: "w", shareId: "s", grantId: "g", generation: 1, ownerUserId: "owner"};
const request = () => {
  const value = parseAppPublicationCandidate(candidate(), limits);
  const recordDigest = (domain: string, value: unknown) => digest(JSON.stringify([domain, value]));
  value.sourceDigest = recordDigest("dohc-app-source-v2", {entry: value.entryPath, files: value.inputs, packages: Object.entries(value.packageMap)});
  value.dependencyLockDigest = recordDigest("dohc-app-dependencies-v1", value.inputs);
  value.bundleDigest = recordDigest("dohc-app-bundle-v1", value.files);
  value.buildDigest = recordDigest("dohc-app-build-v1", {sourceDigest: value.sourceDigest, dependencyLockDigest: value.dependencyLockDigest, compiler: value.compilerIdentity, bundleDigest: value.bundleDigest});
  return {...owner, candidate: value, limits, nowMs: 10,
    blobs: [{sha256: digest(script), bytes: script}, {sha256: digest(style), bytes: style}]};
};

const exec = promisify(execFile);
let root: string, command: string;
beforeAll(async () => {
  const scratch = fileURLToPath(new URL("../.output", import.meta.url));
  await mkdir(scratch, {recursive: true});
  root = await mkdtemp(join(scratch, "takedown-process-"));
  await buildRelay(root);
  command = join(root, "app-publication-takedown.js");
}, 30_000);
afterAll(async () => {if (root) await rm(root, {recursive: true, force: true});});

async function run(args: string[], env: NodeJS.ProcessEnv = {}) {
  try {
    const result = await exec(process.execPath, [command, ...args], {windowsHide: true, timeout: 20_000, env: {...process.env, NODE_OPTIONS: "", ...env}});
    return {code: 0, ...result};
  } catch (error) {
    const result = error as Error & {code: number; stdout: string; stderr: string};
    return {code: result.code, stdout: result.stdout, stderr: result.stderr};
  }
}

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, "close");
  child.kill("SIGTERM");
  await closed;
}

it("takes down one publication through the running relay without adding a TCP listener or stopping service", async () => {
  const directory = join(root, "deployment"), config = join(directory, "deployment.json");
  initializeRelayDeployment({configPath: config, relayPath: join(directory, "relay", "relay.sqlite"), continuityDirectory: join(directory, "continuity")});
  const {storage} = openRelayDeployment(config);
  let publicationId: string, otherId: string;
  const token = "A".repeat(43), key = "test-key";
  try {
    storage.claimWorkspace({workspaceId: "w", ownerUserId: "owner", createdAtMs: 1});
    expect(storage.createFileLinkShare({guard: () => {}, credential: {credentialId: "credential", grantId: "g", secretHash: digest("credential"), generation: 1, mintedAtMs: 1, retiredAtMs: null}, share: {shareId: "s", workspaceId: "w", granterUserId: "owner", selectorJson: JSON.stringify({paths: ["app", "shared"], versionId: null}), createdAtMs: 1},
      grant: {grantId: "g", shareId: "s", principalKind: "link", principalUserId: null, principalEmail: null, access: "view", generation: 1, status: "active", createdAtMs: 1, revokedAtMs: null, parentGrantId: null}})).toBe(true);
    publicationId = storage.publishAppPublication(request()).publicationId;
    otherId = storage.publishAppPublication({...request(), candidate: {...request().candidate, sourceRevision: digest("other revision")}}).publicationId;
    storage.mintLinkSession({session: {sessionId: "session", capabilityHash: hashLinkBearer(token, key), grantId: "g", generation: 1, mintedAtMs: 2, expiresAtMs: Date.now() + 300_000}});
  } finally {storage.close();}
  const env = {...process.env, NODE_OPTIONS: "", NODE_ENV: "test", SYNC_RELAY_TEST_AUTH: "1", SYNC_RELAY_PORT: "0", SYNC_RELAY_BIND: "127.0.0.1",
    SYNC_RELAY_DB_PATH: undefined, DOHC_RELAY_DEPLOYMENT_CONFIG: config, DOHC_RELAY_LINK_KEY: key, DOHC_RELAY_APP_PUBLICATIONS: "1",
    DOHC_SELF_HOST_LIVE: "0", DOHC_RELAY_AUTOMATIONS: "0", DOHC_PUBLIC_EDIT_RELEASE: undefined, DOHC_RELAY_ENGINE_EXECUTABLE: undefined,
    DOHC_RELAY_SERVICE_HOST_CONFIG: undefined, DOHC_RELAY_DEVICE_DELIVERY_CONFIG: undefined, DOHC_RELAY_SHARE_WEB_ORIGIN: "http://127.0.0.1:48123"};
  const bootstrap = join(root, "observe-listeners.mjs");
  await writeFile(bootstrap, `import {Server} from "node:net";
const listen = Server.prototype.listen;
Server.prototype.listen = function (...args) {console.log("TEST_LISTEN=" + JSON.stringify({kind: typeof args[0] === "string" ? "ipc" : "tcp", target: args[0]})); return listen.apply(this, args);};
await import(${JSON.stringify(pathToFileURL(join(root, "main.js")).href)});
`);
  const child = spawn(process.execPath, [bootstrap], {env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"]});
  let stdout = "", stderr = "";
  child.stdout!.on("data", bytes => {stdout += String(bytes);});
  child.stderr!.on("data", bytes => {stderr += String(bytes);});
  try {
    const baseUrl = await new Promise<string>((resolve, reject) => {
      const deadline = setTimeout(() => {cleanup(); reject(new Error(`Relay startup timed out. ${stderr}`));}, 45_000);
      const onData = () => {const match = /SYNC_RELAY_LISTENING host=([^\s]+) port=(\d+)/.exec(stdout); if (match) {cleanup(); resolve(`http://${match[1]}:${match[2]}`);}};
      const onExit = () => {cleanup(); reject(new Error(`Relay exited. ${stderr}`));};
      const cleanup = () => {clearTimeout(deadline); child.stdout!.off("data", onData); child.off("exit", onExit);};
      child.stdout!.on("data", onData); child.once("exit", onExit);
    });
    const listeners = stdout.split(/\r?\n/).filter(line => line.startsWith("TEST_LISTEN=")).map(line => JSON.parse(line.slice(12)));
    expect(listeners).toEqual([{kind: "ipc", target: operatorSocketPath(env)}, {kind: "tcp", target: 0}]);
    if (process.platform !== "win32") {
      expect((await stat(operatorSocketPath(env))).mode & 0o777).toBe(0o600);
      const directoryInfo = await stat(dirname(operatorSocketPath(env)));
      expect(directoryInfo.mode & 0o777).toBe(0o700);
      expect(directoryInfo.uid).toBe(process.getuid!());
    }
    const read = (id: string, blob = false) => fetch(`${baseUrl}/sync/link/app-publications/${id}${blob ? `/blobs/${digest(script)}?authorityRevision=1` : ""}`,
      {headers: {authorization: `LinkCapability ${token}`, "x-dohc-link-profile-secret": "P".repeat(43)}});
    const before = await read(publicationId, true);
    expect(before.status).toBe(200);
    await before.body!.cancel();
    expect(await run(["--publication-id", "f".repeat(64), "--reason", "Malware"], env)).toMatchObject({code: 3, stdout: "", stderr: expect.stringContaining("was not found")});
    expect((await read(publicationId)).status).toBe(200);
    const args = ["--publication-id", publicationId, "--reason", "Confirmed phishing"];
    const result = await run(args, env);
    expect(result, result.stderr).toMatchObject({code: 0, stderr: ""});
    expect(JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)!)).toMatchObject({publicationId, authorityRevision: 2, operatorTakedown: {actor: "operator", reason: "Confirmed phishing"}});
    expect((await read(publicationId)).status).toBe(404);
    expect((await read(publicationId, true)).status).toBe(404);
    expect((await read(otherId)).status).toBe(200);
    expect(child.exitCode).toBeNull();
    expect(await run([...args.slice(0, -1), "Retry"], env)).toMatchObject({code: 0, stdout: result.stdout});
  } finally {await stop(child);}
  const reopened = openRelayDeployment(config);
  try {expect(reopened.storage.readAppPublication({...owner, publicationId, limits})).toMatchObject({active: false, operatorTakedown: {reason: "Confirmed phishing"}});}
  finally {reopened.storage.close();}
}, 90_000);

it("returns bad-input and connection failures separately and explains the command", async () => {
  for (const args of [[], ["--publication-id", "bad", "--reason", "Malware"], ["--publication-id", "a".repeat(64), "--reason", " "], ["--other", "value"]]) {
    expect(await run(args)).toMatchObject({code: 2, stdout: "", stderr: expect.stringContaining("Invalid takedown arguments")});
  }
  expect(await run(["--publication-id", "a".repeat(64), "--reason", "Malware"], {SYNC_RELAY_DB_PATH: join(root, "missing.sqlite"), DOHC_RELAY_DEPLOYMENT_CONFIG: undefined}))
    .toMatchObject({code: 1, stdout: "", stderr: expect.stringContaining("Check that the relay is running")});
  expect(await run(["--help"])).toMatchObject({code: 0, stderr: "", stdout: expect.stringContaining("Other publications keep serving.")});
});
