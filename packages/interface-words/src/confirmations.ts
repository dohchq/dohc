// Words for confirmation sheets and their notices. The desktop's where it has them (file named beside each);
// phone-only words are the design lead's.

const one = (count: number, single: string, several: string): string => (count === 1 ? single : several);

export const confirmWords = {
  cancel: "Cancel",
  // workbench/Explorer.tsx. The body is the phone's: a delete on the server leaves no trash.
  delete: "Delete",
  /** Paths from the workspace root; one file is named by its base name, as on the desktop. */
  deleteFilesTitle: (paths: readonly string[]) =>
    `Delete ${paths.length === 1 ? (paths[0]?.split("/").pop() ?? "") : `${paths.length} items`}?`,
  deleteFilesBody: (count: number, workspace: string) =>
    `${one(count, "It goes", "They go")} from ${workspace} for everyone now. There is no trash to restore ${one(count, "it", "them")} from.`,
  // workbench/DmPlacement.tsx
  leave: "Leave",
  leaveConversationTitle: (peer: string) => `Leave your conversation with ${peer}?`,
  leaveConversationBody: (workspace: string) =>
    `The conversation leaves ${workspace}. It appears again as a message request, so you can add it to a workspace later. Your messages are kept.`,
  leaveConversation: "Leave conversation",
  // WorkspaceManager.tsx's Forget; the waiting warning and the notice are the phone's.
  forget: "Forget",
  forgetTitle: (workspace: string) => `Forget ${workspace}?`,
  forgetWaiting: (count: number) =>
    `${count} ${one(count, "message is", "messages are")} waiting to send from this phone. Forget deletes ${one(count, "it", "them")}. Undo restores the workspace, not the ${one(count, "message", "messages")}.`,
  forgot: (name: string) => `Forgot ${name}. It stays on the server.`,
  undo: "Undo",
} as const;
