// Words both apps show for a document (page). From the desktop's FileInspector, MarkdownView, fileInspectorUi
// and StateMark; phone-only sentences are marked. Change them here, never in a copy.

const couldNotOpenForEditing =
  "dohc could not open this document for editing. You can still read it.";
const setAsideReadOnly =
  "This document became read-only before your edit saved. Copy your text to keep it.";

export const documentWords = {
  loading: "Loading…",
  opening: "Opening…",
  openingExplanation: "You can edit this document when it finishes opening.",
  tryAgain: "Try again",
  couldntRead: "dohc could not read this file.",
  /** Phone: the page's view couldn't load (or its editor files couldn't be written), so nothing is on screen. */
  couldntOpen: "dohc could not open this file.",
  /** Phone: under "dohc could not open this file." when the editor files could not be written for lack of space. */
  notEnoughStorage: "Not enough storage on this phone. Free up space, then choose Try again.",
  noLongerAvailable: "This file is no longer available at this path.",
  couldNotOpenForEditing,
  documentActions: "Document actions",
  copyAsMarkdown: "Copy as Markdown",
  rename: "Rename",
  newPageTitle: "New page",
  renameTitle: "Rename",
  namePlaceholder: "Name",
  create: "Create",
  save: "Save",
  creating: "Creating…",
  saving: "Saving…",
  deleting: "Deleting…",
  coldCopyNote: "Opening your workspace on the server may take a moment.",
  nameRequired: "Enter a name.",
  invalidName: "That name can't be used here.",
  couldntCreate: "dohc could not create this page.",
  couldntRename: "dohc could not rename this file.",
  couldntDelete: "dohc could not delete this file.",
  refusedExists: "A file with that name already exists.",
  refusedMissing: "This file is no longer here.",
  refusedChanged: "This file changed before your change finished. Try again.",
  refusedLiveActive: "Someone is editing this page right now. Close it everywhere, then try again.",
  refusedLiveUnsettled: "Recent edits are still saving. Wait a moment, then try again.",
  copied: "Copied",
  couldntCopy: "Could not copy",
  /** The save mark. Calm states (saved, saving) draw nothing. */
  mark: {
    couldntSave: {
      label: "Could not save",
      explanation:
        "Your edits are still here, but dohc cannot confirm the file on disk matches them. Keep this document open and try another edit.",
    },
    readOnlyShared: {
      label: "Read-only",
      explanation: "This document is shared with you to read.",
    },
    readOnlyPausedByOwner: {
      label: "Read-only",
      explanation: "The owner paused live editing for this document.",
    },
    readOnlyEnded: { label: "Read-only", explanation: "Your access to this document ended." },
    tooLarge: { label: "Read-only", explanation: "This file is too large to edit in dohc." },
    readOnlyOffline: { label: "Read-only", explanation: "dohc could not reach the server." },
    readOnlyPhone: { label: "Read-only", explanation: "dohc can't edit pages on a phone yet." },
    /**
     * Phone, editing on the server: calm, so no glyph. Saved means the server's host applied every edit made here;
     * Saving, that it hasn't confirmed some yet.
     */
    saved: { label: "Saved", explanation: "Your server has applied every edit you made here." },
    saving: {
      label: "Saving",
      explanation: "Your server hasn't confirmed your latest edits yet. Keep this page open.",
    },
    /** Phone: the server didn't open the page for editing, or the open failed. */
    readOnlyRefused: { label: "Read-only", explanation: couldNotOpenForEditing },
    /** Phone: the server edits only pages a computer has opened live. */
    readOnlyNeedsComputer: {
      label: "Read-only",
      explanation: "Open this page on a computer once to edit it here.",
    },
    /** Phone: the server refused an edit, which stays on screen to copy. */
    readOnlySetAside: { label: "Read-only", explanation: setAsideReadOnly },
    /** Phone: the desktop's sentence names a trash the phone doesn't have. */
    deleted: {
      label: "Deleted",
      explanation: "This file was deleted while you had it open. You can still copy what's here.",
    },
  },
  lossy: "dohc can't edit this note yet without changing parts it can't show.",
  lossyHeld: "dohc held a change to this note. Saving it would also change parts dohc can't show.",
  editAnyway: "Edit anyway",
  editAnywayTitle: "Edit this note anyway?",
  editAnywayBody: "Saving rewrites the parts dohc can't show.",
  historyKeeps: "History keeps the original.",
  historyDoesNotTrack: "History does not track this file, so dohc can't restore the original.",
  historyUnconfirmed: "dohc could not confirm that History can restore the original.",
  /** Phone: the server refuses a file over the editor's limit before reading any of it, so nothing shows. */
  tooLargeToOpen: "This file is too large to open on a phone. Open it on a computer.",
  /** Phone: a page in a note format only a newer dohc opens. The desktop's sentence, said of the page. */
  needsNewerDohc: "This page needs a newer version of dohc. Update dohc to open it.",
  /** Phone: the desktop's button opens the full file in another app; the phone points to a computer. */
  largeFile: "Showing the start of a large file. Open it on a computer to see all of it.",
  setAsideReadOnly,
  /** Phone: leaving a page whose edits the server hasn't applied. */
  unsentTitle: "Your server hasn't saved your latest edits",
  unsentBody: "Copy the page to keep them, or discard them.",
  discardEdits: "Discard edits",
  /** Phone: a file chat's header button and its way back. */
  openPage: (name: string) => `Open ${name}`,
  /** Phone only: the page header's button back to the file's chat. */
  openChat: (name: string) => `Chat about ${name}`,
  /** A change to a live note that dohc did not save, and put back. From the desktop's MarkdownEditor. */
  unwrittenOvertaken:
    "Someone else's change reached the note first, so dohc put it back as it was. Make your change again.",
  unwritten: "dohc can't save this change in a live note yet, so it put the note back as it was.",
  dismiss: "Dismiss",
  comments: "Comments",
  noComments: "No comments yet.",
  commentsFailed: "dohc could not read comments for this file.",
  commentPlaceholder: "Add a comment",
  commentAction: "Comment",
  commentThread: "Comment",
  close: "Close",
  toolbar: {
    label: "Formatting",
    bold: "Bold",
    italic: "Italic",
    strike: "Strikethrough",
    code: "Inline code",
    heading1: "Heading 1",
    heading2: "Heading 2",
    heading3: "Heading 3",
    bulletList: "Bullet list",
    orderedList: "Numbered list",
    taskList: "To-do list",
    blockquote: "Quote",
    codeBlock: "Code block",
    undo: "Undo",
    redo: "Redo",
  },
} as const;
