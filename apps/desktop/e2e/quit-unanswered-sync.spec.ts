import { expect, test } from "@playwright/test";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { connect, createServer, type Socket } from "node:net";
import { join } from "node:path";
import { launchDesktopApp, within } from "./helpers/desktopApp";
import { spawnSyncRelay, type SyncRelayHandle } from "./helpers/syncRelay";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  openWorkspaceFromFirstRun,
  seedCloudCredentials,
  seedWorkspaceManifest,
  seedWorkspaceRegistry,
  writeWorkspaceFiles,
} from "./helpers/workspace";

// #2868: with a synced workspace open, quit stays within its 6 s budget
// while the sync server takes each connection and never answers. One case
// leaves only the push unanswered. The other also leaves the read of the
// relay's automation host record unanswered. The pull case comes with the
// rest of #2868.

type Launched = Awaited<ReturnType<typeof launchDesktopApp>>;

interface HeldRequest {
  line: string | null;
  closed: boolean;
}

const REQUEST_LINE = /^(?:GET|POST|PUT|PATCH|DELETE) [^ \r\n]+ HTTP\/1\.[01]/gmu;

// The app's sync server. In "pass" it passes each connection to the relay
// and records its request lines. In "hold-reads" it does the same, except
// that it keeps each automation host read open without an answer. In "hold"
// it takes every new connection, records its request line and never answers.
// Held requests record whether the app closed them.
async function startSyncServer(relay: SyncRelayHandle, hostRead: string, mode: "pass" | "hold-reads") {
  const relayHost = new URL(relay.baseUrl).hostname;
  const piped = new Set<Socket>();
  const heldSockets = new Map<Socket, HeldRequest>();
  const held: HeldRequest[] = [];
  const seen: string[] = [];
  let current: "pass" | "hold-reads" | "hold" = mode;
  const keep = (socket: Socket, line: string | null) => {
    const request: HeldRequest = { line, closed: false };
    heldSockets.set(socket, request);
    held.push(request);
    socket.on("close", () => {
      request.closed = true;
      heldSockets.delete(socket);
    });
    return request;
  };
  const server = createServer((socket) => {
    socket.on("error", () => undefined);
    if (current === "hold") {
      const request = keep(socket, null);
      let head = "";
      socket.on("data", (chunk: Buffer) => {
        if (request.line !== null) return;
        head += chunk.toString("latin1");
        const end = head.indexOf("\r\n");
        if (end >= 0) request.line = head.slice(0, end);
      });
      return;
    }
    piped.add(socket);
    let kept = false;
    const upstream = connect(relay.port, relayHost);
    upstream.on("error", () => undefined);
    upstream.on("close", () => { if (!kept) socket.destroy(); });
    socket.on("close", () => {
      piped.delete(socket);
      upstream.destroy();
    });
    upstream.pipe(socket);
    socket.on("data", (chunk: Buffer) => {
      if (kept) return;
      const text = chunk.toString("latin1");
      const lines = text.match(REQUEST_LINE) ?? [];
      seen.push(...lines);
      const read = lines.find((line) => line.startsWith(hostRead));
      if (current === "hold-reads" && read !== undefined) {
        kept = true;
        piped.delete(socket);
        upstream.unpipe(socket);
        upstream.destroy();
        keep(socket, read);
        return;
      }
      upstream.write(chunk);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("The sync server has no port.");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    held,
    seen,
    openRead: () => held.find((request) => request.line?.startsWith(hostRead) && !request.closed),
    // Ends the open connections, so the app's next requests reach the held server.
    hold() {
      current = "hold";
      for (const socket of piped) socket.destroy();
    },
    // Ends the held requests other than host reads, so the app sends them
    // again, and passes everything but host reads to the relay.
    holdReadsOnly() {
      current = "hold-reads";
      for (const [socket, request] of [...heldSockets]) {
        if (!request.line?.startsWith(hostRead)) socket.destroy();
      }
    },
    pass() {
      current = "pass";
    },
    async close() {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      for (const socket of [...piped, ...heldSockets.keys()]) socket.destroy();
      await closed;
    },
  };
}

// The push sends its blobs and ops with POST.
const pushRequest = (workspaceId: string) => new RegExp(`^POST /sync/${workspaceId}/(?:log[? ]|blobs/)`, "u");

// A Group trigger makes this computer claim the automation host once the
// workspace syncs, and the host then reads the relay's record of the last
// host. No Group needs to exist for that.
const automations = [
  "version: 1",
  "automations:",
  "  - id: task",
  "    name: Add a task",
  "    when: {group-message: Trip, starts-with: /task}",
  "    do: [{add-record: {Title: '=message.body'}}]",
  "",
].join("\n");

const syncStatus = (page: Launched["page"], workspaceId: string) =>
  page.evaluate(async (id) => {
    const status = await window.dohcDesktop!.getSyncStatus({ workspaceId: id });
    return { state: status.state, pendingChangeCount: status.pendingChangeCount };
  }, workspaceId);

for (const unanswered of ["push", "push and host read"] as const) {
  test(`quits within its budget while ${unanswered === "push" ? "a push waits" : "a push and the automation host read wait"} on a sync server that never answers (#2868)`, async () => {
    test.setTimeout(300_000);
    const temp = await createTempWorkspace();
    const workspaceId = unanswered === "push" ? "quit-unanswered-push" : "quit-unanswered-push-read";
    const hostRead = `GET /sync/${workspaceId}/automation-host/groups?generation=`;
    const pushed = pushRequest(workspaceId);
    let relay: SyncRelayHandle | null = null;
    let server: Awaited<ReturnType<typeof startSyncServer>> | null = null;
    let quitting: Launched | null = null;
    let desktop: Launched | null = null;
    try {
      await seedWorkspaceManifest(temp, workspaceId);
      await writeWorkspaceFiles(temp, [
        { path: "notes/plan.md", contents: "draft\n" },
        { path: "Tasks/collection.yaml", contents: "name: Tasks\nfields:\n  Title:\n    type: text\n" },
        { path: "Tasks/automations.yaml", contents: automations },
      ]);
      relay = await spawnSyncRelay({ dbPath: join(temp.baseDir, "relay", "relay.sqlite") });
      const sync = await startSyncServer(relay, hostRead, unanswered === "push" ? "pass" : "hold-reads");
      server = sync;
      await seedWorkspaceRegistry(temp, [{ workspaceId, rootPath: temp.rootPath }]);
      await seedCloudCredentials(temp, { serverUrl: sync.baseUrl, relayUrl: sync.baseUrl, userId: "e2e-user" });
      quitting = await launchDesktopApp({ workspace: temp, env: { DOHC_TEST_SYNC_DEBOUNCE_MS: "150" } });
      const { app, page, logs } = quitting;
      await openWorkspaceFromFirstRun(page, temp);
      await page.evaluate(async (id) => {
        await window.dohcDesktop!.cloudEnableSync({ workspaceId: id });
      }, workspaceId);

      // Holds everything, writes an edit and waits for its push to reach the held server.
      const holdPush = async (round: number) => {
        const before = sync.held.length;
        sync.hold();
        await writeFile(join(temp.rootPath, "notes/plan.md"), `draft\n\nedit ${round} the server never acknowledges\n`);
        await expect.poll(() => sync.held.slice(before).some((request) => pushed.test(request.line ?? "") && !request.closed), {
          timeout: 60_000,
          message: "The push reaches the server that never answers",
        }).toBe(true);
      };
      const synced = () => expect.poll(() => syncStatus(page, workspaceId), { timeout: 60_000 })
        .toEqual({ state: "synced", pendingChangeCount: 0 });

      let readLine: string | null = null;
      if (unanswered === "push") {
        // The host read was answered, so nothing reads it again before quit.
        await expect.poll(() => sync.seen.some((line) => line.startsWith(hostRead)), {
          timeout: 60_000,
          message: "This computer claims the automation host and the relay answers its read",
        }).toBe(true);
        await synced();
        await holdPush(1);
        expect(sync.openRead(), "No automation host read is waiting").toBeUndefined();
      } else {
        // #3406: after a host read fails, the executor reads again only once
        // a pull reaches the relay. A pass pulls after it pushes, so a write
        // the relay answers makes the next read. The client gives up on a
        // read after 15 s, so quit needs that read and the push open at once.
        for (let round = 1; ; round++) {
          await writeFile(join(temp.rootPath, "notes/warm-up.md"), `round ${round}\n`);
          await synced();
          await expect.poll(() => sync.openRead() !== undefined, {
            timeout: 60_000,
            message: "The automation host read waits on the server that never answers",
          }).toBe(true);
          await holdPush(round);
          const read = sync.openRead();
          if (read) {
            readLine = read.line;
            break;
          }
          if (round === 3) throw new Error("In 3 rounds, the client gave up on the host read before its push reached the server, so quit never had both open.");
          sync.holdReadsOnly();
        }
      }

      // The measured quit: from asking the app to quit until its process exits, up to 30 s.
      const child = app.process();
      const exited = new Promise<number>((resolve) => child.once("exit", () => resolve(performance.now())));
      const outputEnded = new Promise<true>((resolve) => child.once("close", () => resolve(true)));
      const started = performance.now();
      await app.evaluate(({ app }) => { app.quit(); });
      const exitedAtMs = await within(exited, 30_000);
      const quitMs = Math.round((exitedAtMs ?? performance.now()) - started);
      // The app writes its quit line just before it exits.
      await within(outputEnded, 5_000);
      const quitLine = logs.find((entry) => entry.source === "main" && entry.text.includes("[desktop] quit: shutdown"))?.text.trim() ?? "no quit line";
      console.log(`#2868 e2e ${unanswered}: ${exitedAtMs !== null ? `quit took ${quitMs} ms` : `app still running after ${quitMs} ms`}; ${quitLine}`);
      expect(exitedAtMs, "The app exits during an unanswered push").not.toBeNull();
      // The app's own quit line. A step that waits on the server, such as
      // closing the workspace, runs past the budget and is named here.
      expect(quitLine, "Quit finishes within its budget, with no step still running").toMatch(/^\[desktop\] quit: shutdown finished in \d+ ms$/u);

      // The next start, with the server answering, sends what the quit left
      // owed, and reads the host record again at the same generation.
      sync.pass();
      const seenBefore = sync.seen.length;
      desktop = await launchDesktopApp({ workspace: temp, env: { DOHC_TEST_SYNC_DEBOUNCE_MS: "150" } });
      await openWorkspaceFromFirstRun(desktop.page, temp);
      if (readLine !== null) {
        await expect.poll(() => sync.seen.slice(seenBefore), {
          timeout: 60_000,
          message: "The automation host read reaches the relay again at the same generation",
        }).toContain(readLine);
      }
      await expect.poll(() => sync.seen.slice(seenBefore), {
        timeout: 60_000,
        message: "The unanswered push reaches the relay again",
      }).toContainEqual(expect.stringMatching(pushed));
      await expect.poll(() => syncStatus(desktop!.page, workspaceId), { timeout: 60_000 })
        .toEqual({ state: "synced", pendingChangeCount: 0 });
    } finally {
      await quitting?.close().catch(() => undefined);
      await server?.close();
      await relay?.stop();
      await cleanupDesktopWorkspace(desktop, temp);
    }
  });
}
