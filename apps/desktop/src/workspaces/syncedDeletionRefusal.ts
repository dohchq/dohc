export const SYNCED_DELETION_REVIVAL_WORDS = (path = "this file", stale = false, restore = false) => {
  const file = path.split(/[\\/]/).at(-1) || path;
  return {
    batch: "Bringing it back could stop sync. Copy its text from its History into a file with a new name.",
    ...(stale ? {
      title: `dohc can't settle the conflict in ${file}`,
      words: `Move your newer lines into the new file, and leave ${file} and its copies alone. Your other files keep syncing.`,
      details: `${file} changed on this machine after the conflict appeared, so either choice would overwrite the newer lines.`,
    } : {
      title: `dohc can't bring back ${file}, because that could stop sync`,
      words: restore ? "Copy its text from its History into a file with a new name." : `Choose Keep this machine's copy, then copy its text from its History into a file with a new name. When your other machine shows a conflict for ${file}, keep the removal there.`,
      details: restore ? `A sync conflict between your machines removes ${file}. Bringing it back could stop sync between them.` : `${file} is removed on this machine and was changed on your other machine. Bringing it back could stop sync between your machines.`,
    }),
  };
};

export class SyncedDeletionRevivalError extends Error {
  constructor(readonly path = "this file", options?: ErrorOptions, readonly restore = false) {
    super(SYNCED_DELETION_REVIVAL_WORDS(path).batch, options);
    this.name = "SyncedDeletionRevivalError";
  }
}

export class SyncedDeletionStaleError extends SyncedDeletionRevivalError {
  constructor(path: string, options?: ErrorOptions) {
    super(path, options);
    this.name = "SyncedDeletionStaleError";
    this.message = SYNCED_DELETION_REVIVAL_WORDS(path, true).details;
  }
}
