import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { access, mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const LOOPBACK_HOST = "127.0.0.1";
const RELAY_STARTUP_TIMEOUT_MS = 45_000;
const SHARE_WEB_STARTUP_TIMEOUT_MS = 45_000;
const CHILD_STOP_TIMEOUT_MS = 15_000;
const FORCED_STOP_TIMEOUT_MS = 2_000;
const BUILD_VIEWER_COMMAND = "pnpm --filter @dohc/share-web build";

interface ServiceProcess {
  child: ChildProcess;
  label: string;
  stderr: () => string;
  stdout: () => string;
}

export interface StackEnvironment {
  relay: NodeJS.ProcessEnv;
  shareWeb: NodeJS.ProcessEnv;
}

export interface RunningStack {
  env: StackEnvironment;
  relayUrl: string;
  shareWebUrl: string;
  stop: () => Promise<void>;
}

export interface SeedFile {
  content: string | Uint8Array;
  contentKind?: "text" | "binary";
  path: string;
}

export interface SeedShareOptions {
  files: readonly SeedFile[];
  ownerUserId?: string;
  paths?: readonly string[];
  recipientUserId?: string;
  relayUrl: string;
  workspaceId?: string;
}

export interface SeededFile {
  blobSha256: string;
  momentId: string;
  objectId: string;
  path: string;
}

export interface SeededShare {
  files: SeededFile[];
  grantId: string;
  ownerUserId: string;
  recipientUserId: string;
  secret: string;
  shareId: string;
  workspaceId: string;
}

export interface ProbeRequest {
  headers: Record<string, string>;
  method: string;
  origin: "cross-site" | "same-hostname";
  path: string;
}

export interface RunningProbe {
  requests: ProbeRequest[];
  sameHostnameUrl: string;
  stop: () => Promise<void>;
  url: string;
}

function packageRoots(): { relay: string; shareWeb: string } {
  return {
    relay: fileURLToPath(new URL("../../sync-relay/", import.meta.url)),
    shareWeb: fileURLToPath(new URL("../", import.meta.url)),
  };
}

function serviceArguments(mainUrl: URL): string[] {
  if (process.platform !== "win32") {
    return ["--import", "tsx/esm", fileURLToPath(mainUrl)];
  }
  return [
    "--import",
    "tsx",
    "--input-type=module",
    "--eval",
    `process.on("message", (message) => { if (message === "SIGTERM") process.emit("SIGTERM"); }); await import(${JSON.stringify(mainUrl.href)});`,
  ];
}

function spawnService(
  label: string,
  mainUrl: URL,
  cwd: string,
  env: NodeJS.ProcessEnv,
): ServiceProcess {
  const child = spawn(process.execPath, serviceArguments(mainUrl), {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
  });
  if (!child.stdout || !child.stderr) {
    child.kill();
    throw new Error(`${label} child did not expose piped output`);
  }

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  return {
    child,
    label,
    stderr: () => stderr,
    stdout: () => stdout,
  };
}

function waitForListening(
  service: ServiceProcess,
  pattern: RegExp,
  timeoutMs: number,
): Promise<RegExpExecArray> {
  return new Promise((resolve, reject) => {
    const { child } = service;
    const finish = (error?: Error, match?: RegExpExecArray): void => {
      clearTimeout(timeout);
      child.stdout?.off("data", inspectStdout);
      child.off("error", onError);
      child.off("close", onClose);
      if (error) reject(error);
      else if (match) resolve(match);
    };
    const diagnostics = (): string =>
      `stdout:\n${service.stdout()}\nstderr:\n${service.stderr()}`;
    const inspectStdout = (): void => {
      const match = pattern.exec(service.stdout());
      if (match) finish(undefined, match);
    };
    const onError = (error: Error): void => {
      finish(new Error(`${service.label} child failed to start\n${diagnostics()}`, { cause: error }));
    };
    const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
      finish(
        new Error(
          `${service.label} exited before listening (code=${String(code)}, signal=${String(signal)})\n${diagnostics()}`,
        ),
      );
    };
    const timeout = setTimeout(() => {
      finish(
        new Error(
          `${service.label} did not report its listening port within ${String(timeoutMs)} ms\n${diagnostics()}`,
        ),
      );
    }, timeoutMs);
    child.stdout?.on("data", inspectStdout);
    child.once("error", onError);
    child.once("close", onClose);
    inspectStdout();
  });
}

function waitForExit(
  child: ChildProcess,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

async function settleWithin<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<{ kind: "settled"; value: T } | { kind: "timeout" }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ kind: "timeout" }>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
  });
  try {
    return await Promise.race([
      promise.then((value) => ({ kind: "settled" as const, value })),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function stopService(service: ServiceProcess): Promise<void> {
  const { child } = service;
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exit = waitForExit(child);
  if (process.platform === "win32" && child.connected) {
    child.send("SIGTERM");
  } else {
    child.kill("SIGTERM");
  }
  if ((await settleWithin(exit, CHILD_STOP_TIMEOUT_MS)).kind === "settled") return;

  child.kill("SIGKILL");
  if ((await settleWithin(exit, FORCED_STOP_TIMEOUT_MS)).kind === "timeout") {
    throw new Error(
      `${service.label} child pid=${String(child.pid ?? "unknown")} did not exit after SIGKILL\n` +
        `stdout:\n${service.stdout()}\nstderr:\n${service.stderr()}`,
    );
  }
}

async function allocatePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(0, LOOPBACK_HOST, () => {
      server.off("error", onError);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("port allocator did not bind a loopback TCP port");
  }
  const { port } = address;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

export async function startStack(): Promise<RunningStack> {
  const roots = packageRoots();
  const viewerIndex = join(roots.shareWeb, "viewer", "dist", "index.html");
  try {
    await access(viewerIndex);
  } catch {
    throw new Error(
      `share-web viewer assets are missing at ${viewerIndex}. Run: ${BUILD_VIEWER_COMMAND}`,
    );
  }

  const shareWebPort = await allocatePort();
  const tempRoot = await mkdtemp(join(tmpdir(), "dohc-share-web-browser-"));
  const relayExchangeKey = randomBytes(32).toString("base64url");
  const relayLinkKey = randomBytes(32).toString("base64url");
  const relayEnv: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "test",
    SYNC_RELAY_TEST_AUTH: "1",
    SYNC_RELAY_PORT: "0",
    SYNC_RELAY_DB_PATH: join(tempRoot, "relay.sqlite"),
    DOHC_RELAY_EXCHANGE_KEY: relayExchangeKey,
    DOHC_RELAY_LINK_KEY: relayLinkKey,
    FORCE_COLOR: "0",
  };
  const shareWebEnv: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "test",
    DOHC_SHARE_WEB_RELAY_EXCHANGE_KEY: relayExchangeKey,
    DOHC_SHARE_WEB_PUBLIC_HOSTS: `${LOOPBACK_HOST}:${String(shareWebPort)}`,
    DOHC_SHARE_WEB_PORT: String(shareWebPort),
    DOHC_SHARE_WEB_BIND: LOOPBACK_HOST,
    FORCE_COLOR: "0",
  };
  delete shareWebEnv.DOHC_SHARE_WEB_DEV;
  delete shareWebEnv.DOHC_SHARE_WEB_TEST_VIEWER_ASSETS_DIR;

  const services: ServiceProcess[] = [];
  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    const failures: unknown[] = [];
    for (const service of [...services].reverse()) {
      try {
        await stopService(service);
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      await rm(tempRoot, { recursive: true, force: true });
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "browser-isolation stack cleanup failed");
    }
  };

  try {
    const relay = spawnService(
      "sync relay",
      new URL("../../sync-relay/src/main.ts", import.meta.url),
      roots.relay,
      relayEnv,
    );
    services.push(relay);
    const relayMatch = await waitForListening(
      relay,
      /SYNC_RELAY_LISTENING host=([^\s]+) port=(\d+)/u,
      RELAY_STARTUP_TIMEOUT_MS,
    );
    const relayUrl = `http://${relayMatch[1]}:${relayMatch[2]}`;
    shareWebEnv.DOHC_SHARE_WEB_RELAY_URL = relayUrl;

    const shareWeb = spawnService(
      "share-web",
      new URL("../src/main.ts", import.meta.url),
      roots.shareWeb,
      shareWebEnv,
    );
    services.push(shareWeb);
    const shareWebMatch = await waitForListening(
      shareWeb,
      /SHARE_WEB_LISTENING host=([^\s]+) port=(\d+)/u,
      SHARE_WEB_STARTUP_TIMEOUT_MS,
    );
    if (Number(shareWebMatch[2]) !== shareWebPort) {
      throw new Error(
        `share-web listened on ${shareWebMatch[2]} instead of pre-allocated port ${String(shareWebPort)}`,
      );
    }

    return {
      env: { relay: relayEnv, shareWeb: shareWebEnv },
      relayUrl,
      shareWebUrl: `http://${LOOPBACK_HOST}:${String(shareWebPort)}`,
      stop,
    };
  } catch (error) {
    try {
      await stop();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "browser-isolation stack startup failed");
    }
    throw error;
  }
}

function encodedSegment(value: string): string {
  return encodeURIComponent(value);
}

function randomId(prefix: string): string {
  return `${prefix}-${randomBytes(8).toString("hex")}`;
}

function ownerHeaders(ownerUserId: string, json = false): Headers {
  const headers = new Headers({ authorization: `Bearer test:${ownerUserId}` });
  if (json) headers.set("content-type", "application/json");
  return headers;
}

async function expectHttpOk(response: Response, operation: string): Promise<Response> {
  if (response.ok) return response;
  const responseBody = await response.text();
  throw new Error(
    `${operation} failed with HTTP ${String(response.status)} ${response.statusText}: ${responseBody}`,
  );
}

async function responseObject(response: Response, operation: string): Promise<Record<string, unknown>> {
  await expectHttpOk(response, operation);
  return (await response.json()) as Record<string, unknown>;
}

function requiredString(value: unknown, field: string, operation: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${operation} returned no ${field}`);
  }
  return value;
}

export async function seedShare(options: SeedShareOptions): Promise<SeededShare> {
  if (options.files.length === 0) throw new Error("seedShare requires at least one file");
  const workspaceId = options.workspaceId ?? randomId("workspace-browser");
  const ownerUserId = options.ownerUserId ?? randomId("owner-browser");
  const recipientUserId = options.recipientUserId ?? randomId("recipient-browser");
  const workspacePath = `/sync/${encodedSegment(workspaceId)}`;
  const relayUrl = options.relayUrl.replace(/\/+$/u, "");

  await expectHttpOk(
    await fetch(`${relayUrl}/sync/workspaces`, {
      method: "POST",
      headers: ownerHeaders(ownerUserId, true),
      body: JSON.stringify({ workspaceId }),
    }),
    "create workspace",
  );

  const seededFiles: SeededFile[] = [];
  for (const file of options.files) {
    const bytes = Buffer.from(file.content);
    const blobSha256 = createHash("sha256").update(bytes).digest("hex");
    await expectHttpOk(
      await fetch(`${relayUrl}${workspacePath}/blobs/${blobSha256}`, {
        method: "PUT",
        headers: ownerHeaders(ownerUserId),
        body: bytes,
      }),
      `upload ${file.path}`,
    );
    seededFiles.push({
      blobSha256,
      momentId: randomId("moment-browser"),
      objectId: randomId("object-browser"),
      path: file.path,
    });
  }

  const recordedAtMs = Date.now();
  await expectHttpOk(
    await fetch(`${relayUrl}${workspacePath}/log`, {
      method: "POST",
      headers: ownerHeaders(ownerUserId, true),
      body: JSON.stringify({
        originId: randomId("origin-browser"),
        ops: seededFiles.map((seededFile, index) => {
          const fixture = options.files[index]!;
          return {
            originSeq: index,
            opKind: "moment.append",
            recordedAtMs: recordedAtMs + index,
            payload: {
              momentId: seededFile.momentId,
              versionId: "main",
              objectId: seededFile.objectId,
              path: seededFile.path,
              recordedAtMs: recordedAtMs + index,
              operation: "write",
              payloadBeforeBlobSha256: null,
              payloadBeforePath: null,
              payloadAfterBlobSha256: seededFile.blobSha256,
              payloadAfterPath: seededFile.path,
              ...(fixture.contentKind === "binary"
                ? { payloadAfterContentKind: "binary" }
                : {}),
              metadata: { origin: "user" },
              beforePresent: "null",
            },
          };
        }),
      }),
    }),
    "append seeded moments",
  );

  const share = await responseObject(
    await fetch(`${relayUrl}${workspacePath}/shares`, {
      method: "POST",
      headers: ownerHeaders(ownerUserId, true),
      body: JSON.stringify({
        recipientUserId,
        paths: [...(options.paths ?? ["docs"])],
        access: "view",
      }),
    }),
    "create path share",
  );
  const shareId = requiredString(share.shareId, "shareId", "create path share");
  const link = await responseObject(
    await fetch(`${relayUrl}${workspacePath}/shares/${encodedSegment(shareId)}/links`, {
      method: "POST",
      headers: ownerHeaders(ownerUserId, true),
      body: JSON.stringify({ access: "view" }),
    }),
    "create link grant",
  );
  const secret = requiredString(link.secret, "secret", "create link grant");
  if (!/^[A-Za-z0-9_-]{43}$/u.test(secret)) {
    throw new Error(
      `create link grant returned an invalid fragment value (length=${String(secret.length)})`,
    );
  }

  return {
    files: seededFiles,
    grantId: requiredString(link.grantId, "grantId", "create link grant"),
    ownerUserId,
    recipientUserId,
    secret,
    shareId,
    workspaceId,
  };
}

function recordedHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const recorded: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) recorded[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  return recorded;
}

async function listenProbe(
  origin: ProbeRequest["origin"],
  requests: ProbeRequest[],
): Promise<{ port: number; server: Server }> {
  const server = createServer((request, response) => {
    requests.push({
      headers: recordedHeaders(request.headers),
      method: request.method ?? "GET",
      origin,
      path: request.url ?? "/",
    });
    request.resume();
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end("<!doctype html><title>Browser isolation probe</title>");
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(0, LOOPBACK_HOST, () => {
      server.off("error", onError);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("probe server did not bind a loopback TCP port");
  }
  return { port: address.port, server };
}

async function stopServer(server: Server): Promise<void> {
  if (!server.listening) return;
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

export async function startProbe(): Promise<RunningProbe> {
  const requests: ProbeRequest[] = [];
  const crossSite = await listenProbe("cross-site", requests);
  try {
    const sameHostname = await listenProbe("same-hostname", requests);
    let stopped = false;
    return {
      requests,
      url: `http://localhost:${String(crossSite.port)}`,
      sameHostnameUrl: `http://${LOOPBACK_HOST}:${String(sameHostname.port)}`,
      stop: async () => {
        if (stopped) return;
        stopped = true;
        await Promise.all([stopServer(crossSite.server), stopServer(sameHostname.server)]);
      },
    };
  } catch (error) {
    await stopServer(crossSite.server);
    throw error;
  }
}
