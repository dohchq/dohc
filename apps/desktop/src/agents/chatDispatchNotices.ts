import { randomUUID } from "node:crypto";
import type { ChatDispatchNotice, ChatDispatchNoticesEvent } from "../ipc/bridgeContract";

export function createChatDispatchNotices(
  publish: (event: ChatDispatchNoticesEvent) => void,
) {
  const workspaces = new Map<string, Map<ChatDispatchNotice["reason"], ChatDispatchNotice>>();
  let revision = 0;
  function snapshot(workspaceId: string): ChatDispatchNoticesEvent {
    return { workspaceId, revision, notices: [...(workspaces.get(workspaceId)?.values() ?? [])] };
  }
  return {
    register: snapshot,
    clearWorkspace(workspaceId: string) {
      if (!workspaces.delete(workspaceId)) return;
      revision += 1;
      publish(snapshot(workspaceId));
    },
    report(workspaceId: string, notice: Omit<ChatDispatchNotice, "id">) {
      const notices = workspaces.get(workspaceId) ?? new Map<ChatDispatchNotice["reason"], ChatDispatchNotice>();
      notices.set(notice.reason, { ...notice, id: randomUUID() });
      workspaces.set(workspaceId, notices);
      revision += 1;
      publish(snapshot(workspaceId));
    },
    dismiss(workspaceId: string, id: string) {
      const notices = workspaces.get(workspaceId);
      if (!notices) return;
      for (const [reason, notice] of notices) {
        if (notice.id !== id) continue;
        notices.delete(reason);
        if (notices.size === 0) workspaces.delete(workspaceId);
        revision += 1;
        publish(snapshot(workspaceId));
        return;
      }
    },
  };
}
