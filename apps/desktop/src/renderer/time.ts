const chatTimeFormat = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

export function formatChatTime(createdAtMs: number): { label: string; iso: string } {
  const createdAt = new Date(createdAtMs);
  return {
    label: chatTimeFormat.format(createdAt),
    iso: createdAt.toISOString(),
  };
}

