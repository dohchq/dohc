// Words for a workspace as the phone reads it from the server: Home, the chat list and a chat. The desktop's where it
// has them (file named beside each); the rest are the phone's. Change them here, never in a copy.
// Strings with names or counts are functions, so no app builds a sentence from pieces.

export const workspaceWords = {
  /** Phone only: the back arrow in an Android header. */
  back: "Back",
  // ExplorerHome.tsx
  pages: "Pages",
  sketches: "Sketches",
  newSketch: "New sketch",
  otherFiles: "Other files",
  noPages: "No pages yet.",
  showAllSketches: (count: number) => `Show all ${count} sketches`,
  creatingSketch: "Creating…",
  sketchCreateFailed: "dohc could not create a sketch.",
  sketchReadFailed: "dohc could not open this sketch.",
  sketchInvalid: "This file is not a valid sketch.",
  sketchSave: "Save",
  sketchSaving: "Saving…",
  sketchSaveFailed: "dohc could not save this sketch.",
  sketchChangedElsewhere: "This sketch was replaced or deleted elsewhere.",
  sketchSaveConflict: (count: number) =>
    count === 1
      ? "Someone else changed 1 element. Your edit is still unsaved."
      : `Someone else changed ${count} elements. Your edits are still unsaved.`,
  sketchAssetsMissing: (count: number) =>
    count === 1 ? "dohc could not load 1 image." : `dohc could not load ${count} images.`,
  sketchUnsavedTitle: "Save changes to this sketch?",
  sketchUnsavedBody: "Your latest edits are only on this phone until you save.",
  sketchUnavailableJoined: "Sketches cannot be opened in a shared workspace on a phone yet.",
  sketchConflictReadOnly: "This sketch has a sync conflict. Resolve it on desktop before editing.",

  // ChatThreadPanel.tsx and ChatPosts.tsx
  replies: (count: number) => `${count} ${count === 1 ? "reply" : "replies"}`,
  lastReply: (when: string) => `Last reply ${when}`,
  // ChatLane.tsx
  noMessages: "No messages yet.",

  // The phone's.
  groups: "Groups",
  people: "People",
  agents: "Agents",
  /** Agent chats whose agent no computer of yours has now, as the desktop's sidebar files them. */
  archived: "Archived",
  /** The default agent's chat once no computer has that agent, as the desktop names it (agentChat.ts). */
  yourAgent: "Your agent",
  noChats: "No chats in this workspace yet.",
  thread: "Thread",
  today: "Today",
  yesterday: "Yesterday",
  filesFailed: (workspace: string) => `dohc could not read the files in ${workspace}.`,
  chatsFailed: (workspace: string) => `dohc could not read the chats in ${workspace}.`,
  chatFailed: "dohc could not read this chat.",
  /** The change feed keeps failing, so what's shown may be out of date. */
  changesFailed: (workspace: string) => `dohc could not get the latest changes in ${workspace}.`,
  // Notices, for a chat that is gone (dohc-interface).
  chatMissing: "dohc could not find this chat.",
  newPage: "New page",
  showAll: (count: number) => `Show all (${count})`,
  fileActions: (name: string) => `Actions for ${name}`,
  quickCapture: "Capture to Inbox",
  captureSave: "Capture",
  capturing: "Capturing…",
  captureTitleLabel: "Title",
  captureTitlePlaceholder: "Optional",
  captureNoteLabel: "Note",
  captureNotePlaceholder: "Write a note",
  captureLinkLabel: "Link",
  captureLinkPlaceholder: "https://example.com",
  captureEmptyError: "Enter a title, note, or link.",
  captureInvalidLink: "Enter a link starting with http:// or https://.",
  captureTooLarge: "This note is too large to send. Shorten it and try again.",
  captureSaved: "Saved to Inbox",
  captureQueued: "Queued for Inbox",
  captureQueuedBody: "This phone will send it when back online.",
  captureSending: (count: number) =>
    count === 1 ? "Sending 1 item to Inbox…" : `Sending ${count} items to Inbox…`,
  captureWaiting: (count: number) =>
    count === 1 ? "1 item waiting to send to Inbox" : `${count} items waiting to send to Inbox`,
  captureFailed: (title: string) => `dohc could not send "${title}" to Inbox.`,
  captureCouldntKeep: "dohc could not save this note on this phone.",
  edit: "Edit",
  discard: "Discard",
  uploadFile: "Upload file",
  fileUploaded: (name: string) => `Uploaded ${name}`,
  fileUploadFailed: "dohc could not upload this file.",
  fileTooLarge: "Files can be up to 5 MiB. Choose a smaller file.",
  fileEmpty: "Empty files cannot be uploaded. Choose a file with content.",
  filePathNotAllowed:
    "This file name or type cannot be uploaded here. Rename it or choose another file.",
  fileReadFailed: "dohc could not load this file.",
  fileMissing: "dohc could not find this file.",
  filePreviewUnavailable: "This file cannot be previewed in dohc.",
  fileTextTooLarge: "Files larger than 512 KiB are not previewed inline.",
  openInAnotherApp: "Open in another app",
  shareFile: "Share file",
  fileOpenFailed: "dohc could not open this file in another app.",
} as const;
