// A self-hosted dohc server on this machine, for the editing-together tests: the sync relay with its
// own engine, the share page's server, and a headless engine that plays the owner's computer.
// Nothing here reaches an outside server. The relay and the share page's server run as their own
// processes, so a test can kill or restart either one under open pages.
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { connect, createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createTlsServer, type Server as TlsServer } from "node:tls";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, expect, type Browser } from "@playwright/test";
import { patchFrontmatter } from "@dohc/ydoc-projection/frontmatter-map";
import * as Y from "yjs";
import { mintLocalhostCa } from "../../../../services/share-web/src/testing/localhostCa";
import { selfHostLiveProfile } from "../../../../services/sync-relay/src/selfHostLiveProfile";
import { resolveEngineBinary } from "../../src/testing/engineBinary";
import { waitForPathMoments } from "../../src/workspaces/waitForPathMoments";
import { createWorkspaceEngineCapture } from "../../src/workspaces/workspaceEngineCapture";
import { openLiveDaemonWorkspace } from "../helpers/daemonSeed";
import { startServerProxy } from "../helpers/selfHostOnboarding";
import { testCertificate } from "../helpers/sharedDatasetBrowser";
import {
  relayAdoptedIdentity,
  reserveRelayPort,
  spawnSyncRelay,
  type SyncRelayHandle,
} from "../helpers/syncRelay";

const VIEWER_HOST = "viewer.example.com";
const VIEWER_ORIGIN = `https://${VIEWER_HOST}`;
const WORKSPACE_ID = "together";
const OWNER_TOKEN = "test:together-owner";
const shareWebRoot = fileURLToPath(new URL("../../../../services/share-web/", import.meta.url));

/** A note its owner shared with an Edit link. */
export interface SharedNote {
  /** The file's name, which is its button on the share page. */
  path: string;
  /** The share link, as the owner would send it. */
  link: string;
}

export interface TogetherStack {
  browser: Browser;
  /** The owner writes a note, opens it once, shares it with an Edit link, and closes dohc. */
  shareNote(path: string, markdown: string): Promise<SharedNote>;
  /** The note's file as the server stores it now. */
  storedFile(note: SharedNote): Promise<string>;
  /** Ends the relay and its engine at once, with no shutdown. */
  killRelay(): Promise<void>;
  /** Starts the relay again on the same address, over the same stored data. */
  startRelay(): Promise<void>;
  /** Stops the share page's server and starts a new one on the same address. */
  restartShareService(): Promise<void>;
  /** The services' recent output, for a failure report. */
  output(): string;
  close(): Promise<void>;
}

interface Service {
  child: ChildProcess;
  output(): string;
  stop(): Promise<void>;
}

/** The share page's server as its own process, with a self-hosted server's limits for Edit links. */
async function startShareService(input: {
  port: number;
  relayUrl: string;
  exchangeKey: string;
  sealKey: string;
}): Promise<Service> {
  const profile = selfHostLiveProfile();
  const main = pathToFileURL(join(shareWebRoot, "src/main.ts")).href;
  const child = spawn(
    process.execPath,
    [
      "--import",
      process.platform === "win32" ? "tsx" : "tsx/esm",
      "--input-type=module",
      "--eval",
      `process.on("message", (message) => { if (message === "SIGTERM") process.emit("SIGTERM"); }); await import(${JSON.stringify(main)});`,
    ],
    {
      cwd: shareWebRoot,
      env: {
        ...process.env,
        NODE_ENV: "test",
        DOHC_SHARE_WEB_RELAY_URL: input.relayUrl,
        DOHC_SHARE_WEB_PUBLIC_RELAY_URL: input.relayUrl,
        DOHC_SHARE_WEB_RELAY_EXCHANGE_KEY: input.exchangeKey,
        // The same key before and after a restart, as a self-hosted server keeps it, so open pages go on working.
        DOHC_SHARE_WEB_SESSION_SEAL_KEY: input.sealKey,
        DOHC_SHARE_WEB_PUBLIC_ORIGIN: VIEWER_ORIGIN,
        DOHC_SHARE_WEB_PUBLIC_HOSTS: VIEWER_HOST,
        DOHC_SHARE_WEB_INTERNAL_HOSTS: `127.0.0.1:${String(input.port)}`,
        DOHC_SHARE_WEB_PORT: String(input.port),
        DOHC_SHARE_WEB_BIND: "127.0.0.1",
        DOHC_SHARE_WEB_LINK_LIVE_LIMITS: JSON.stringify({
          requests: profile.requests,
          gateway: profile.gateway,
          editor: profile.editor,
        }),
        DOHC_PUBLIC_EDIT_RELEASE: JSON.stringify({ version: 1 }),
        // A restart in a test should not wait out the production drain.
        DOHC_SHARE_WEB_TEST_SHUTDOWN_GRACE_PERIOD_MS: "1000",
        FORCE_COLOR: "0",
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      windowsHide: true,
    },
  );
  let text = "";
  child.stdout?.on("data", (chunk) => (text += String(chunk)));
  child.stderr?.on("data", (chunk) => (text += String(chunk)));
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  const stop = async (): Promise<void> => {
    if (child.exitCode === null && child.signalCode === null) {
      // A hang guard for a server that does not finish its shutdown.
      const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
      if (child.connected) child.send("SIGTERM");
      else child.kill("SIGTERM");
      await closed;
      clearTimeout(timer);
    }
  };
  await new Promise<void>((resolve, reject) => {
    // A hang guard: a server that dies is reported at once by the exit handler.
    const timer = setTimeout(
      () => reject(new Error(`The share page's server did not start.\n${text}`)),
      120_000,
    );
    const look = () => {
      if (!/SHARE_WEB_LISTENING /u.test(text)) return;
      clearTimeout(timer);
      resolve();
    };
    child.stdout?.on("data", look);
    child.once("exit", () => {
      clearTimeout(timer);
      reject(new Error(`The share page's server exited before it listened.\n${text}`));
    });
    look();
  }).catch(async (error: unknown) => {
    await stop();
    throw error;
  });
  return { child, output: () => text, stop };
}

/** HTTPS in front of the share page's server, as a deployment's proxy. It carries the live editor's socket too. */
async function startTlsFront(
  port: number,
): Promise<{ server: TlsServer; port: number; spki: string }> {
  const { tls, cert } = testCertificate();
  const server = createTlsServer(tls, (socket) => {
    const upstream = connect(port, "127.0.0.1");
    socket.pipe(upstream).pipe(socket);
    // Either side going away ends the other, as a proxy does when its server restarts.
    socket.on("error", () => upstream.destroy());
    upstream.on("error", () => socket.destroy());
    socket.on("close", () => upstream.destroy());
    upstream.on("close", () => socket.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No TLS listener.");
  return {
    server,
    port: address.port,
    spki: createHash("sha256")
      .update(cert.publicKey.export({ type: "spki", format: "der" }))
      .digest("base64"),
  };
}

/**
 * One request to the relay as the owner, on a connection of its own.
 *
 * The relay closes a connection that has been idle for five seconds. A request that reuses a
 * kept connection at that moment fails with a reset before the relay reads it, and the owner's
 * engine can take about that long between this file's requests on a busy machine.
 */
function ownerRequest(
  baseUrl: string,
  path: string,
  json?: unknown,
  token = OWNER_TOKEN,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const call = request(
      `${baseUrl}${path}`,
      {
        agent: false,
        method: json === undefined ? "GET" : "POST",
        headers: {
          authorization: `Bearer ${token}`,
          ...(json === undefined ? {} : { "content-type": "application/json" }),
        },
        // A hang guard: a relay that takes the request and never answers.
        timeout: 30_000,
      },
      (answer) => {
        const chunks: Buffer[] = [];
        answer.on("data", (chunk: Buffer) => chunks.push(chunk));
        answer.on("end", () =>
          resolve({ status: answer.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
        );
        answer.on("error", reject);
      },
    );
    call.on("timeout", () => call.destroy(new Error(`The relay did not answer ${path}.`)));
    call.on("error", reject);
    call.end(json === undefined ? undefined : JSON.stringify(json));
  });
}

/** A file as the relay stores it now: the newest saved version in the workspace's log. */
export async function relayStoredFile(
  relay: Pick<SyncRelayHandle, "baseUrl" | "dbPath">,
  workspaceId: string,
  path: string,
  token = OWNER_TOKEN,
): Promise<string> {
  const identity = relayAdoptedIdentity(relay.dbPath, workspaceId);
  if (!identity) throw new Error("The workspace has no place on the relay yet.");
  let since = 0;
  let sha: string | undefined;
  for (;;) {
    const query = new URLSearchParams({ since: String(since), limit: "1000", ...identity });
    const page = await ownerRequest(
      relay.baseUrl,
      `/sync/${workspaceId}/log?${query}`,
      undefined,
      token,
    );
    expect(page.status, page.body).toBe(200);
    // A page can hold fewer rows than asked for, so the relay says whether more follow.
    const answer = JSON.parse(page.body) as {
      ops: Array<{
        opKind: string;
        payload: { path?: string; payloadAfterBlobSha256?: string | null };
      }>;
      nextCursor: number;
      hasMore: boolean;
    };
    for (const op of answer.ops)
      if (op.opKind === "moment.append" && op.payload.path === path)
        sha = op.payload.payloadAfterBlobSha256 ?? undefined;
    if (!answer.hasMore) break;
    since = answer.nextCursor;
  }
  if (!sha) throw new Error(`The server stores no version of ${path}.`);
  const blob = await ownerRequest(
    relay.baseUrl,
    `/sync/${workspaceId}/blobs/${sha}`,
    undefined,
    token,
  );
  expect(blob.status).toBe(200);
  return blob.body;
}

async function reservePort(): Promise<number> {
  const listener = createTcpServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  if (!address || typeof address === "string") throw new Error("No port reserved.");
  return address.port;
}

export async function startTogetherStack(): Promise<TogetherStack> {
  if (!existsSync(join(shareWebRoot, "viewer/dist/index.html")))
    throw new Error("The share page is not built. Run pnpm --filter @dohc/share-web build.");
  const root = await mkdtemp(join(tmpdir(), "dohc-together-"));
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot);
  const exchangeKey = randomBytes(32).toString("base64url");
  const linkKey = randomBytes(32).toString("base64url");
  const sealKey = randomBytes(32).toString("base64url");
  const closers: Array<() => Promise<unknown>> = [];
  const close = async (): Promise<void> => {
    for (const closer of closers.splice(0).reverse()) await closer().catch(() => undefined);
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }).catch(
      () => undefined,
    );
  };
  try {
    const ca = await mintLocalhostCa(root);
    const proxy = await startServerProxy(ca);
    closers.push(() => proxy.close());
    const relayPort = await reserveRelayPort();
    const openRelay = () =>
      spawnSyncRelay({
        dbPath: join(root, "relay", "relay.sqlite"),
        port: relayPort,
        hardKill: true,
        editLinks: {
          engineExecutable: resolveEngineBinary(),
          publicOrigin: proxy.origin,
          trustEnv: {
            NODE_EXTRA_CA_CERTS: ca.caPath,
            DOHC_ENGINE_TEST_RELAY_CA_MODE: "1",
            DOHC_ENGINE_TEST_RELAY_CA_FILE: ca.caPath,
          },
        },
        linkBoundary: { linkKey, relayExchangeKey: exchangeKey, publicViewerOrigin: VIEWER_ORIGIN },
      });
    let relay: SyncRelayHandle = await openRelay();
    let relayOutput = "";
    closers.push(() => relay.stop());
    proxy.routeRelayTo(relay.baseUrl);

    const sharePort = await reservePort();
    const openShareService = () =>
      startShareService({ port: sharePort, relayUrl: relay.baseUrl, exchangeKey, sealKey });
    let shareService = await openShareService();
    let shareOutput = "";
    closers.push(() => shareService.stop());
    const front = await startTlsFront(sharePort);
    closers.push(
      () =>
        new Promise<void>((resolve) => {
          front.server.close(() => resolve());
        }),
    );
    const browser = await chromium.launch({
      headless: true,
      args: [
        `--ignore-certificate-errors-spki-list=${front.spki}`,
        `--host-resolver-rules=MAP ${VIEWER_HOST} 127.0.0.1:${String(front.port)}`,
        "--no-proxy-server",
      ],
    });
    closers.push(() => browser.close());

    const owner = { baseUrl: relay.baseUrl, token: OWNER_TOKEN };
    let claimed = false;
    const shareNote = async (path: string, markdown: string): Promise<SharedNote> => {
      const daemon = await openLiveDaemonWorkspace({
        workspaceId: WORKSPACE_ID,
        rootPath: workspaceRoot,
      });
      const capture = createWorkspaceEngineCapture({
        ...daemon.workspace,
        rustEngineSessions: daemon.sessions,
      });
      try {
        const sync = daemon.relay.bind({ ...daemon.workspace, relay: owner });
        const push = async () => {
          let pushed = await sync.push();
          while (pushed.hasMore) pushed = await sync.push();
        };
        if (!claimed) {
          await sync.claim();
          await daemon.chats.ensureGeneralChannel({ workspaceId: WORKSPACE_ID });
          // A first push gives the workspace its place on the relay, so the note that follows is sent.
          await push();
          claimed = true;
        }
        await capture.writeAuthoredFile(
          join(workspaceRoot, path),
          markdown,
          { kind: "human", humanId: "together-owner" },
          { createOnly: true },
        );
        await waitForPathMoments(capture, path, 1);
        // The server starts live editing only for a note its owner has opened in dohc. This is
        // that open, with one edit to the note's properties, as the two-daemon adoption test makes it.
        const opened = await capture.openYDocSession({
          path,
          contentKind: "richdoc",
          onRemoteUpdate: () => undefined,
        });
        await opened.applyDecidedLocalUpdate(
          (doc) => {
            const scratch = new Y.Doc();
            try {
              Y.applyUpdate(scratch, Y.encodeStateAsUpdate(doc));
              const before = Y.encodeStateVector(scratch);
              patchFrontmatter(scratch, new Map([["status", "draft"]]));
              return Y.encodeStateAsUpdate(scratch, before);
            } finally {
              scratch.destroy();
            }
          },
          undefined,
          {
            actorOriginId: "together-owner",
            attribution: { actorKind: "human" },
            idempotencyKey: `owner-open-${path}`,
          },
        );
        await opened.settleNow();
        await push();
        await opened.close();
        await push();
      } finally {
        await capture.stop();
        await daemon.close();
      }
      const created = await ownerRequest(relay.baseUrl, `/sync/${WORKSPACE_ID}/shares/links`, {
        paths: [path],
        access: "edit",
      });
      expect(created.status, `The Edit link was not made: ${created.body}`).toBe(200);
      // The server takes a moment to load a newly shared note. Its owner's list of live notes
      // says when the note is ready; a page that asks sooner is told editing could not start.
      await expect
        .poll(
          async () => {
            const host = await ownerRequest(relay.baseUrl, `/sync/${WORKSPACE_ID}/live-host`);
            const documents =
              (JSON.parse(host.body) as { documents?: Array<{ path: string; status: string }> })
                .documents ?? [];
            return documents.find((document) => document.path === path)?.status ?? host.body;
          },
          { timeout: 120_000, intervals: [250] },
        )
        .toBe("ready");
      return {
        path,
        link: `${VIEWER_ORIGIN}/s${new URL((JSON.parse(created.body) as { url: string }).url).hash}`,
      };
    };

    return {
      browser,
      shareNote,
      storedFile: (note) => relayStoredFile(relay, WORKSPACE_ID, note.path),
      async killRelay() {
        relayOutput += tail(relay);
        await relay.kill();
      },
      async startRelay() {
        relay = await openRelay();
      },
      async restartShareService() {
        shareOutput += shareService.output().slice(-4_000);
        await shareService.stop();
        shareService = await openShareService();
      },
      output: () =>
        `---- relay\n${relayOutput}${tail(relay)}\n---- share page's server\n${shareOutput}${shareService
          .output()
          .slice(-4_000)}`,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

/** The relay's recent output without its request lines, which crowd out what it said. */
function tail(relay: SyncRelayHandle): string {
  const { stdout, stderr } = relay.diagnostics();
  const said = (text: string) =>
    text
      .split("\n")
      .filter(
        (line) =>
          !line.startsWith("[sync-relay] request ") && !line.startsWith("Relay main thread"),
      )
      .join("\n")
      .slice(-6_000);
  return `${said(stdout)}\n${said(stderr)}\n`;
}
