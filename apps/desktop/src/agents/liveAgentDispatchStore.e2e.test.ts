import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ChatsLiveAdapter } from "@dohc/workspace-engine-client";
import { describe, expect, it } from "vitest";
import {
  EngineDaemonLifecycle,
} from "../workspaces/engineDaemonLifecycle";
import { EngineWorkspaceSessions } from "../workspaces/engineWorkspaceSessions";
import { nativeTmpdir } from "../workspaces/testTemp";
import { createLiveAgentDispatchStore } from "./liveAgentDispatchStore";

const REAL_ENGINE_BINARY =
  process.env.DOHC_TEST_ENGINE_BINARY ??
  "C:/w/_targets/rpcs1/debug/dohc-workspace-engine.exe";
const hasRealEngine = existsSync(REAL_ENGINE_BINARY);

describe("live agent dispatch store real daemon", () => {
  it.skipIf(!hasRealEngine)(
    "real_daemon_dispatch_flow_claims_completes_and_requeues",
    async () => {
      const root = await mkdtemp(
        join(nativeTmpdir(), "dohc-live-dispatch-e2e-"),
      );
      const workspaceId = `workspace-live-e2e-${process.pid}`;
      const markerDirectory = join(root, ".dohc", "engine");
      await mkdir(markerDirectory, { recursive: true });
      await writeFile(
        join(markerDirectory, "SHADOW_CLONE"),
        randomBytes(32).toString("hex"),
        { encoding: "utf8", flag: "wx", mode: 0o600 },
      );

      const lifecycle = new EngineDaemonLifecycle({
        command: REAL_ENGINE_BINARY,
      });
      let sessions: EngineWorkspaceSessions | null = null;
      try {
        await lifecycle.start();
        sessions = new EngineWorkspaceSessions(lifecycle);
        let nextChatId = 0;
        const { agentChannel, started, secondTrigger } = await sessions.run(
          { workspaceId, rootPath: root },
          async ({ client, workspace }) => {
            const chat = new ChatsLiveAdapter(client, workspace, {
              workspaceId,
              createId: (kind) => `${kind}-e2e-${(nextChatId += 1)}`,
            });
            const agentChannel = await chat.ensureAgentChannel({ workspaceId });
            const started = await chat.startChannelThread({
              workspaceId,
              channelId: agentChannel.channelId,
              title: "Real daemon dispatch",
              author: { kind: "human", displayName: "Ice" },
              body: "Run the real daemon dispatch flow.",
            });
            const secondTrigger = await chat.sendMessage({
              workspaceId,
              threadId: started.thread.id,
              author: { kind: "human", displayName: "Ice" },
              body: "Exercise failed-run requeue.",
            });
            return { agentChannel, started, secondTrigger };
          },
        );
        expect(agentChannel.channelId).toBeTruthy();
        const runIds = ["run-e2e-complete", "run-e2e-failed"];
        const handle = createLiveAgentDispatchStore(
          { workspaceId, rootPath: root },
          sessions,
          { createRunId: () => runIds.shift() ?? "run-e2e-extra" },
        );
        const { store } = handle;

        await expect(
          store.recordTrigger({
            workspaceId,
            triggerMessageId: started.message.id,
            threadId: started.thread.id,
          }),
        ).resolves.toBe(true);
        const completeClaim = await store.claimNextPending(workspaceId, {
          command: "codex exec",
          logPath: join(root, "run-logs", "{runId}", "{runId}.log"),
        });
        expect(completeClaim?.run).toMatchObject({
          runId: "run-e2e-complete",
          logPath: join(
            root,
            "run-logs",
            "run-e2e-complete",
            "run-e2e-complete.log",
          ),
        });
        await expect(
          store.getRunRecord("run-e2e-complete"),
        ).resolves.toEqual(completeClaim?.run);
        await expect(
          store.completeRun({ runId: "run-e2e-complete", exitCode: 0 }),
        ).resolves.toMatchObject({
          runId: "run-e2e-complete",
          exitCode: 0,
          failureNotePosted: false,
        });
        await expect(
          store.getRunRecord("run-e2e-complete"),
        ).resolves.toMatchObject({
          endedAtMs: expect.any(Number),
          exitCode: 0,
        });

        await expect(
          store.recordTrigger({
            workspaceId,
            triggerMessageId: secondTrigger.id,
            threadId: started.thread.id,
          }),
        ).resolves.toBe(true);
        const failedClaim = await store.claimNextPending(workspaceId, {
          command: "codex exec",
        });
        expect(failedClaim?.run.runId).toBe("run-e2e-failed");
        await expect(
          store.failRun({
            runId: "run-e2e-failed",
            exitCode: 1,
            reason: "startup-failed",
          }),
        ).resolves.toMatchObject({
          runId: "run-e2e-failed",
          exitCode: 1,
          failureReason: "startup-failed",
        });
        await expect(
          handle.requeueFailedTrigger({
            workspaceId,
            triggerMessageId: secondTrigger.id,
            runId: "run-e2e-failed",
          }),
        ).resolves.toBe(true);
        await expect(store.listPending(workspaceId)).resolves.toMatchObject([
          {
            triggerMessageId: secondTrigger.id,
            state: "pending",
            attemptCount: 1,
          },
        ]);
      } finally {
        await sessions?.closeAll();
        await lifecycle.stop();
        await rm(root, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
