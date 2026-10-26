import { normalizeRootPath } from "@dohc/workspace-core";
import { createWorkspaceHandler } from "./rendererWorkspaceHandler";
import type { ShareAccess } from "@dohc/security-contract/share-selector";
import {
  ChatRunRecordsForThreadPayload, ChatRunRecordsForThreadResult, AgentRunPayload,
  EndAgentRunPayload, StartAgentRunResult, AgentRunStatusResult, McpConfigResult,
  StopAgentRunPayload,
  ChatDispatchStateForThreadPayload, ChatDispatchStateForThreadResult,
  ResumeThreadDispatchPayload, RunnerSelfTestPayload, RunnerSelfTestResult,
} from "./bridgeContract";
import { CHANNELS } from "./channels";
import { AgentToolsResult } from "../agents/agentToolCatalog";
import type { RegistryEntry } from "../workspaces/registryStore";
import type { DesktopLinkedChatStore } from "../workspaces/liveLinkedChatStore";
import type { AgentIntegration, AgentRunRecord } from "../agents/AgentIntegration";
import type { ChatDispatchService } from "../agents/chatDispatchService";
import type { LiveAgentDispatchStoreHandle } from "../agents/liveAgentDispatchStore";

export function createAgentRunsIpc<
  Sender,
  Event extends { sender: Sender },
  Workspace extends RegistryEntry,
  Operation extends {
    readonly workspace: Workspace & { readonly attachmentId: symbol };
    readonly signal: AbortSignal;
    readonly session: { readonly signal: AbortSignal };
    assertCurrent(): void;
  },
>(dependencies: {
  registerHandler(channel: string, handler: (event: Event, payload: unknown) => unknown): void;
  assertTrustedSender(event: Event): void;
  withRendererWorkspaceOperation<Result>(
    sender: Sender, workspaceId: string, message: string,
    work: (operation: Operation) => Promise<Result>,
  ): Promise<Result>;
  requireEngineCapture(workspaceId: string, feature: "Chats"): Promise<{ workspace: Workspace }>;
  linkedChatStoreFor(workspace: Workspace): Pick<DesktopLinkedChatStore, "ensureOpen">;
  agentDispatchStoreHandleFor(workspace: Workspace): { store: Pick<LiveAgentDispatchStoreHandle["store"], "runRecordsForThread"> };
  assertAgentRunnableWorkspace(workspaceId: string): void;
  assertChatRunnerIdle(workspaceId: string): void;
  startAgentRunWithWorkspaceActivity(workspace: Workspace): Promise<AgentRunRecord>;
  agentIntegration: Pick<AgentIntegration, "endAgentRun" | "getAgentRunStatus">;
  mcpShareAccessOf(shareView: unknown): ShareAccess | null;
  mcpConfigFor(rootPath: string, shareAccess: ShareAccess | null): McpConfigResult;
  senderWorkspaceAuthority: {
    withActiveWorkspace<Result>(sender: Sender, workspaceId: string, subject: string, work: () => Promise<Result>): Promise<Result>;
  };
  chatDispatchService: Pick<ChatDispatchService, "stopAgentRun" | "dispatchStateForThread" | "resumeThreadDispatch" | "runnerSelfTest">;
  assertWritableWorkspace(workspace: Workspace): void;
  openWorkspaceActivity(workspace: Workspace): Promise<unknown>;
  detectAgentTools(workspaceRoot: string, signal: AbortSignal): Promise<AgentToolsResult["tools"]>;
}) {
  const {
    registerHandler, assertTrustedSender, withRendererWorkspaceOperation,
    requireEngineCapture, linkedChatStoreFor, agentDispatchStoreHandleFor,
    assertAgentRunnableWorkspace, assertChatRunnerIdle, startAgentRunWithWorkspaceActivity,
    agentIntegration, mcpShareAccessOf, mcpConfigFor,
    senderWorkspaceAuthority, chatDispatchService, assertWritableWorkspace,
    openWorkspaceActivity,
  } = dependencies;

  const workspaceHandler = createWorkspaceHandler({ assertTrustedSender, withRendererWorkspaceOperation });

  function registerChatRunRecords(): void {
    registerHandler(CHANNELS.chatRunRecordsForThread, workspaceHandler(async (event, payload) => {
      const input = ChatRunRecordsForThreadPayload.parse(payload);
      const { workspace } = await requireEngineCapture(
        input.workspaceId,
        "Chats",
      );
      const linkedChatStore = linkedChatStoreFor(workspace);
      await linkedChatStore.ensureOpen();
      const dispatchStore = agentDispatchStoreHandleFor(workspace).store;
      const found = await dispatchStore.runRecordsForThread(
        workspace.workspaceId,
        input.threadId,
        { limit: 200 },
      );
      const runs = Object.fromEntries(
        Object.entries(found).map(([messageId, run]) => [
          messageId,
          {
            runId: run.runId,
            threadId: run.threadId,
            triggerMessageId: run.triggerMessageId,
            command: run.command,
            startedAtMs: run.startedAtMs,
            ...(run.endedAtMs !== undefined
              ? { endedAtMs: run.endedAtMs }
              : {}),
            ...(run.exitCode !== undefined ? { exitCode: run.exitCode } : {}),
            ...(run.logPath ? { logPath: run.logPath } : {}),
          },
        ]),
      );
      return ChatRunRecordsForThreadResult.parse({ runs });
    }));
  }

  function registerAgentRuns(): void {
    registerHandler(CHANNELS.detectAgentTools, async (event, payload) => {
      assertTrustedSender(event);
      const input = AgentRunPayload.parse(payload);
      return withRendererWorkspaceOperation(event.sender, input.workspaceId,
        "Agent detection stopped because this window changed workspaces.",
        async (operation) => {
          const workingDirectory = normalizeRootPath(operation.workspace.rootPath, process.platform);
          // Leaving the workspace in this window cancels detection even while another window keeps it open.
          const signal = AbortSignal.any([operation.signal, operation.session.signal]);
          const tools = await dependencies.detectAgentTools(operation.workspace.rootPath, signal)
            .catch((error: unknown) => {
              if (operation.session.signal.aborted) operation.assertCurrent();
              throw error;
            });
          return AgentToolsResult.parse({ workingDirectory, tools });
        });
    });
    // Enabling agents starts a local run: the workspace must already be open (the
    // watcher must be live for the run slot to attach), so open it first.
    registerHandler(CHANNELS.startAgentRun, workspaceHandler(async (event, payload, operation) => {
      const input = AgentRunPayload.parse(payload);
      const workspace = operation.workspace;
      assertAgentRunnableWorkspace(workspace.workspaceId);
      assertChatRunnerIdle(workspace.workspaceId);
      return StartAgentRunResult.parse(
        await startAgentRunWithWorkspaceActivity(workspace),
      );
    }));

    registerHandler(CHANNELS.endAgentRun, workspaceHandler(async (event, payload) => {
      const input = EndAgentRunPayload.parse(payload);
      await agentIntegration.endAgentRun(input.workspaceId, input.runId, input.status ?? "complete");
    }));

    registerHandler(CHANNELS.getAgentRunStatus, workspaceHandler(async (event, payload) => {
      const input = AgentRunPayload.parse(payload);
      return AgentRunStatusResult.parse(await agentIntegration.getAgentRunStatus(input.workspaceId));
    }));

    // The copyable MCP config snippet for the user's AI tool. Main owns the real
    // command/args so the renderer never invents a launch path.
    registerHandler(CHANNELS.getMcpConfig, workspaceHandler(async (event, payload, operation) => {
      const input = AgentRunPayload.parse(payload);
      const workspace = operation.workspace;
      // A shared view hands out the MCP profile for its level, so the user's AI
      // tool is offered only the write tools the grant allows.
      const shareAccess = mcpShareAccessOf(workspace.shareView);
      return McpConfigResult.parse(mcpConfigFor(normalizeRootPath(workspace.rootPath, process.platform), shareAccess));
    }));

    registerHandler(CHANNELS.stopAgentRun, async (event, payload) => {
      assertTrustedSender(event);
      const input = StopAgentRunPayload.parse(payload);
      await senderWorkspaceAuthority.withActiveWorkspace(
        event.sender,
        input.workspaceId,
        "Agent run stop",
        async () => {
          await chatDispatchService.stopAgentRun(input.workspaceId, input.runId);
        },
      );
    });

    registerHandler(CHANNELS.chatDispatchStateForThread, workspaceHandler(async (event, payload) => {
      const input = ChatDispatchStateForThreadPayload.parse(payload);
      await requireEngineCapture(
        input.workspaceId,
        "Chats",
      );
      return ChatDispatchStateForThreadResult.parse(
        await chatDispatchService.dispatchStateForThread(
          input.workspaceId,
          input.threadId,
        ),
      );
    }));

    registerHandler(CHANNELS.resumeThreadDispatch, workspaceHandler(async (event, payload) => {
      const input = ResumeThreadDispatchPayload.parse(payload);
      const { workspace } = await requireEngineCapture(
        input.workspaceId,
        "Chats",
      );
      assertWritableWorkspace(workspace);
      await chatDispatchService.resumeThreadDispatch(
        input.workspaceId,
        input.threadId,
      );
    }));

    registerHandler(CHANNELS.runnerSelfTest, async (event, payload) => {
      assertTrustedSender(event);
      const input = RunnerSelfTestPayload.parse(payload);
      const workspace = await withRendererWorkspaceOperation(event.sender, input.workspaceId,
        "This workspace is no longer active.", async operation => {
          assertAgentRunnableWorkspace(operation.workspace.workspaceId);
          return operation.workspace;
        });
      await openWorkspaceActivity(workspace);
      return RunnerSelfTestResult.parse(
        await chatDispatchService.runnerSelfTest(workspace.workspaceId, input.agentId),
      );
    });
  }

  return { registerChatRunRecords, registerAgentRuns };
}
