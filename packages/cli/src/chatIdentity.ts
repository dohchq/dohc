interface CliChatAuthor {
  kind: "human" | "agent" | "automation";
  displayName: string;
}

export function renderAuthorDisplayName(author: CliChatAuthor): string {
  return author.displayName;
}
