import type { VersionedLiveAdapter } from "@dohc/workspace-engine-client";
import type { EngineWorkspace } from "@dohc/workspace-engine-client/daemon";
import type { ShareAccess } from "@dohc/security-contract/share-selector";
import {
  ListAutomationFailuresPayload, ListAutomationFailuresResult, DismissAutomationFailurePayload, type AutomationFailureNotice,
  ChatRunRecordsForThreadPayload, ChatRunRecordsForThreadResult, AgentRunPayload,
  EndAgentRunPayload, StartAgentRunResult, AgentRunStatusResult, McpConfigResult,
  AgentPanelSnapshotResult, AgentPermissionResponsePayload, StopAgentRunPayload,
  ChatDispatchStateForThreadPayload, ChatDispatchStateForThreadResult,
  ResumeThreadDispatchPayload, RunnerSelfTestPayload, RunnerSelfTestResult,
} from "./bridgeContract";
import { CHANNELS } from "./channels";
import { AgentToolsResult } from "../agents/agentToolCatalog";
import { automationFailureAckKey, unacknowledgedAutomationFailures } from "../workspaces/registryStore";
import type { RegistryEntry } from "../workspaces/registryStore";
import type { createReceivedShareEngineAccess } from "../workspaces/receivedShareEngineAccess";
import type { DesktopLinkedChatStore } from "../workspaces/liveLinkedChatStore";
import type { AgentIntegration, AgentRunRecord } from "../agents/AgentIntegration";
import type { AgentSessionManager } from "../agents/AgentSessionManager";
import type { ChatDispatchService } from "../agents/chatDispatchService";
import type { LiveAgentDispatchStoreHandle } from "../agents/liveAgentDispatchStore";

export function createAgentRunsIpc<
  Sender,
  Event extends { sender: Sender },
  Workspace extends RegistryEntry,
  Operation extends { readonly workspace: Workspace & { readonly attachmentId: symbol }; assertCurrent(): void },
>(dependencies: {
  registerHandler(channel: string, handler: (event: Event, payload: unknown) => unknown): void;
  assertTrustedSender(event: Event): void;
  withRendererWorkspaceOperation<Result>(
    sender: Sender, workspaceId: string, message: string,
    work: (operation: Operation) => Promise<Result>,
  ): Promise<Result>;
  receivedShareEngine: Pick<ReturnType<typeof createReceivedShareEngineAccess>, "workspaceForRegistered">;
  withEngineAdapter<Result>(workspace: EngineWorkspace, work: (adapter: Pick<VersionedLiveAdapter, "listAutomationFailures">) => Promise<Result>): Promise<Result | null>;
  acknowledgeWorkspaceAutomationFailure(workspaceId: string, automationId: string, generation: number): void;
  /** Dataset automations' failures, from the dataset host's ledger while it is open. */
  datasetAutomationFailures(workspaceId: string): Promise<Array<Omit<AutomationFailureNotice, "name">>>;
  notifyAutomationFailuresChanged(workspaceId: string): void;
  /** A Collection automation's name in its automations.yaml, or null. */
  automationNameOf(workspaceId: string, automationId: string): string | null;
  requireEngineCapture(workspaceId: string, feature: "Chats"): Promise<{ workspace: Workspace }>;
  linkedChatStoreFor(workspace: Workspace): Pick<DesktopLinkedChatStore, "ensureOpen">;
  agentDispatchStoreHandleFor(workspace: Workspace): { store: Pick<LiveAgentDispatchStoreHandle["store"], "runRecordsForThread"> };
  requireWorkspace(workspaceId: string): Workspace;
  assertAgentRunnableWorkspace(workspaceId: string): void;
  assertChatRunnerIdle(workspaceId: string): void;
  startAgentRunWithWorkspaceActivity(workspace: Workspace): Promise<AgentRunRecord>;
  readonly cachedAgentSessions: Pick<AgentSessionManager, "panelSnapshot" | "stopSession"> | null;
  agentIntegration: Pick<AgentIntegration, "endAgentRun" | "getAgentRunStatus">;
  mcpShareAccessOf(shareView: unknown): ShareAccess | null;
  mcpConfigFor(rootPath: string, shareAccess: ShareAccess | null): McpConfigResult;
  sharedViewOf(workspaceId: string): unknown;
  pluginWorkspaceRuntimes: { ensure(workspace: Workspace): Promise<unknown> };
  agentSessionManager(): Promise<Pick<AgentSessionManager, "probeDrivers" | "panelSnapshot" | "answerPermission">>;
  senderWorkspaceAuthority: {
    withActiveWorkspace<Result>(sender: Sender, workspaceId: string, subject: string, work: () => Promise<Result>): Promise<Result>;
  };
  chatDispatchService: Pick<ChatDispatchService, "stopAgentRun" | "dispatchStateForThread" | "resumeThreadDispatch" | "runnerSelfTest">;
  assertWritableWorkspace(workspace: Workspace): void;
  openWorkspaceActivity(workspace: Workspace): Promise<unknown>;
  detectAgentTools(workspaceRoot: string): Promise<AgentToolsResult["tools"]>;
}) {
  const {
    registerHandler, assertTrustedSender, withRendererWorkspaceOperation, receivedShareEngine,
    withEngineAdapter, acknowledgeWorkspaceAutomationFailure, datasetAutomationFailures, notifyAutomationFailuresChanged,
    requireEngineCapture, linkedChatStoreFor, agentDispatchStoreHandleFor, requireWorkspace,
    assertAgentRunnableWorkspace, assertChatRunnerIdle, startAgentRunWithWorkspaceActivity,
    agentIntegration, mcpShareAccessOf, mcpConfigFor, sharedViewOf, pluginWorkspaceRuntimes,
    agentSessionManager, senderWorkspaceAuthority, chatDispatchService, assertWritableWorkspace,
    openWorkspaceActivity,
  } = dependencies;

  function registerAutomationFailures(): void {
    // Automation failures (ADR 0008): the engine's failed claim rows and the
    // dataset ledger's — one row per automation with the newest error and a
    // counting generation — minus what the owner has acknowledged in the
    // registry.
    const failuresOf = async (operation: Operation): Promise<Array<Omit<AutomationFailureNotice, "name">> | null> => {
      const engine = await withEngineAdapter(
        receivedShareEngine.workspaceForRegistered(operation.workspace),
        async (adapter) => await adapter.listAutomationFailures(),
      );
      if (engine === null) return null;
      return [
        ...engine.failures.map((failure) => ({ ...failure, datasetInstance: null })),
        ...await datasetAutomationFailures(operation.workspace.workspaceId),
      ];
    };
    registerHandler(CHANNELS.listAutomationFailures, async (event, payload) => {
      assertTrustedSender(event);
      const input = ListAutomationFailuresPayload.parse(payload);
      return withRendererWorkspaceOperation(
        event.sender,
        input.workspaceId,
        "Automation notice read stopped because this window changed workspaces.",
        async (operation) => {
          const failures = await failuresOf(operation);
          return ListAutomationFailuresResult.parse({
            failures: unacknowledgedAutomationFailures(
              failures ?? [],
              operation.workspace.automationFailureAcks,
            ).map((failure) => ({
              ...failure,
              name: dependencies.automationNameOf(input.workspaceId, failure.automationId),
            })),
          });
        },
      );
    });

    // Record that the user has seen an automation's failures. It does not
    // delete the claim rows — they are the remaining evidence of what failed.
    // Acknowledging hides the notice; a failure recorded after the render has
    // a higher generation, so it comes back on its own. The generation is
    // clamped to what the engine actually holds, so a claimed generation
    // above the current one cannot pre-acknowledge failures yet to happen.
    registerHandler(CHANNELS.dismissAutomationFailure, async (event, payload) => {
      assertTrustedSender(event);
      const input = DismissAutomationFailurePayload.parse(payload);
      return withRendererWorkspaceOperation(
        event.sender,
        input.workspaceId,
        "Automation notice update stopped because this window changed workspaces.",
        async (operation) => {
          const failures = await failuresOf(operation);
          if (!failures) {
            throw new Error("The workspace engine is not running.");
          }
          const current = failures.find(
            (failure) => failure.automationId === input.automationId,
          );
          // No failed claims for that automation, or a notice about a
          // dataset instance that is gone: nothing to acknowledge.
          if (!current || current.datasetInstance !== input.datasetInstance) return;
          operation.assertCurrent();
          acknowledgeWorkspaceAutomationFailure(
            input.workspaceId,
            automationFailureAckKey(current),
            Math.min(input.generation, current.generation),
          );
          notifyAutomationFailuresChanged(input.workspaceId);
        },
      );
    });
  }

  function registerChatRunRecords(): void {
    registerHandler(CHANNELS.chatRunRecordsForThread, async (event, payload) => {
      assertTrustedSender(event);
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
    });
  }

  function registerAgentRuns(): void {
    registerHandler(CHANNELS.detectAgentTools, async (event, payload) => {
      assertTrustedSender(event);
      const input = AgentRunPayload.parse(payload);
      return withRendererWorkspaceOperation(event.sender, input.workspaceId,
        "Agent detection stopped because this window changed workspaces.",
        async (operation) => AgentToolsResult.parse({
          workingDirectory: operation.workspace.rootPath,
          tools: await dependencies.detectAgentTools(operation.workspace.rootPath),
        }));
    });
    // Enabling agents starts a local run: the workspace must already be open (the
    // watcher must be live for the run slot to attach), so open it first.
    registerHandler(CHANNELS.startAgentRun, async (event, payload) => {
      assertTrustedSender(event);
      const input = AgentRunPayload.parse(payload);
      const workspace = requireWorkspace(input.workspaceId);
      assertAgentRunnableWorkspace(workspace.workspaceId);
      assertChatRunnerIdle(workspace.workspaceId);
      return StartAgentRunResult.parse(
        await startAgentRunWithWorkspaceActivity(workspace),
      );
    });

    registerHandler(CHANNELS.endAgentRun, async (event, payload) => {
      assertTrustedSender(event);
      const input = EndAgentRunPayload.parse(payload);
      requireWorkspace(input.workspaceId);
      // A driver-backed run owns a live session (a child process). Ending such
      // a run must go through the session manager so the child is actually
      // stopped and disposed — not just the run record closed (this stop used
      // to live on the retired Agent panel; Settings' stop lands here now).
      // stopSession finalizes the run through agentIntegration.endAgentRun
      // exactly once, so onRunEnded fires as before. No cached manager means
      // no session ever started — plain run-record end.
      const session = dependencies.cachedAgentSessions?.panelSnapshot(input.workspaceId).session;
      if (
        dependencies.cachedAgentSessions &&
        session?.runId === input.runId &&
        ["starting", "ready", "running", "waiting-permission"].includes(session.status)
      ) {
        // Keep the caller's explicit outcome (e.g. "failed") on the record.
        await dependencies.cachedAgentSessions.stopSession(input.workspaceId, input.status);
        return;
      }
      await agentIntegration.endAgentRun(input.workspaceId, input.runId, input.status ?? "complete");
    });

    registerHandler(CHANNELS.getAgentRunStatus, async (event, payload) => {
      assertTrustedSender(event);
      const input = AgentRunPayload.parse(payload);
      requireWorkspace(input.workspaceId);
      return AgentRunStatusResult.parse(await agentIntegration.getAgentRunStatus(input.workspaceId));
    });

    // The copyable MCP config snippet for the user's AI tool. Main owns the real
    // command/args so the renderer never invents a launch path.
    registerHandler(CHANNELS.getMcpConfig, (event, payload) => {
      assertTrustedSender(event);
      const input = AgentRunPayload.parse(payload);
      const workspace = requireWorkspace(input.workspaceId);
      // A shared view hands out the MCP profile for its level, so the user's AI
      // tool is offered only the write tools the grant allows.
      const shareAccess = mcpShareAccessOf(workspace.shareView);
      return McpConfigResult.parse(mcpConfigFor(workspace.rootPath, shareAccess));
    });

    registerHandler(CHANNELS.probeAgentDrivers, async (event, payload) => {
      assertTrustedSender(event);
      const input = AgentRunPayload.parse(payload);
      const workspace = requireWorkspace(input.workspaceId);
      // Every driver is plugin-contributed, and workspace open only warms the
      // plugin runtime in the background. A probe that ran ahead of it would
      // answer "no drivers" and the caller would cache that for its lifetime.
      if (!sharedViewOf(workspace.workspaceId)) {
        await pluginWorkspaceRuntimes.ensure(workspace);
      }
      const sessions = await agentSessionManager();
      await sessions.probeDrivers(input.workspaceId);
      return AgentPanelSnapshotResult.parse(sessions.panelSnapshot(input.workspaceId));
    });

    registerHandler(CHANNELS.getAgentSessionState, async (event, payload) => {
      assertTrustedSender(event);
      const input = AgentRunPayload.parse(payload);
      requireWorkspace(input.workspaceId);
      const sessions = await agentSessionManager();
      return AgentPanelSnapshotResult.parse(sessions.panelSnapshot(input.workspaceId));
    });

    registerHandler(CHANNELS.answerAgentPermission, async (event, payload) => {
      assertTrustedSender(event);
      const input = AgentPermissionResponsePayload.parse(payload);
      requireWorkspace(input.workspaceId);
      const sessions = await agentSessionManager();
      return AgentPanelSnapshotResult.parse(await sessions.answerPermission(input));
    });

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

    registerHandler(CHANNELS.chatDispatchStateForThread, async (event, payload) => {
      assertTrustedSender(event);
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
    });

    registerHandler(CHANNELS.resumeThreadDispatch, async (event, payload) => {
      assertTrustedSender(event);
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
    });

    registerHandler(CHANNELS.runnerSelfTest, async (event, payload) => {
      assertTrustedSender(event);
      const input = RunnerSelfTestPayload.parse(payload);
      const workspace = requireWorkspace(input.workspaceId);
      assertAgentRunnableWorkspace(workspace.workspaceId);
      await openWorkspaceActivity(workspace);
      return RunnerSelfTestResult.parse(
        await chatDispatchService.runnerSelfTest(input.workspaceId),
      );
    });
  }

  return { registerAutomationFailures, registerChatRunRecords, registerAgentRuns };
}
