const chatTimeFormat = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

const clockFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const dayFormat = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" });
const dayWithYearFormat = new Intl.DateTimeFormat(undefined, {
  weekday: "long", month: "long", day: "numeric", year: "numeric",
});

// Time of day only, for a message under a divider that already names the day.
export function formatClock(createdAtMs: number): string {
  return clockFormat.format(new Date(createdAtMs));
}

// The day a chat lane divider names: Today, Yesterday, else the date.
export function formatChatDay(createdAtMs: number, now = Date.now()): string {
  const day = new Date(createdAtMs);
  const today = new Date(now);
  const startOf = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((startOf(today) - startOf(day)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return (day.getFullYear() === today.getFullYear() ? dayFormat : dayWithYearFormat).format(day);
}

export function sameChatDay(a: number, b: number): boolean {
  const x = new Date(a);
  const y = new Date(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}

export function formatChatTime(createdAtMs: number): { label: string; iso: string } {
  const createdAt = new Date(createdAtMs);
  return {
    label: chatTimeFormat.format(createdAt),
    iso: createdAt.toISOString(),
  };
}
