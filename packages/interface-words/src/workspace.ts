// Words for a workspace as the phone reads it from the server: Home, the chat list and a chat. The desktop's where it
// has them (file named beside each); the rest are the phone's. Change them here, never in a copy.
// Strings with names or counts are functions, so no app builds a sentence from pieces.

export const workspaceWords = {
  // ExplorerHome.tsx
  pages: "Pages",
  otherFiles: "Other files",
  noPages: "No pages yet.",

  // ChatThreadPanel.tsx and ChatPosts.tsx
  replies: (count: number) => `${count} ${count === 1 ? "reply" : "replies"}`,
  lastReply: (when: string) => `Last reply ${when}`,
  // ChatLane.tsx
  noMessages: "No messages yet.",

  // The phone's.
  groups: "Groups",
  people: "People",
  agents: "Agents",
  noChats: "No chats in this workspace yet.",
  thread: "Thread",
  today: "Today",
  yesterday: "Yesterday",
  filesFailed: (workspace: string) => `dohc could not read the files in ${workspace}.`,
  chatsFailed: (workspace: string) => `dohc could not read the chats in ${workspace}.`,
  chatFailed: "dohc could not read this chat.",
  // Notices, for a chat that is gone (dohc-interface).
  chatMissing: "dohc could not find this chat.",
} as const;
