// What a share of `shared` says when new notes it covers have no file on the
// server yet. Each note's first file reaches the server only once its open
// editor is left, so until then a link to it shows no file. Null when none.
export function notSentWords(
  shared: readonly string[],
  notSent: readonly string[],
): { state: string; next: string } | null {
  const notes = notSent.filter((path) =>
    shared.some((root) => path === root || path.startsWith(`${root}/`)),
  );
  if (notes.length === 0) return null;
  if (notes.length === 1)
    return {
      state:
        shared.length === 1 && shared[0] === notes[0]
          ? "This note hasn't been sent yet."
          : "1 open note here hasn't been sent yet.",
      next: "Leave the note or close its tab to send it.",
    };
  return {
    state: `${notes.length} open notes here haven't been sent yet.`,
    next: "Leave them or close their tabs to send them.",
  };
}
