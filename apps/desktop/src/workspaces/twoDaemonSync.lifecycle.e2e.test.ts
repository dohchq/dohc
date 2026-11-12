

import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";

import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { type CloseStep } from "../../e2e/helpers/daemonSeed";
import { spawnSyncRelay } from "../../e2e/helpers/syncRelay";

import { REAL_DAEMON_DEADLINE_MS } from "../testing/realDaemonWorkspaceSessions";
import { WILL_QUIT_BUDGET_MS } from "../shutdownBudgets";

import { waitForPathMoments } from "./waitForPathMoments";

import { createTestScratch } from "./testTemp";
import { deferred } from "../testing/deferred";

import { createRelaySyncEngine, type CloudSyncEngine } from "./relaySyncEngine";

import { engine, compiledRelayMain, LiveDaemonCapture, pushUntilDrained, openLiveDaemonCapture, openJoinedDaemonCapture, writeAndCapture } from "./twoDaemonSync.fixture";

// The close follows the desktop quit (appLifecycle.ts and main.ts's shutdown):
// beginEngineShutdown, then the workspace's capture close, then closeRelay and
// stopEngine.
describe.skipIf(engine.missing)("Quit while a save is in progress", () => {
  // `running` names the close steps still awaited.
  function quitLikeTheDesktop(device: LiveDaemonCapture) {
    const running = new Set<string>();
    const step: CloseStep = (name, work) => {
      running.add(name);
      const done = () => { running.delete(name); };
      work.then(done, done);
      return work;
    };
    device.beginShutdown();
    const done = (async () => {
      await step("capture.settleAndCloseAllLiveSessions", device.capture.settleAndCloseAllLiveSessions()).catch(() => undefined);
      await device.close(step).catch(() => undefined);
    })();
    return { running, done };
  }

  // Resolves "closed", or names the steps still awaited at `limitMs`.
  async function closedWithin(quit: ReturnType<typeof quitLikeTheDesktop>, limitMs: number): Promise<string> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([quit.done.then(() => "closed"), new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve(`still waiting on ${[...quit.running].join(", ") || "an unlabelled step"}`), limitMs);
      })]);
    } finally { clearTimeout(timer); }
  }

  // The app exits when its quit budget ends, so accepted work has to land inside it.
  async function insideQuitBudget<T>(work: Promise<T>, quitStarted: number): Promise<T | string> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([work, new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve("past the quit budget"), Math.max(0, WILL_QUIT_BUDGET_MS - (performance.now() - quitStarted)));
      })]);
    } finally { clearTimeout(timer); }
  }

  // Quitting faster must never drop accepted work: a write the capture admitted
  // before quit holds the close until it lands.
  it("holds quit for a local write admitted before it, and keeps the write", async () => {
    const workspaceId = "two-daemon-quit-held-write";
    const root = await createTestScratch("dohc-quit-held-write-");
    const relayRoot = await createTestScratch("dohc-quit-held-write-relay-");
    const relay = await spawnSyncRelay({ dbPath: join(relayRoot, "relay", "relay.sqlite"), compiledMain: compiledRelayMain });
    const connection = { baseUrl: relay.baseUrl, token: `test:${workspaceId}` };
    const person = { kind: "human", humanId: "local-person" } as const;
    const admitted = deferred();
    const release = deferred();
    let daemon: LiveDaemonCapture | null = null;
    let quit: ReturnType<typeof quitLikeTheDesktop> | undefined;
    try {
      daemon = await openLiveDaemonCapture({ workspaceId, rootPath: root, relay: connection });
      await daemon.relay.claim();
      await daemon.chats.ensureGeneralChannel({ workspaceId });
      const written = daemon.capture.writeAuthoredFile(join(root, "kept.md"), "kept\n", person, {
        beforeWrite: async () => {
          admitted.resolve();
          await release.promise;
        },
      }).then(() => "written", (error: unknown) => error);
      await admitted.promise;
      const quitStarted = performance.now();
      quit = quitLikeTheDesktop(daemon);
      daemon = null;
      expect(await closedWithin(quit, 1_000), "Quit waits for the admitted write").toMatch(/^still waiting on /);
      release.resolve();
      expect(await insideQuitBudget(written, quitStarted), "The admitted write lands inside the quit budget").toBe("written");
      expect(await closedWithin(quit, REAL_DAEMON_DEADLINE_MS)).toBe("closed");

      daemon = await openLiveDaemonCapture({ workspaceId, rootPath: root, relay: connection });
      await waitForPathMoments(daemon.capture, "kept.md", 1);
      expect(await readFile(join(root, "kept.md"), "utf8")).toBe("kept\n");
    } finally {
      release.resolve();
      await quit?.done;
      await daemon?.close();
      await relay.stop();
    }
  }, 120_000);
});

// Local work remains available while either kind of pull waits for the server.
describe.skipIf(engine.missing)("History while a pull waits on a server that does not answer (#2709)", () => {
  it.each(["bootstrap pull", "pull after a push"] as const)(
    "writes, opens a document, and lists History while the %s waits",
    async (pass) => {
      const workspaceId = `two-daemon-held-pull-${pass.replaceAll(" ", "-")}`;
      const token = `test:${workspaceId}`;
      const rootA = await createTestScratch("dohc-held-pull-a-");
      const relayRoot = await createTestScratch("dohc-held-pull-relay-");
      const relay = await spawnSyncRelay({ dbPath: join(relayRoot, "relay", "relay.sqlite"), compiledMain: compiledRelayMain });
      const connection = { baseUrl: relay.baseUrl, token };
      const held = new Set<Socket>();
      const silent = createServer((socket) => {
        held.add(socket);
        socket.on("error", () => undefined);
      });
      const reached = once(silent, "connection") as Promise<[Socket]>;
      // The silent server takes the relay's port, so the next request waits.
      let holding: Promise<void> | undefined;
      const holdRelay = () => holding ??= (async () => {
        await relay.stop();
        silent.listen(relay.port, "127.0.0.1");
        await once(silent, "listening");
      })();
      let daemonA: LiveDaemonCapture | null = null;
      let daemonB: LiveDaemonCapture | null = null;
      let sync: CloudSyncEngine | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let pulling = false;
      const pushed: number[] = [];
      try {
        daemonA = await openLiveDaemonCapture({ workspaceId, rootPath: rootA, relay: connection });
        await daemonA.relay.claim();
        await daemonA.chats.ensureGeneralChannel({ workspaceId });
        await pushUntilDrained(daemonA.relay);
        await writeAndCapture(daemonA, rootA, "notes.md", "body\n");
        let device = daemonA, root = rootA;
        if (pass === "bootstrap pull") {
          expect((await pushUntilDrained(daemonA.relay)).pushed).toBeGreaterThan(0);
          root = await createTestScratch("dohc-held-pull-b-");
          device = daemonB = await openJoinedDaemonCapture({ workspaceId, rootPath: root, relay: connection });
          await holdRelay();
        }
        const operations = device.relay;
        sync = createRelaySyncEngine({
          rootDir: root, relay: connection, capture: device.capture, onChange: () => undefined,
          joinBootstrap: pass === "bootstrap pull",
          // The push reaches the working relay; only the pull meets the silent server.
          operations: { ...operations, push: async () => {
            const result = await operations.push();
            pushed.push(result.pushed);
            await holdRelay();
            return result;
          } },
          pullStarting: () => {
            pulling = true;
            return () => { pulling = false; };
          },
        });
        void sync.start().catch(() => undefined);
        const [socket] = await reached;
        await once(socket, "data");
        await vi.waitFor(() => expect(pulling).toBe(true), { timeout: REAL_DAEMON_DEADLINE_MS });
        if (pass === "bootstrap pull") expect(pushed).toEqual([]);
        else expect(pushed[0]).toBeGreaterThan(0);

        // The measured wait: how long History takes to list, up to 15 s.
        const started = performance.now();
        const history = device.capture.listMoments({ limit: 1 }).then(() => "listed", (error: unknown) => error);
        const outcome = await Promise.race([history, new Promise<string>((resolve) => {
          timer = setTimeout(() => resolve("still waiting"), 15_000);
        })]);
        const waited = Math.round(performance.now() - started);
        console.log(`#2709 ${pass}: History ${String(outcome)} after ${waited} ms, pull ${pulling ? "still waiting" : "ended"}`);
        expect(pulling, "The pull ended before History was checked").toBe(true);
        expect(outcome, "History waited on the pending pull").toBe("listed");
        expect(waited, "History waited on the pending pull").toBeLessThan(2_000);
        clearTimeout(timer);
        const localWork = (async () => {
          await device.capture.writeAuthoredFile(join(root, "local.txt"), "local work\n",
            { kind: "human", humanId: "local-person" });
          const session = await device.capture.openYDocSession({
            path: "local.txt", contentKind: "plaintext", onRemoteUpdate: () => undefined,
          });
          await session.close();
          expect(await readFile(join(root, "local.txt"), "utf8")).toBe("local work\n");
          expect((await device.capture.listMoments({ limit: 20 })).moments.some(moment => moment.path === "local.txt")).toBe(true);
        })().then(() => "completed", (error: unknown) => error);
        const localOutcome = await Promise.race([localWork, new Promise<string>((resolve) => {
          timer = setTimeout(() => resolve("still waiting"), 2_000);
        })]);
        expect(localOutcome, "Local work waited on the pending fetch").toBe("completed");
        expect(pulling).toBe(true);
      } finally {
        clearTimeout(timer);
        // Shutdown rejects the held pull, so the pass and the chain end.
        daemonB?.beginShutdown();
        daemonA?.beginShutdown();
        for (const socket of held) socket.destroy();
        if (silent.listening) silent.close();
        await sync?.stop();
        await Promise.allSettled([daemonB?.close(), daemonA?.close()]);
        await relay.stop();
      }
    },
    120_000,
  );
});
