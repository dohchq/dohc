interface CliChatAuthor {
  kind: "human" | "agent" | "automation" | "link";
  displayName: string;
}

export function renderAuthorDisplayName(author: CliChatAuthor): string {
  return author.displayName;
}
