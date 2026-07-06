// The ONE derivation of a chat thread's display title. Untitled threads (the
// no-title-prompt composer path, stored as title = '') display their first
// message's first line, bounded so list rows stay list rows. Lives in a leaf
// module so both the chat store (row reads, startChannelThread) and the
// search index (write-time indexing AND the FTS rebuild) share it without an
// import cycle — a drift here would fork what search shows from what the
// Chats view shows.

export const THREAD_SNIPPET_TITLE_MAX_CHARS = 80;
export const UNTITLED_THREAD_FALLBACK_TITLE = "New chat";

// First line of the first message, collapsed and bounded — the display title
// for untitled threads.
export function threadSnippetTitle(body: string): string {
  const firstLine = body.split("\n", 1)[0]?.replace(/\s+/g, " ").trim() ?? "";
  if (!firstLine) return UNTITLED_THREAD_FALLBACK_TITLE;
  if (firstLine.length <= THREAD_SNIPPET_TITLE_MAX_CHARS) return firstLine;
  return `${firstLine.slice(0, THREAD_SNIPPET_TITLE_MAX_CHARS - 1).trimEnd()}…`;
}

// Stored title ('' means untitled) + first message body -> display title.
export function threadDisplayTitle(
  storedTitle: string,
  firstBody: string | undefined,
): string {
  if (storedTitle !== "") return storedTitle;
  return firstBody !== undefined
    ? threadSnippetTitle(firstBody)
    : UNTITLED_THREAD_FALLBACK_TITLE;
}
