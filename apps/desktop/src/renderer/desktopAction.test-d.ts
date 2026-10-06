// Compile-time contract: valid uses compile, and every `@ts-expect-error` line must be a type error.
// If a type is loosened, tsc reports the directive as unused and this file fails to typecheck.
import { useRef, useState } from "react";
import { desktopMetadata, useDesktopAction, useDesktopCommand, useDesktopLoad, type OutcomeScope } from "./desktopAction";
import type { ReadDesktop } from "./desktopOperations";

declare const workspaceOutcomes: OutcomeScope;
declare function postUndo(receipt: unknown, subject: string): void;
declare function postFailure(error: unknown, subject: string, retry: () => void): void;
type ShareLabels = { selector: string; recipient: string };

// Reduced lane executor for the data-input and cache-context type contract.
type Spoke = readonly { readonly id: string; readonly atMs: number }[];
type LaneCache = { readonly [channelId: string]: { readonly updatedAtMs: number; readonly spoke: Spoke } };
async function readLaneAgents(desktop: ReadDesktop, input: { workspaceId: string; channelIds: readonly string[] }, cached: LaneCache) {
  const updates: { [channelId: string]: { updatedAtMs: number; spoke: Spoke } } = {};
  const agents = await Promise.all(input.channelIds.map(async (channelId) => {
    const listed = await desktop.listChannelThreads({ workspaceId: input.workspaceId, channelId, lane: "chat" });
    const lane = [...listed.threads].sort((a, b) => a.createdAtMs - b.createdAtMs)[0];
    if (!lane) return [];
    const hit = cached[channelId];
    if (hit && hit.updatedAtMs === lane.updatedAtMs) return hit.spoke;
    const page = await desktop.listChatMessages({ workspaceId: input.workspaceId, threadId: lane.id });
    const spoke = page.messages.filter((m) => m.authorKind === "agent").map((m) => ({ id: m.authorUserId ?? m.authorDisplayName, atMs: m.createdAtMs }));
    updates[channelId] = { updatedAtMs: lane.updatedAtMs, spoke };
    return spoke;
  }));
  return { agents: agents.flat(), updates };
}

// Interface-typed payloads (bridgeContract.ts declares many) are Data too.
interface PagePayload { workspaceId: string; recordId: string; before?: string }
async function readPage(desktop: ReadDesktop, input: PagePayload) {
  return desktop.getCollectionRecordHistory({ workspaceId: input.workspaceId, collectionPath: "c", recordId: input.recordId });
}
export function ValidInterfaceInput(props: { payload: PagePayload }) {
  useDesktopLoad([], readPage, props.payload, { success: () => {}, failure: () => {} });
  return null;
}

export function Valid(props: { workspaceId: string; includeChatMentions: boolean; refreshKey: string; channelIds: readonly string[]; atChannels: boolean }) {
  const [, setGraph] = useState<import("../ipc/bridgeContract").WorkspaceGraphResult | null>(null);
  const [, setAgents] = useState<Spoke>([]);
  const cache = useRef<{ [channelId: string]: { updatedAtMs: number; spoke: Spoke } }>({});
  const graph = useDesktopLoad([props.workspaceId, props.includeChatMentions, props.refreshKey], "readWorkspaceGraph",
    { workspaceId: props.workspaceId, includeChatMentions: props.includeChatMentions },
    { success: setGraph, failure: () => {} });
  void graph.pending;
  // The input is the identity; the cache snapshot is context and does not re-issue the load.
  useDesktopLoad([], readLaneAgents,
    props.atChannels ? { workspaceId: props.workspaceId, channelIds: props.channelIds } : null,
    { success: (result) => { Object.assign(cache.current, result.updates); setAgents(result.agents); }, failure: () => {} },
    cache.current);
  const [readHistory, historyPending] = useDesktopAction([props.workspaceId], "getCollectionRecordHistory", { success: () => {}, failure: () => {} });
  readHistory({ workspaceId: props.workspaceId, collectionPath: "c", recordId: "r" });
  void historyPending;
  const [revoke, revoking] = useDesktopCommand<"revokeRelayShare", ShareLabels>([], "revokeRelayShare", {
    scope: workspaceOutcomes,
    success: (result, _input, labels) => postUndo(result.undo, `the share of ${labels.selector} with ${labels.recipient}`),
    failure: (error, _input, retry, labels) => postFailure(error, `the share of ${labels.selector} with ${labels.recipient}`, retry),
  });
  void revoking;
  revoke({ shareId: "A" }, { selector: "Plans", recipient: "sam@example.com" });
  return desktopMetadata().platform;
}

export function Invalid(props: { workspaceId: string }) {
  // GraphView needs its workspace payload.
  // @ts-expect-error missing workspaceId
  useDesktopLoad([props.workspaceId], "readWorkspaceGraph", { includeChatMentions: false }, { success: () => {}, failure: () => {} });
  // A mutation cannot go through the replaceable read hook.
  // @ts-expect-error revokeRelayShare is a command
  useDesktopAction([], "revokeRelayShare", { success: () => {}, failure: () => {} });
  // A read cannot go through the command hook.
  // @ts-expect-error readWorkspaceGraph is a read
  useDesktopCommand([], "readWorkspaceGraph", { scope: workspaceOutcomes, success: () => {}, failure: () => {} });
  // Owned operations are reachable only through their owner.
  // @ts-expect-error listChatReactions is owned by the reactions owner
  useDesktopAction([], "listChatReactions", { success: () => {}, failure: () => {} });
  // @ts-expect-error setChatReaction is owned by the reactions owner
  useDesktopCommand([], "setChatReaction", { scope: workspaceOutcomes, success: () => {}, failure: () => {} });
  // A data executor cannot reach owned operations or commands.
  const sneaky = async (desktop: ReadDesktop, input: { workspaceId: string; threadId: string }) => {
    // @ts-expect-error listChatReactions is not on ReadDesktop
    await desktop.listChatReactions(input);
    // @ts-expect-error revokeRelayShare is not on ReadDesktop
    await desktop.revokeRelayShare({ shareId: "A" });
    return null;
  };
  void sneaky;
  // An executor input cannot carry a callback or a live mutable collection.
  const withCallback = async (_desktop: ReadDesktop, input: { onPage: (page: string) => void }) => { input.onPage("x"); return null; };
  // @ts-expect-error function-valued input is not Data
  useDesktopLoad([], withCallback, { onPage: () => {} }, { success: () => {}, failure: () => {} });
  const withMap = async (_desktop: ReadDesktop, input: { cache: Map<string, string> }) => { input.cache.set("k", "v"); return null; };
  // @ts-expect-error a Map is not Data
  useDesktopLoad([], withMap, { cache: new Map() }, { success: () => {}, failure: () => {} });
  // An executor that reads a cache context must be given one.
  const withContext = async (_desktop: ReadDesktop, _input: { id: string }, cached: { readonly [k: string]: string }) => cached;
  // @ts-expect-error context is required when the executor declares it
  useDesktopLoad([], withContext, { id: "x" }, { success: () => {}, failure: () => {} });
  // The task is opaque: production code cannot continue from it.
  const [read] = useDesktopAction([], "getCollectionRecordHistory", { success: () => {}, failure: () => {} });
  const task = read({ workspaceId: "w", collectionPath: "c", recordId: "r" });
  // @ts-expect-error DesktopTask has no done
  void task.done;
  // @ts-expect-error DesktopTask is not a promise
  void task.then;
  return null;
}
