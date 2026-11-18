/** What the owner reads about a note the server paused for good. */
export function livePauseMessage(pause: {
  path: string;
  cause: "refused" | "failing" | "moved";
  names: readonly string[];
  leftOut: boolean;
}): string {
  const copy = "Edits since the last save are in a copy";
  const told =
    pause.cause === "moved"
      ? `${pause.path} was moved or deleted outside dohc, so live editing stopped. ${copy}.`
      : pause.cause === "failing"
        ? `The server couldn't save edits for 10 minutes, so live editing is paused until you resume. ${copy} next to the note.`
        : `The server couldn't save the latest edits, so live editing is paused until you resume. ${copy} next to the note.${
            pause.names.length
              ? ` Edits from ${new Intl.ListFormat("en", { type: "conjunction" }).format(pause.names)} were in that save.`
              : ""
          }`;
  return pause.leftOut ? `${told} Some edits couldn't be kept.` : told;
}
