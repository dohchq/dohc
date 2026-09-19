interface CliChatAuthor {
  kind: "human" | "agent";
  displayName: string;
}

export function renderAuthorDisplayName(author: CliChatAuthor): string {
  return author.displayName;
}
