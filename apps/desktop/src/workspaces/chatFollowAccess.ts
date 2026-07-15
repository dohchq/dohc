export async function listChatFollowsReadOnlySafe<T>(input: {
  readOnly: boolean;
  seedDefaults: () => Promise<void>;
  list: () => Promise<T>;
}): Promise<T> {
  if (!input.readOnly) await input.seedDefaults();
  return input.list();
}

export function assertChatFollowWriteAllowed(input: {
  readOnly: boolean;
  reject: () => void;
}): void {
  if (input.readOnly) input.reject();
}

export async function markPersonalFeedSeenReadOnlySafe(input: {
  readOnly: boolean;
  mark: () => Promise<void>;
}): Promise<void> {
  if (input.readOnly) return;
  await input.mark();
}
