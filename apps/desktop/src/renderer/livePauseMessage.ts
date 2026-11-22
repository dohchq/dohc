/** What the owner reads about a note the server paused for good. */
export function livePauseMessage(pause: {
  path: string;
  cause: "refused" | "failing" | "ended";
  names: readonly string[];
  leftOut: boolean;
}): string {
  const copy = "Edits since the last save are in a copy";
  const told =
    pause.cause === "ended"
      ? `Live editing stopped because ${pause.path} was moved, deleted, or replaced. ${copy}.`
      : pause.cause === "failing"
        ? `The server could not save edits for 10 minutes, so live editing is paused until you resume. ${copy} next to the note.`
        : `The server could not save the latest edits, so live editing is paused until you resume. ${copy} next to the note.${
            pause.names.length
              ? ` Edits from ${new Intl.ListFormat("en", { type: "conjunction" }).format(pause.names)} were in that save.`
              : ""
          }`;
  return pause.leftOut ? `${told} Some edits could not be kept.` : told;
}
