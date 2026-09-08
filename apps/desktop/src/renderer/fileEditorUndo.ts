export type PendingFileUndo = {
  token: number;
  path: string;
  restoredText: string;
  undoText: string;
};

export type PendingTextUndo = Omit<PendingFileUndo, "path">;
