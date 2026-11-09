// Words both apps show for a document (page). From the desktop's FileInspector, MarkdownView, fileInspectorUi
// and StateMark; phone-only sentences are marked. Change them here, never in a copy.

export const documentWords = {
  loading: "Loading…",
  opening: "Opening…",
  openingExplanation: "You can edit this document when it finishes opening.",
  tryAgain: "Try again",
  couldntRead: "Couldn't read this file.",
  /** Phone: the page's view couldn't load (or its editor files couldn't be written), so nothing is on screen. */
  couldntOpen: "dohc could not open this file.",
  /** Phone: under "dohc could not open this file." when the editor files could not be written for lack of space. */
  notEnoughStorage: "Not enough storage on this phone. Free up space, then choose Try again.",
  noLongerAvailable: "This file is no longer available at this path.",
  couldNotOpenForEditing: "dohc could not open this document for editing. You can still read it.",
  documentActions: "Document actions",
  copyAsMarkdown: "Copy as Markdown",
  copied: "Copied",
  couldntCopy: "Couldn't copy",
  /** The save mark. Calm states (saved, saving) draw nothing. */
  mark: {
    couldntSave: { label: "Couldn't save", explanation: "Your edits are still here, but dohc can't confirm the file on disk matches them. Keep this document open and try another edit." },
    readOnlyShared: { label: "Read-only", explanation: "This document is shared with you to read." },
    readOnlyEnded: { label: "Read-only", explanation: "Your access to this document ended." },
    tooLarge: { label: "Read-only", explanation: "This file is too large to edit in dohc." },
    /** Phone: the server can't be reached, so pages are read-only until it answers. */
    readOnlyOffline: { label: "Read-only", explanation: "dohc could not reach the server." },
    /** Phone: the desktop's sentence names a trash the phone doesn't have. */
    deleted: { label: "Deleted", explanation: "This file was deleted while you had it open. You can still copy what's here." },
  },
  lossy: "dohc can't edit this note yet without changing parts it can't show.",
  lossyHeld: "dohc held a change to this note. Saving it would also change parts dohc can't show.",
  editAnyway: "Edit anyway",
  editAnywayTitle: "Edit this note anyway?",
  editAnywayBody: "Saving rewrites the parts dohc can't show, such as raw HTML or reference links.",
  historyKeeps: "History keeps the original.",
  historyDoesNotTrack: "History does not track this file, so dohc can't restore the original.",
  historyUnconfirmed: "dohc could not confirm that History can restore the original.",
  /** Phone: the desktop's button opens the full file in another app; the phone points to a computer. */
  largeFile: "Showing the start of a large file. Open it on a computer to see all of it.",
  setAsideReadOnly: "This document became read-only before your edit saved. Copy your text to keep it.",
  /** Phone: a file chat's header button and its way back. */
  openPage: (name: string) => `Open ${name}`,
  /** Phone only: the page header's button back to the file's chat. */
  openChat: (name: string) => `Chat about ${name}`,
} as const;
