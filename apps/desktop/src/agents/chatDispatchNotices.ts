import { randomUUID } from "node:crypto";
import type { ChatDispatchNotice, ChatDispatchNoticesEvent } from "../ipc/bridgeContract";

// One notice per reason, except a pause: each paused chat keeps its own.
function noticeKey(reason: ChatDispatchNotice["reason"], threadId?: string): string {
  return reason === "budget-paused" ? `${reason}:${threadId ?? ""}` : reason;
}

export function createChatDispatchNotices(
  publish: (event: ChatDispatchNoticesEvent) => void,
) {
  const workspaces = new Map<string, Map<string, ChatDispatchNotice>>();
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
      const notices = workspaces.get(workspaceId) ?? new Map<string, ChatDispatchNotice>();
      notices.set(noticeKey(notice.reason, notice.threadId), { ...notice, id: randomUUID() });
      workspaces.set(workspaceId, notices);
      revision += 1;
      publish(snapshot(workspaceId));
    },
    // Takes back a notice whose cause ended, such as Restricted Mode once
    // the workspace is trusted, or one chat's pause once it resumes.
    clear(workspaceId: string, reason: ChatDispatchNotice["reason"], threadId?: string) {
      const notices = workspaces.get(workspaceId);
      if (!notices?.delete(noticeKey(reason, threadId))) return;
      if (notices.size === 0) workspaces.delete(workspaceId);
      revision += 1;
      publish(snapshot(workspaceId));
    },
    dismiss(workspaceId: string, id: string) {
      const notices = workspaces.get(workspaceId);
      if (!notices) return;
      for (const [key, notice] of notices) {
        if (notice.id !== id) continue;
        notices.delete(key);
        if (notices.size === 0) workspaces.delete(workspaceId);
        revision += 1;
        publish(snapshot(workspaceId));
        return;
      }
    },
  };
}
