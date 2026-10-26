import { createHash } from "node:crypto";
import { ChatFileMentionsInput, type ChatFileMentionsPage } from "@dohc/workspace-contracts/chat-file-mentions";
import { classifyEngineFilePath } from "@dohc/security-contract/engine-path-floor";
import { visibleSharePath } from "@dohc/security-contract/share-selector";
import type { ChatScope } from "../ipc/chatScope";
import type { RegistryEntry } from "./registryStore";
import { recordedShareSelector } from "./shareViewRecords";

export function createChatFileMentionsReader(deps: {
  requireChatScope(workspaceId: string): Promise<ChatScope>;
  syncWorkspaceSharedChannels(workspaceId: string): Promise<number>;
  readWorkspace(workspaceId: string): RegistryEntry | null;
  principalGeneration(): number;
}) {
  const binding = (workspace: RegistryEntry) => createHash("sha256").update(JSON.stringify([
    workspace.workspaceId, workspace.rootPath, workspace.shareView === undefined ? ["owned"] : ["share", workspace.shareView?.shareId, workspace.shareView?.grantedSelector, workspace.shareView?.ended, workspace.shareView?.receivedIdentity, workspace.shareView?.recipientUserId, workspace.shareView?.relayUrl],
    workspace.sharedChannels ?? [], workspace.remote ?? null, deps.principalGeneration(),
  ])).digest("hex");
  return async (workspaceId: string, input: ChatFileMentionsInput, assertCurrent: () => void = () => {}): Promise<ChatFileMentionsPage> => {
    const parsed = ChatFileMentionsInput.parse(input);
    let uncovered = 0;
    for (let attempt = 0; ; attempt++) {
      const scope = await deps.requireChatScope(workspaceId);
      assertCurrent();
      const workspace = scope.workspace;
      const key = binding(workspace);
      const check = () => {
        assertCurrent();
        const current = deps.readWorkspace(workspaceId);
        if (!current || binding(current) !== key) throw new Error("chat-mention-access-changed");
      };
      check();
      // Continuations retain coverage in the sealed cursor. Received views never sync owner channels.
      if (scope.kind === "workspace" && !parsed.cursor && attempt === 0) {
        uncovered = await deps.syncWorkspaceSharedChannels(workspaceId);
        assertCurrent();
        const current = deps.readWorkspace(workspaceId);
        // Sync can end a channel. Reacquire authority once before reading its new scope.
        if (current && binding(current) !== key) continue;
      }
      check();
      const read = async (): Promise<ChatFileMentionsPage> => {
        check();
        const page = await scope.store.fileMentionsPage({
          workspaceId, ...parsed, scope: key, sharedChannelRowsUncovered: uncovered,
        });
        check();
        const selector = recordedShareSelector(workspace.shareView?.grantedSelector);
        const visible = (path: string) => classifyEngineFilePath(path).kind === "tracked" &&
          (scope.kind === "workspace" || (selector !== null && visibleSharePath(selector, path) !== null));
        if (!page || (page.subject && !visible(page.subject.path))) return null;
        return {
          ...page,
          entries: page.entries.filter(row => visible(row.attachment.pathHint)).map(row => {
            if (scope.kind === "workspace") return row;
            const { channelName: _name, channelSlug: _slug, channelWireId: _wire, ...shared } = row;
            return shared;
          }),
          unchecked: page.unchecked.filter(visible),
          mountsCovered: !workspace.shareMounts?.length,
        };
      };
      return scope.kind === "share" ? scope.withAuthority(read) : read();
    }
  };
}
