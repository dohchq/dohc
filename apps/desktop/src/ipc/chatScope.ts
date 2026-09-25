import type { ChatFileReferenceInput } from "./bridgeContract";
import type {
  createWorkspaceAuthorityOwner,
  WorkspaceAuthorityLease,
} from "../workspaces/workspaceAuthorityOwner";
import type { RegistryEntry } from "../workspaces/registryStore";
import { readableShareLevel, shareViewIsPresent } from "../workspaces/shareViewMarker";
import type { ShareAccess } from "@dohc/security-contract/share-selector";
import type { WorkspaceEngineCapture } from "../workspaces/workspaceEngineCapture";
import type { EngineWorkspace } from "@dohc/workspace-engine-client/daemon";
import type { DesktopLinkedChatStore } from "../workspaces/liveLinkedChatStore";
import { extractWorkspaceHeadings, findWorkspaceHeading } from "../workspaces/workspaceHeadings";
import { resolveTrackedChatFilePath } from "../workspaces/chatFileReferenceResolution";

export type ChatScope =
  | {
      kind: "workspace";
      workspace: RegistryEntry;
      capture: WorkspaceEngineCapture;
      store: DesktopLinkedChatStore;
    }
  | {
      kind: "share";
      workspace: RegistryEntry & { attachmentId: symbol };
      engineWorkspace: EngineWorkspace;
      store: DesktopLinkedChatStore;
      withAuthority<Result>(work: () => Promise<Result>): Promise<Result>;
      // The pinned level, or null when the stored grant cannot be read.
      // The registry file is DATA, not a contract (see
      // workspaceSummaryProjection.ts), so the level is read through
      // `readableShareLevel` rather than trusted from the record's type.
      access: ShareAccess | null;
      genericChatWritable: boolean;
      // The granter ended this share. The local copy stays readable and
      // stops taking writes, exactly as an ended chat grant does.
      ended: boolean;
    };

export function createChatScopeCapability<State>(dependencies: {
  workspaceAuthorities: Pick<
    ReturnType<typeof createWorkspaceAuthorityOwner<RegistryEntry, State>>,
    "withAuthority" | "withBinding"
  >;
  canonicalWorkspaceFor(
    lease: WorkspaceAuthorityLease<RegistryEntry, State>,
  ): RegistryEntry & { attachmentId: symbol };
  requireEngineCapture(
    workspaceId: string, feature: "Chats",
  ): Promise<{ workspace: RegistryEntry; capture: WorkspaceEngineCapture }>;
  linkedChatStoreFor(lease: WorkspaceAuthorityLease<RegistryEntry, State>): DesktopLinkedChatStore;
  openWorkspaceActivity(workspace: RegistryEntry): Promise<unknown>;
  receivedShareEngine: {
    workspaceFor(input: {
      engineWorkspaceId: string; rootPath: string; attachmentId: symbol;
    }): EngineWorkspace;
  };
  activeEngineFileIndex(workspace: EngineWorkspace): Promise<{ objectIdByPath: Map<string, string> }>;
  readOwnedWorkspaceText(workspace: RegistryEntry, path: string): Promise<{ text: string }>;
}) {
  const {
    workspaceAuthorities, canonicalWorkspaceFor, requireEngineCapture, linkedChatStoreFor,
    openWorkspaceActivity, receivedShareEngine, activeEngineFileIndex, readOwnedWorkspaceText,
  } = dependencies;
  async function requireChatScope(workspaceId: string): Promise<ChatScope> {
    return await workspaceAuthorities.withAuthority(workspaceId, async (lease) => {
      const workspace = canonicalWorkspaceFor(lease);
      // PRESENCE, the same question `sharedViewOf` asks before a write. A
      // marker that lost its value is still a share view, and resolving a
      // CAPTURE for it would give someone else's workspace the local chat
      // surface — the enforcement layer failing open.
      if (!shareViewIsPresent(workspace.shareView)) {
        const local = await requireEngineCapture(workspaceId, "Chats");
        lease.assertCurrent();
        return {
          kind: "workspace",
          workspace: local.workspace,
          capture: local.capture,
          store: linkedChatStoreFor(lease),
        };
      }
      // Idempotent, and the same guarantee requireEngineCapture makes: the
      // workspace's daemon session is live before any store call reaches it.
      await openWorkspaceActivity(workspace);
      lease.assertCurrent();
      const binding = lease.binding;
      const engineWorkspace = receivedShareEngine.workspaceFor({
        engineWorkspaceId: workspace.workspaceId,
        rootPath: workspace.rootPath,
        attachmentId: binding.attachmentId,
      });
      return {
        kind: "share",
        workspace,
        engineWorkspace,
        store: linkedChatStoreFor(lease),
        withAuthority: (work) =>
          workspaceAuthorities.withBinding(binding, () => work()),
        // The level the PINNED grant names, or null when the grant cannot be
        // read completely. Read through the same function the refresh path
        // uses, so this gate and the pull cannot disagree about what a share
        // grants.
        access: readableShareLevel(workspace.shareView?.grantedSelector),
        genericChatWritable: workspace.shareView?.genericChatWritable === true,
        ended: workspace.shareView?.ended === true,
      };
    });
  }

  // The file a chat is about, resolved for either scope. A share view has no
  // capture to ask, so it asks the engine's own file index — the same index
  // the mentions path already reads, over files that arrived by replay.
  async function chatFileObjectId(scope: ChatScope, path: string): Promise<string | null> {
    if (scope.kind === "workspace") return await scope.capture.fileObjectIdForPath(path);
    const index = await scope.withAuthority(
      async () => await activeEngineFileIndex(scope.engineWorkspace),
    );
    return index.objectIdByPath.get(path) ?? null;
  }

  async function resolveChatFileReferences(
    workspace: RegistryEntry,
    // The path resolver, not a capture: a share view has no capture and its
    // files still resolve. Everything below only ever asked the
    // capture this one question.
    fileObjectIdForPath: (path: string) => Promise<string | null>,
    references: readonly ChatFileReferenceInput[] | undefined,
  ) {
    const resolved: Array<{
      objectId: Awaited<ReturnType<WorkspaceEngineCapture["fileObjectIdForPath"]>
      > & string;
      pathHint: string;
      headingText?: string;
      headingAnchor?: string;
      headingOccurrence?: number;
    }> = [];
    const seen = new Set<string>();
    for (const reference of references ?? []) {
      const key = `${reference.path}\0${reference.headingAnchor ?? ""}\0${reference.headingOccurrence ?? 0}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const trackedFile = await resolveTrackedChatFilePath(
        reference.path,
        fileObjectIdForPath,
      );
      if (!trackedFile) {
        throw new Error(`Cannot mention ${reference.path} because dohc is not tracking it yet.`);
      }
      const { objectId, path: resolvedPath } = trackedFile;
      if (!reference.headingAnchor) {
        resolved.push({ objectId, pathHint: resolvedPath });
        continue;
      }
      const source = await readOwnedWorkspaceText(workspace, resolvedPath);
      const heading = findWorkspaceHeading(extractWorkspaceHeadings(source.text), {
        anchor: reference.headingAnchor,
        occurrence: reference.headingOccurrence,
      });
      if (!heading) {
        throw new Error(
          `The heading #${reference.headingAnchor} no longer exists in ${resolvedPath}.`,
        );
      }
      resolved.push({
        objectId,
        pathHint: resolvedPath,
        headingText: heading.text,
        headingAnchor: heading.anchor,
        headingOccurrence: heading.occurrence,
      });
    }
    return resolved;
  }

  return { requireChatScope, chatFileObjectId, resolveChatFileReferences };
}
