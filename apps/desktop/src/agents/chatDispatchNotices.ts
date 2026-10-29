import { randomUUID } from "node:crypto";
import { CHAT_DISPATCH_NOTICES_MAX, type ChatDispatchNotice, type ChatDispatchNoticesEvent } from "../ipc/bridgeContract";

// One notice per reason, except a pause: each paused chat keeps its own.
function noticeKey(reason: ChatDispatchNotice["reason"], threadId?: string): string {
  return reason === "budget-paused" ? `${reason}:${threadId ?? ""}` : reason;
}
// The pauses fit beside the other two reasons. Past that, the oldest pause
// gives way; its chat still shows Resume.
const PAUSE_NOTICES_MAX = CHAT_DISPATCH_NOTICES_MAX - 2;

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
      const key = noticeKey(notice.reason, notice.threadId);
      if (notice.reason === "budget-paused" && !notices.has(key)) {
        const pauses = [...notices.keys()].filter((existing) => existing.startsWith("budget-paused:"));
        if (pauses.length >= PAUSE_NOTICES_MAX) notices.delete(pauses[0]!);
      }
      notices.set(key, { ...notice, id: randomUUID() });
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
