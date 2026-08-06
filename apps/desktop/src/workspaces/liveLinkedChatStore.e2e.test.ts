import { randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EngineDaemonLifecycle,
  EngineWorkspaceSessions,
} from "@dohc/workspace-engine-client/daemon";
import { createLiveLinkedChatStore } from "./liveLinkedChatStore";
import { requireEngineBinaryOrSkip } from "../testing/engineBinary";
import { createTestScratch } from "./testTemp";

const engine = requireEngineBinaryOrSkip();

describe("live linked chat store real daemon", () => {
  it.skipIf(engine.missing)(
    "real_daemon_chat_flow_round_trips_channel_thread_message_and_read_state",
    async () => {
      const rootPath = await createTestScratch("dohc-live-chat-e2e-");
      const workspace = {
        workspaceId: `workspace-live-chat-e2e-${process.pid}`,
        rootPath,
      };
      const markerDirectory = join(rootPath, ".dohc", "engine");
      await mkdir(markerDirectory, { recursive: true });
      await writeFile(
        join(markerDirectory, "SHADOW_CLONE"),
        randomBytes(32).toString("hex"),
        { encoding: "utf8", flag: "wx", mode: 0o600 },
      );
      const lifecycle = new EngineDaemonLifecycle({
        command: engine.require(),
      });
      let sessions: EngineWorkspaceSessions | null = null;
      try {
        await lifecycle.start();
        sessions = new EngineWorkspaceSessions(lifecycle);
        const store = createLiveLinkedChatStore(workspace, sessions);
        const channel = await store.createChannel({
          workspaceId: workspace.workspaceId,
          name: "Real daemon",
          kind: "channel",
        });
        const started = await store.startChannelThread({
          workspaceId: workspace.workspaceId,
          channelId: channel.id,
          author: { kind: "human", displayName: "Ice" },
          body: "First message",
        });
        const reply = await store.sendMessage({
          workspaceId: workspace.workspaceId,
          threadId: started.thread.id,
          author: { kind: "agent", displayName: "Codex" },
          body: "Second message",
        });

        await expect(
          store.listChannels({ workspaceId: workspace.workspaceId }),
        ).resolves.toEqual([
          expect.objectContaining({ id: channel.id, name: "Real daemon" }),
        ]);
        await expect(
          store.listChannelThreads({
            workspaceId: workspace.workspaceId,
            channelId: channel.id,
          }),
        ).resolves.toEqual([
          expect.objectContaining({
            thread: expect.objectContaining({ id: started.thread.id }),
            messageCount: 2,
          }),
        ]);
        await expect(
          store.listMessages({
            workspaceId: workspace.workspaceId,
            threadId: started.thread.id,
          }),
        ).resolves.toEqual([
          expect.objectContaining({ id: started.message.id }),
          expect.objectContaining({ id: reply.id }),
        ]);
        await expect(
          store.markThreadRead({
            workspaceId: workspace.workspaceId,
            threadId: started.thread.id,
            upToSequence: 2,
          }),
        ).resolves.toMatchObject({
          lastReadSequence: 2,
          revision: 2,
        });
      } finally {
        await sessions?.closeAll();
        await lifecycle.stop();
        await rm(rootPath, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
