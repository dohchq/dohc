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
// while the sync server takes each connection and never answers, including
// the read of the relay's automation host record.

type Launched = Awaited<ReturnType<typeof launchDesktopApp>>;

interface HeldRequest {
  line: string | null;
  closedAtMs: number | null;
}

const REQUEST_LINE = /^(?:GET|POST|PUT|PATCH|DELETE) [^ \r\n]+ HTTP\/1\.[01]/gmu;

// The app's sync server. Before `hold()` it passes each connection to the
// relay and records its request lines, and it can refuse the automation host
// record. After `hold()` it takes every connection, records its request line
// and when the app closed it, and never answers.
async function startSyncServer(relay: SyncRelayHandle, refused: string) {
  const relayHost = new URL(relay.baseUrl).hostname;
  const piped = new Set<Socket>();
  const heldSockets = new Set<Socket>();
  const held: HeldRequest[] = [];
  const seen: string[] = [];
  let mode: "refuse" | "pass" | "hold" = "refuse";
  let refusals = 0;
  const server = createServer((socket) => {
    socket.on("error", () => undefined);
    if (mode === "hold") {
      heldSockets.add(socket);
      const request: HeldRequest = { line: null, closedAtMs: null };
      held.push(request);
      let head = "";
      socket.on("data", (chunk: Buffer) => {
        if (request.line !== null) return;
        head += chunk.toString("latin1");
        const end = head.indexOf("\r\n");
        if (end >= 0) request.line = head.slice(0, end);
      });
      socket.on("close", () => {
        request.closedAtMs = performance.now();
        heldSockets.delete(socket);
      });
      return;
    }
    piped.add(socket);
    const upstream = connect(relay.port, relayHost);
    upstream.on("error", () => undefined);
    upstream.on("close", () => socket.destroy());
    socket.on("close", () => {
      piped.delete(socket);
      upstream.destroy();
    });
    upstream.pipe(socket);
    socket.on("data", (chunk: Buffer) => {
      const text = chunk.toString("latin1");
      seen.push(...(text.match(REQUEST_LINE) ?? []));
      if (mode === "refuse" && text.includes(refused)) {
        refusals += 1;
        socket.destroy();
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
    refusals: () => refusals,
    // Ends the open connections, so the app's next requests reach the held server.
    hold() {
      mode = "hold";
      for (const socket of piped) socket.destroy();
    },
    pass() {
      mode = "pass";
    },
    async close() {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      for (const socket of [...piped, ...heldSockets]) socket.destroy();
      await closed;
    },
  };
}

// The request each pass waits on. The push sends its blobs and ops with POST.
// The pull reads the log with a `limit`; the relay watch's read names `hold`.
function passRequest(pass: "push" | "pull", workspaceId: string): RegExp {
  return pass === "push"
    ? new RegExp(`^POST /sync/${workspaceId}/(?:log[? ]|blobs/)`, "u")
    : new RegExp(`^GET /sync/${workspaceId}/log\\?(?![^ ]*hold=)[^ ]*limit=`, "u");
}

// A Group trigger makes this computer claim the automation host once the
// workspace syncs, and the host then reads the relay's record of the last
// host. No Group needs to exist for that.
const automations = (name: string) => [
  "version: 1",
  "automations:",
  "  - id: task",
  `    name: ${name}`,
  "    when: {group-message: Trip, starts-with: /task}",
  "    do: [{add-record: {Title: '=message.body'}}]",
  "",
].join("\n");

const syncStatus = (page: Launched["page"], workspaceId: string) =>
  page.evaluate(async (id) => {
    const status = await window.dohcDesktop!.getSyncStatus({ workspaceId: id });
    return { state: status.state, pendingChangeCount: status.pendingChangeCount };
  }, workspaceId);

for (const pass of ["push", "pull"] as const) {
  test(`quits within its budget while a ${pass} and the automation host read wait on a sync server that never answers (#2868)`, async () => {
    test.setTimeout(240_000);
    const temp = await createTempWorkspace();
    const workspaceId = `quit-unanswered-${pass}`;
    const hostRead = `GET /sync/${workspaceId}/automation-host/groups?generation=`;
    let relay: SyncRelayHandle | null = null;
    let server: Awaited<ReturnType<typeof startSyncServer>> | null = null;
    let quitting: Launched | null = null;
    let desktop: Launched | null = null;
    try {
      await seedWorkspaceManifest(temp, workspaceId);
      await writeWorkspaceFiles(temp, [
        { path: "notes/plan.md", contents: "draft\n" },
        { path: "Tasks/collection.yaml", contents: "name: Tasks\nfields:\n  Title:\n    type: text\n" },
        { path: "Tasks/automations.yaml", contents: automations("Add a task") },
      ]);
      relay = await spawnSyncRelay({ dbPath: join(temp.baseDir, "relay", "relay.sqlite") });
      server = await startSyncServer(relay, hostRead);
      await seedWorkspaceRegistry(temp, [{ workspaceId, rootPath: temp.rootPath }]);
      await seedCloudCredentials(temp, { serverUrl: server.baseUrl, relayUrl: server.baseUrl, userId: "e2e-user" });
      quitting = await launchDesktopApp({ workspace: temp, env: { DOHC_TEST_SYNC_DEBOUNCE_MS: "150" } });
      const { app, page, logs } = quitting;
      await openWorkspaceFromFirstRun(page, temp);
      await page.evaluate(async (id) => {
        await window.dohcDesktop!.cloudEnableSync({ workspaceId: id });
      }, workspaceId);
      // The host read fails while the workspace syncs, so the host reads
      // it again at the same generation until the relay answers.
      await expect.poll(() => server?.refusals() ?? 0, {
        timeout: 60_000,
        message: "This computer claims the automation host and reads the relay's record",
      }).toBeGreaterThan(0);
      // No pass is running and nothing waits to be sent.
      await expect.poll(() => syncStatus(page, workspaceId), { timeout: 60_000 })
        .toEqual({ state: "synced", pendingChangeCount: 0 });

      server.hold();
      if (pass === "push") {
        await writeFile(join(temp.rootPath, "notes/plan.md"), "draft\n\nan edit the server never acknowledges\n");
      } else {
        // With nothing to send, the pass makes no push request, so its pull waits.
        await page.evaluate((id) => {
          void window.dohcDesktop!.retryCloudSync({ workspaceId: id, reason: "person" }).catch(() => undefined);
        }, workspaceId);
      }
      await expect.poll(() => server?.held.map((request) => request.line ?? "") ?? [], {
        timeout: 60_000,
        message: `The ${pass} reaches the server that never answers`,
      }).toContainEqual(expect.stringMatching(passRequest(pass, workspaceId)));
      // A changed automation makes the executor check its subscriptions,
      // and it reads the host record again.
      await writeFile(join(temp.rootPath, "Tasks/automations.yaml"), automations("Add a to-do"));
      await expect.poll(() => server?.held.some((request) => request.line?.startsWith(hostRead) && request.closedAtMs === null), {
        timeout: 60_000,
        message: "The automation host read waits on the server that never answers",
      }).toBe(true);
      const read = server.held.find((request) => request.line?.startsWith(hostRead) && request.closedAtMs === null)!;
      const readLine = read.line!;

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
      console.log(`#2868 e2e ${pass}: ${exitedAtMs !== null ? `quit took ${quitMs} ms` : `app still running after ${quitMs} ms`}; ${quitLine}`);
      expect(exitedAtMs, `The app exits during an unanswered ${pass}`).not.toBeNull();
      expect(read.closedAtMs, "The app stops the automation host read before it exits").not.toBeNull();
      expect(read.closedAtMs!).toBeLessThan(exitedAtMs!);
      expect(quitLine, "Quit finishes within its budget").not.toContain("ran past its");
      expect(quitLine, "Closing the workspace waits for no relay read").not.toContain("closeWorkspaces");
      // Within the 6 s budget only: the engine's own exit wait is fixed separately.
      expect(quitMs, `Quit during an unanswered ${pass}`).toBeLessThan(6_000);

      // The next start, with the server answering, reads the host record
      // again and sends what the quit left owed.
      server.pass();
      const seenBefore = server.seen.length;
      desktop = await launchDesktopApp({ workspace: temp, env: { DOHC_TEST_SYNC_DEBOUNCE_MS: "150" } });
      await openWorkspaceFromFirstRun(desktop.page, temp);
      await expect.poll(() => server?.seen.slice(seenBefore) ?? [], {
        timeout: 60_000,
        message: "The automation host read reaches the relay again at the same generation",
      }).toContain(readLine);
      await expect.poll(() => server?.seen.slice(seenBefore) ?? [], {
        timeout: 60_000,
        message: `The unanswered ${pass} reaches the relay again`,
      }).toContainEqual(expect.stringMatching(passRequest(pass, workspaceId)));
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
