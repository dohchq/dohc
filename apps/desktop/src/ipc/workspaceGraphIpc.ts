import { CHANNELS } from "./channels";
import {
  GetBacklinksPayload,
  GetBacklinksResult,
  ListWorkspaceHeadingsPayload,
  ListWorkspaceHeadingsResult,
  ReadWorkspaceGraphPayload,
  WorkspaceGraphResult,
  type ListWorkspaceFilesResult,
  type ReadWorkspaceTextResult,
} from "./bridgeContract";
import type { RegistryEntry } from "../workspaces/registryStore";
import type { EngineWorkspace } from "@dohc/workspace-engine-client/daemon";
import type { DesktopLinkedChatStore } from "../workspaces/liveLinkedChatStore";
import type { WorkspaceGraphIndex } from "../workspaces/workspaceGraph";
import type { WorkspaceFileListingCache } from "../workspaces/workspaceFileListingCache";
import { workspaceHasReceivedShareState } from "../workspaces/shareViewFilesTarget";
import { addChatMentionsToWorkspaceGraph } from "../workspaces/chatMentionGraphOverlay";
import {
  extractWorkspaceHeadings,
  workspaceHeadingRecords,
} from "../workspaces/workspaceHeadings";

export function registerWorkspaceGraphIpcHandlers<
  Sender,
  Event extends { sender: Sender },
  Workspace extends RegistryEntry & { attachmentId: symbol },
  Operation extends {
    workspace: Workspace;
    state: {
      workspaceGraph: Pick<WorkspaceGraphIndex, "readGraph" | "readBacklinks">;
    };
  },
>(dependencies: {
  registerHandler(
    channel: string,
    handler: (event: Event, payload: unknown) => unknown,
  ): void;
  assertTrustedSender(event: Event): void;
  withRendererWorkspaceOperation<Result>(
    sender: Sender,
    workspaceId: string,
    inactiveMessage: string,
    work: (operation: Operation) => Result | Promise<Result>,
  ): Promise<Result>;
  workspaceFileListings: Pick<WorkspaceFileListingCache, "list">;
  listOwnedWorkspaceFilesFor(workspace: Workspace): Promise<ListWorkspaceFilesResult>;
  readOwnedWorkspaceTextFor(
    workspace: Workspace,
    path: string,
  ): Promise<ReadWorkspaceTextResult>;
  requireEngineCapture(
    workspaceId: string,
    feature: "Chat mentions",
  ): Promise<{ workspace: EngineWorkspace }>;
  syncWorkspaceSharedChannels(workspaceId: string): Promise<number>;
  linkedChatStoreFor(workspace: EngineWorkspace): Pick<
    DesktopLinkedChatStore,
    "listThreads" | "listChannels" | "getChannelWireId" | "listThreadAttachments"
  >;
  activeEngineFileIndex(workspace: EngineWorkspace): Promise<{
    pathByObjectId: Map<string, string>;
    objectIdByPath: Map<string, string>;
  }>;
}): void {
  const {
    registerHandler,
    assertTrustedSender,
    withRendererWorkspaceOperation,
    workspaceFileListings,
    listOwnedWorkspaceFilesFor,
    readOwnedWorkspaceTextFor,
    requireEngineCapture,
    syncWorkspaceSharedChannels,
    linkedChatStoreFor,
    activeEngineFileIndex,
  } = dependencies;
  function ownedWorkspaceGraphSource(workspace: Workspace) {
    const hasShareState = workspaceHasReceivedShareState(workspace);
    return {
      // Ordinary workspaces share the Explorer's complete listing. Received
      // shares still list per request so authority changes are intersected before
      // resolution; their parsed bodies remain reusable by content identity.
      list: () =>
        hasShareState
          ? listOwnedWorkspaceFilesFor(workspace)
          : workspaceFileListings.list({
              workspaceId: workspace.workspaceId,
              attachmentId: workspace.attachmentId,
              allowCached: true,
              load: () => listOwnedWorkspaceFilesFor(workspace),
            }),
      ...(hasShareState
        ? {
            readText: (path: string) => readOwnedWorkspaceTextFor(workspace, path),
          }
        : {}),
    };
  }

  registerHandler(CHANNELS.readWorkspaceGraph, async (event, payload) => {
    assertTrustedSender(event);
    const input = ReadWorkspaceGraphPayload.parse(payload);
    return withRendererWorkspaceOperation(
      event.sender,
      input.workspaceId,
      "Workspace graph read stopped because this window changed workspaces.",
      async (operation) => {
        const workspace = operation.workspace;
        const graph = await operation.state.workspaceGraph.readGraph(
          workspace.rootPath,
          ownedWorkspaceGraphSource(workspace),
        );
        if (!input.includeChatMentions) return WorkspaceGraphResult.parse(graph);
        const { workspace: engineWorkspace } = await requireEngineCapture(
          workspace.workspaceId,
          "Chat mentions",
        );
        const rowsUncovered = await syncWorkspaceSharedChannels(
          engineWorkspace.workspaceId,
        );
        const store = linkedChatStoreFor(engineWorkspace);
        const threads = await store.listThreads({ workspaceId: engineWorkspace.workspaceId });
        const graphChannelRows = await store.listChannels({
          workspaceId: engineWorkspace.workspaceId,
        });
        const graphChannels = new Map(
          graphChannelRows.map(
            (channel) => [channel.id, channel] as const,
          ),
        );
        const graphChannelWireIds = new Map(
          await Promise.all(
            graphChannelRows.map(async (channel) => [
              channel.id,
              await store.getChannelWireId({
                workspaceId: engineWorkspace.workspaceId,
                channelId: channel.id,
              }),
            ] as const),
          ),
        );
        const activeFiles = await activeEngineFileIndex(engineWorkspace);
        const authorizedMentions = (
          await Promise.all(
            threads.map(async (thread) => {
              const attachments = await store.listThreadAttachments(
                engineWorkspace.workspaceId,
                thread.id,
              );
              return attachments.flatMap((attachment) => {
                // Stable object identity owns path resolution. A hint is usable
                // only for legacy/opaque rows where no object identity exists; an
                // object that disappeared from the active version fails closed.
                const filePath = attachment.objectId
                  ? activeFiles.pathByObjectId.get(attachment.objectId)
                  : attachment.pathHint;
                const fileObjectId =
                  attachment.objectId ??
                  (filePath ? activeFiles.objectIdByPath.get(filePath) : undefined);
                return filePath && fileObjectId
                  ? [{
                        threadId: thread.id,
                        threadTitle: thread.title,
                        messageId: attachment.messageId,
                        fileObjectId,
                        filePath,
                        ...(thread.channelId && graphChannels.get(thread.channelId)
                          ? {
                              channel: {
                                id: graphChannels.get(thread.channelId)!.id,
                                ...(graphChannelWireIds.get(thread.channelId)
                                  ? { wireId: graphChannelWireIds.get(thread.channelId)! }
                                  : {}),
                                name: graphChannels.get(thread.channelId)!.name,
                                slug: graphChannels.get(thread.channelId)!.slug,
                                kind: graphChannels.get(thread.channelId)!.kind,
                              },
                            }
                          : {}),
                        ...(attachment.headingAnchor && attachment.headingText
                          ? {
                              heading: {
                                anchor: attachment.headingAnchor,
                                text: attachment.headingText,
                                occurrence: attachment.headingOccurrence ?? 0,
                              },
                            }
                          : {}),
                      }]
                  : [];
              });
            }),
          )
        ).flat();
        const overlaid = addChatMentionsToWorkspaceGraph(
          graph,
          authorizedMentions,
          true,
          activeFiles.objectIdByPath,
        );
        const filePathsById = new Map(
          overlaid.nodes
            .filter((node) => node.kind === "file")
            .map((node) => [node.id, node.path] as const),
        );
        return WorkspaceGraphResult.parse({
          ...(rowsUncovered > 0 ? { sharedChannelRowsUncovered: rowsUncovered } : {}),
          ...overlaid,
          nodes: overlaid.nodes.map((node) =>
            node.kind === "file"
              ? {
                  path: node.path,
                  kind: "file" as const,
                  filePath: node.path,
                  title: node.title,
                  incoming: node.incoming,
                  outgoing: node.outgoing,
                }
              : node.kind === "chat-thread"
                ? {
                    path: node.id,
                    kind: "chat-thread" as const,
                    threadId: node.threadId,
                    ...(node.channel
                      ? {
                          channelId: node.channel.id,
                          ...(node.channel.wireId
                            ? { channelWireId: node.channel.wireId }
                            : {}),
                          channelName: node.channel.name,
                          channelSlug: node.channel.slug,
                          channelKind: node.channel.kind,
                        }
                      : {}),
                    title: node.title.slice(0, 120),
                    incoming: node.incoming,
                    outgoing: node.outgoing,
                  }
                : {
                    path: node.id,
                    kind: "heading" as const,
                    filePath: node.filePath,
                    headingAnchor: node.anchor,
                    title: `#${node.title.slice(0, 119)}`,
                    incoming: node.incoming,
                    outgoing: node.outgoing,
                  },
          ),
          edges: overlaid.edges.map((edge) => ({
            source: filePathsById.get(edge.source) ?? edge.source,
            target: filePathsById.get(edge.target) ?? edge.target,
            kind: edge.kind,
          })),
        });
      },
    );
  });

  registerHandler(CHANNELS.getBacklinks, async (event, payload) => {
    assertTrustedSender(event);
    const input = GetBacklinksPayload.parse(payload);
    return withRendererWorkspaceOperation(
      event.sender,
      input.workspaceId,
      "Backlink read stopped because this window changed workspaces.",
      async (operation) =>
        GetBacklinksResult.parse({
          sources: await operation.state.workspaceGraph.readBacklinks(
            operation.workspace.rootPath,
            input.path,
            ownedWorkspaceGraphSource(operation.workspace),
          ),
        }),
    );
  });

  registerHandler(CHANNELS.listWorkspaceHeadings, async (event, payload) => {
    assertTrustedSender(event);
    const input = ListWorkspaceHeadingsPayload.parse(payload);
    return withRendererWorkspaceOperation(
      event.sender,
      input.workspaceId,
      "Heading read stopped because this window changed workspaces.",
      async (operation) => {
        const source = await readOwnedWorkspaceTextFor(
          operation.workspace,
          input.path,
        );
        return ListWorkspaceHeadingsResult.parse({
          headings: workspaceHeadingRecords(extractWorkspaceHeadings(source.text)),
        });
      },
    );
  });
}
