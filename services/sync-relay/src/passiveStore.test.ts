import { it, expect } from "vitest";
import { spawn } from "node:child_process";
import { Duplex } from "node:stream";
import { createServer } from "node:http";
import { once } from "node:events";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  renameSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";
import {
  EngineClient,
  DuplexEngineClientConnection,
} from "@dohc/workspace-engine-client/daemon";
import { openEngineYdocProviderSession } from "../../../packages/workspace-engine-client/src/ydoc/ydocProviderSession";
import { testStorage, testHandler, closeTestStorages } from "./testing/index";
import { createServiceHostReplication } from "./serviceHostReplication";

it.skipIf(!process.env.PASSIVE_STORE_ENGINE)(
  "passive store restarts through owner history without side effects",
  async () => {
    const evidence =
      process.env.PASSIVE_STORE_EVIDENCE ??
      resolve("../../.agent-artifacts/passive-store");
    mkdirSync(evidence, { recursive: true });
    const exe = process.env.PASSIVE_STORE_ENGINE!;
    const root = mkdtempSync(join(tmpdir(), "dohc-passive-store-"));
    const storage = await testStorage();
    const ownerHandler = testHandler(storage);
    const workspaceId = "passive-store-native",
      bearer = "user:replica-owner@dohc.test";
    const httpRequests: Array<{
      method: string;
      path: string;
      at: number;
      replica: boolean;
    }> = [];
    const readHandler = createServiceHostReplication({
      storage,
      prefix: "dohc-passive-test-v1.",
      authorize(input) {
        return input.workspaceId === workspaceId &&
          input.bearer === "dohc-passive-test-v1.test" &&
          input.method === "GET"
          ? "replica-owner@dohc.test"
          : null;
      },
    });
    const server = createServer(async (incoming, outgoing) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
        const isReplica =
          incoming.headers.authorization?.includes("dohc-passive-test-v1.") ??
          false;
        httpRequests.push({
          method: incoming.method!,
          path: incoming.url!,
          at: performance.now(),
          replica: isReplica,
        });
        const request = new Request(`http://127.0.0.1${incoming.url}`, {
          method: incoming.method,
          headers: incoming.headers as Record<string, string>,
          ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
        });
        const response = await (isReplica ? readHandler : ownerHandler)(
          request,
        );
        const body = Buffer.from(await response.arrayBuffer());
        if (incoming.url?.includes("/log?") && incoming.method === "GET")
          writeFileSync(join(evidence, "last-pull.json"), body);
        outgoing.writeHead(response.status, {
          ...Object.fromEntries(response.headers),
          "content-length": body.length,
        });
        outgoing.end(body);
      } catch (error) {
        outgoing.writeHead(500);
        outgoing.end(String(error));
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw Error("missing port");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const engines: Array<{
      client: EngineClient;
      child: ReturnType<typeof spawn>;
      workspace: string;
      dir: string;
      name: string;
    }> = [];
    let id = 1_000_000;
    const rpc = async (
      engine: (typeof engines)[number],
      method: string,
      params: Record<string, unknown> = {},
    ) => {
      let response: any;
      try {
        response = await engine.client.sendRequest({
          id: id++,
          method,
          workspace: engine.workspace || undefined,
          deadlineMs: 120000,
          params: params as never,
        });
      } catch (error) {
        throw Error(
          `${engine.name} ${method}: ${String(error)} ${JSON.stringify(error)}`,
        );
      }
      if (response.error)
        throw Error(
          `${engine.name} ${method}: ${JSON.stringify(response.error)}`,
        );
      return response.result as any;
    };
    const open = async (
      name: string,
      replica = false,
      captureNone = replica,
    ) => {
      const dir = join(root, name);
      mkdirSync(dir, { recursive: true });
      const child = spawn(exe, [], {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          DOHC_ENGINE_AUTH_TOKEN: "passive-test-token",
          DOHC_ENGINE_LIVE_HOST_CONFIG: undefined,
        },
      });
      const stream = Duplex.from({
        readable: child.stdout!,
        writable: child.stdin!,
      });
      const exited = new Promise<void>((done) =>
        child.once("close", () => done()),
      );
      const client = new EngineClient(
        new DuplexEngineClientConnection(stream),
        {
          authToken: "passive-test-token",
          protocolVersion: 2,
          capabilities: ["blobs"],
        },
        () => stream.end(),
        exited,
      );
      child.stderr!.on("data", (chunk) =>
        writeFileSync(join(evidence, `${name}.stderr.log`), chunk, {
          flag: "a",
        }),
      );
      child.on("exit", (code, signal) =>
        client.notifyProcessExit(code, signal),
      );
      const engine = { client, child, dir, name, workspace: "" };
      engines.push(engine);
      writeFileSync(
        join(evidence, "processes.json"),
        JSON.stringify(
          engines.map((e) => ({
            pid: e.child.pid,
            exe,
            root: e.dir,
            name: e.name,
          })),
          null,
          2,
        ),
      );
      await client.ready();
      const opened = await rpc(engine, "workspace.open", {
        rootDir: dir,
        workspaceId,
        ...(captureNone ? { captureMode: "none" } : {}),
        ...(replica && !process.env.PASSIVE_STORE_BASELINE
          ? { storeMode: "passive" }
          : {}),
        recoverRunningDispatches: false,
        relay: {
          baseUrl,
          bearerToken: replica ? "dohc-passive-test-v1.test" : bearer,
          allowInsecureLoopbackForTests: true,
        },
      });
      engine.workspace = opened.workspace;
      if (!replica || process.env.PASSIVE_STORE_BASELINE)
        await rpc(engine, "versions.ensureMain", { workspaceId });
      return engine;
    };
    const pull = async (
      engine: (typeof engines)[number],
      materialize = true,
    ) => {
      let result: any;
      do {
        result = await rpc(engine, "sync.pull", { workspaceId });
        if (materialize && engine.name.startsWith("owner"))
          await rpc(engine, "sync.materializePendingCursor", {
            workspaceId,
            pendingCursor: result.pendingCursor,
          });
        await rpc(engine, "sync.commitCursor", {
          workspaceId,
          pendingCursor: result.pendingCursor,
        });
      } while (result.hasMore);
      return result;
    };
    const push = async (engine: (typeof engines)[number]) => {
      let r: any;
      do {
        r = await rpc(engine, "sync.push", { workspaceId });
      } while (r.hasMore);
      return r;
    };
    const report: any = {
      base: "56584a876",
      profile:
        "release opt-level=3, debug-assertions=true for loopback test transport",
      startedAt: new Date().toISOString(),
    };
    try {
      const a = await open("owner-a", false, !!process.env.PASSIVE_STORE_COST);
      await rpc(a, "sync.claim", { workspaceId });
      await rpc(a, "versions.ensureMain", { workspaceId });
      await rpc(a, "versionedText.write", {
        versionId: "main",
        path: "note.txt",
        text: "base",
        origin: "api",
        publish: true,
      });
      await push(a);
      const identity = storage.getWorkspaceIdentity(workspaceId)!;
      const ownerCost = !!process.env.PASSIVE_STORE_OWNER;
      let r = await open(
        ownerCost ? "owner-receiver" : "replica",
        !ownerCost,
        true,
      );
      await rpc(r, "sync.adoptJoinIdentity", { workspaceId, ...identity });
      if (process.env.PASSIVE_STORE_COST) {
        await pull(r);
        const lanes = [];
        for (const bodyBytes of [50_000, 1_000_000]) {
          const path = `cost-${bodyBytes}.txt`;
          await rpc(a, "versionedText.write", {
            versionId: "main",
            path,
            text: "a",
            origin: "api",
            publish: true,
          });
          await push(a);
          await pull(r);
          const session = await openEngineYdocProviderSession({
            transport: a.client,
            workspace: a.workspace,
            versionId: "main",
            path,
            contentKind: "plaintext",
            onRemoteUpdate() {},
          });
          try {
            const edit = async (text: string) => {
              let delta!: Uint8Array;
              session.doc.once("update", (value: Uint8Array) => {
                delta = value;
              });
              session.doc.getText("plainText").insert(0, text);
              await session.applyLocalUpdate(delta, { armSettle: false });
              await session.settleNow();
              await push(a);
            };
            await edit("a".repeat(bodyBytes - 1));
            await pull(r);
            const samplesMs: number[] = [];
            for (let n = 0; n < 21; n++) {
              await edit("x");
              const started = performance.now();
              await pull(r);
              if (n > 0) samplesMs.push(performance.now() - started);
            }
            const sorted = [...samplesMs].sort((a, b) => a - b);
            const db = new DatabaseSync(join(r.dir, ".dohc/engine/engine.db"), {
              readOnly: true,
            });
            try {
              const row = db
                .prepare(
                  "SELECT b.text FROM snapshots s JOIN blobs b ON b.sha256=s.blob_sha256 WHERE s.path=?",
                )
                .get(path)!;
              expect(Buffer.from(row.text as string, "utf8")).toEqual(
                readFileSync(join(a.dir, path)),
              );
              if (!ownerCost && !process.env.PASSIVE_STORE_BASELINE)
                expect(
                  db
                    .prepare("SELECT COUNT(*) AS n FROM materialization_jobs")
                    .get()!.n,
                ).toBe(0);
            } finally {
              db.close();
            }
            lanes.push({
              bodyBytes,
              samplesMs,
              medianMs: (sorted[9] + sorted[10]) / 2,
              p95Ms: sorted[18],
            });
          } finally {
            await session.close();
          }
        }
        report.cost = {
          path: ownerCost
            ? "ordinary owner pull, materialize, commit"
            : "private pull, apply/project, commit",
          lanes,
        };
        expect(
          httpRequests.filter((x) => x.replica && x.method !== "GET"),
        ).toEqual([]);
        report.verdict = "PASS";
        return;
      }
      const stored = async (path: string) =>
        await rpc(r, "versionedText.read", { versionId: "main", path });
      const inspect = () => {
        const db = new DatabaseSync(join(r.dir, ".dohc/engine/engine.db"), {
          readOnly: true,
        });
        try {
          expect(
            db.prepare("SELECT COUNT(*) AS n FROM materialization_jobs").get()!
              .n,
          ).toBe(0);
          expect(
            db
              .prepare(
                "SELECT COUNT(*) AS n FROM replication_log WHERE imported=0",
              )
              .get()!.n,
          ).toBe(0);
          expect(
            db.prepare("SELECT COUNT(*) AS n FROM automation_claims").get()!.n,
          ).toBe(0);
        } finally {
          db.close();
        }
      };
      const untouched = () => {
        expect(readdirSync(r.dir)).toEqual([".dohc"]);
        inspect();
        expect(
          httpRequests.filter((x) => x.replica && x.method !== "GET"),
        ).toEqual([]);
      };
      await pull(r);
      untouched();
      // Restart before the rest of the owner's history arrives, with a matching
      // old artifact to catch accidental startup replay rather than preimage refusal.
      await rpc(a, "versionedText.write", {
        versionId: "main",
        path: "note.txt",
        text: "restart base",
        origin: "api",
        publish: true,
      });
      await push(a);
      await pull(r);
      untouched();
      r.client.close();
      await r.client.waitForExit();
      writeFileSync(join(r.dir, "note.txt"), "base");
      r = await open("replica", true);
      expect(readFileSync(join(r.dir, "note.txt"), "utf8")).toBe("base");
      rmSync(join(r.dir, "note.txt"));
      await pull(r);
      untouched();
      const b = await open("owner-b", false, true);
      await rpc(b, "versions.ensureMain", { workspaceId });
      await rpc(b, "sync.adoptJoinIdentity", { workspaceId, ...identity });
      await pull(b);
      const edit = async (p: any, text: string) => {
        let delta!: Uint8Array;
        p.doc.once("update", (u: Uint8Array) => {
          delta = u;
        });
        p.doc.getText("plainText").insert(0, text);
        await p.applyLocalUpdate(delta, { armSettle: false });
        await p.settleNow();
      };
      const session = async (e: (typeof engines)[number]) =>
        openEngineYdocProviderSession({
          transport: e.client,
          workspace: e.workspace,
          versionId: "main",
          path: "scenario.txt",
          contentKind: "plaintext",
          onRemoteUpdate() {},
        });
      const equal = async () => {
        const value = await stored("scenario.txt");
        expect(Buffer.from(value.text, "utf8")).toEqual(
          readFileSync(join(a.dir, "scenario.txt")),
        );
        untouched();
      };
      report.scenarios = {};
      await rpc(a, "versionedText.write", {
        versionId: "main",
        path: "scenario.txt",
        text: "base",
        momentId: "scenario-base",
        origin: "api",
        publish: true,
      });
      await push(a);
      await pull(b);
      await pull(r);
      let pa = await session(a),
        pb = await session(b);
      await edit(pa, "A ");
      await edit(pb, "B ");
      await push(a);
      await push(b);
      await pull(a);
      await pull(b);
      await pull(r);
      await pa.settleNow();
      await pb.settleNow();
      await equal();
      expect(readFileSync(join(b.dir, "scenario.txt"))).toEqual(
        readFileSync(join(a.dir, "scenario.txt")),
      );
      report.scenarios.concurrentTwoDaemons = {
        converged: true,
        text: readFileSync(join(a.dir, "scenario.txt"), "utf8"),
      };
      await edit(pb, "delayed ");
      await edit(pa, "online ");
      await push(a);
      await pull(r);
      await push(b);
      await pull(a);
      await pull(b);
      await pull(r);
      await pa.settleNow();
      await pb.settleNow();
      await equal();
      report.scenarios.delayedPush = {
        converged: true,
        text: readFileSync(join(a.dir, "scenario.txt"), "utf8"),
      };
      await pa.close();
      await rpc(a, "versionedText.write", {
        versionId: "main",
        path: "scenario.txt",
        text: "changed",
        momentId: "scenario-changed",
        origin: "api",
        publish: true,
      });
      await push(a);
      await pull(b);
      await pull(r);
      await rpc(a, "versionedText.write", {
        versionId: "main",
        path: "scenario.txt",
        text: report.scenarios.delayedPush.text,
        restoreBeforeMomentId: "scenario-changed",
        momentId: "scenario-restore",
        origin: "restore",
        publish: true,
      });
      await push(a);
      await pull(b);
      await pull(r);
      await pb.nativeOwner?.resyncIfNeeded();
      await pb.settleNow();
      await equal();
      expect(readFileSync(join(b.dir, "scenario.txt"))).toEqual(
        readFileSync(join(a.dir, "scenario.txt")),
      );
      report.scenarios.restoreWithOpenEditor = {
        converged: true,
        text: readFileSync(join(a.dir, "scenario.txt"), "utf8"),
      };
      await pb.close();
      let hold = await rpc(a, "capture.hold", {});
      renameSync(join(a.dir, "scenario.txt"), join(a.dir, "renamed.txt"));
      await rpc(a, "versionedText.rename", {
        versionId: "main",
        fromPath: "scenario.txt",
        toPath: "renamed.txt",
        origin: "api",
        captureHoldId: hold.holdId,
      });
      await rpc(a, "capture.release", { holdId: hold.holdId });
      await push(a);
      await pull(b);
      await pull(r);
      expect(Buffer.from((await stored("renamed.txt")).text, "utf8")).toEqual(
        readFileSync(join(a.dir, "renamed.txt")),
      );
      untouched();
      hold = await rpc(a, "capture.hold", {});
      rmSync(join(a.dir, "renamed.txt"));
      const deleted = await rpc(a, "versionedText.delete", {
        versionId: "main",
        path: "renamed.txt",
        origin: "api",
        captureHoldId: hold.holdId,
      });
      await rpc(a, "capture.release", { holdId: hold.holdId });
      await push(a);
      await pull(b);
      await pull(r);
      expect(await stored("renamed.txt")).toBeNull();
      untouched();
      await rpc(a, "versionedText.write", {
        versionId: "main",
        path: "renamed.txt",
        text: report.scenarios.restoreWithOpenEditor.text,
        restoreBeforeMomentId: deleted.moment.momentId,
        origin: "restore",
        publish: true,
      });
      await push(a);
      await pull(b);
      await pull(r);
      expect(Buffer.from((await stored("renamed.txt")).text, "utf8")).toEqual(
        readFileSync(join(a.dir, "renamed.txt")),
      );
      untouched();
      report.scenarios.renameDeleteRestore = {
        converged: true,
        text: readFileSync(join(a.dir, "renamed.txt"), "utf8"),
      };
      report.openConflictCounts = {};
      for (const e of [a, b, r]) {
        const conflicts = await rpc(e, "conflicts.list", { status: "open" });
        report.openConflictCounts[e.name] = conflicts.conflicts.length;
        expect(conflicts.conflicts).toHaveLength(0);
      }
      const keyPath = join(r.dir, ".dohc/engine/secret.key");
      writeFileSync(keyPath, "invalid key sentinel");
      await rpc(a, "secrets.write", {
        workspaceId,
        versionId: "main",
        path: ".env",
        text: "DISPOSABLE=passive",
        origin: "api",
        momentId: "secret-passive",
      });
      await push(a);
      await pull(r);
      untouched();
      const db = new DatabaseSync(join(r.dir, ".dohc/engine/engine.db"), {
        readOnly: true,
      });
      try {
        expect(
          db.prepare("SELECT COUNT(*) AS n FROM secret_files").get()!.n,
        ).toBeGreaterThan(0);
      } finally {
        db.close();
      }
      expect((await pull(r)).fetched).toBe(0);
      untouched();
      expect(readFileSync(keyPath, "utf8")).toBe("invalid key sentinel");
      rmSync(keyPath);
      for (const method of [
        "sync.claim",
        "sync.push",
        "sync.materializePendingCursor",
        "secrets.materialize",
      ]) {
        await expect(rpc(r, method, { workspaceId })).rejects.toThrow(
          "passive store",
        );
      }
      untouched();
      report.replicaWriteRequests = httpRequests.filter(
        (x) => x.replica && x.method !== "GET",
      );
      report.verdict = "PASS";
    } catch (error) {
      report.verdict = "FAIL";
      report.error = String(error);
      report.httpRequests = httpRequests;
      throw error;
    } finally {
      for (const engine of engines.reverse()) {
        engine.client.close();
        await engine.client.waitForExit();
      }
      server.close();
      await once(server, "close");
      await closeTestStorages();
      report.finishedAt = new Date().toISOString();
      writeFileSync(
        join(
          evidence,
          process.env.PASSIVE_STORE_COST ? "cost.json" : "scenarios.json",
        ),
        JSON.stringify(report, null, 2),
      );
      rmSync(root, { recursive: true, force: true });
    }
  },
  300000,
);
