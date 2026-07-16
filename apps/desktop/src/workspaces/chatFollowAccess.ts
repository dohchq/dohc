export async function listChatFollowsReadOnlySafe<T>(input: {
  readOnly: boolean;
  seedDefaults: () => Promise<void>;
  list: () => Promise<T>;
}): Promise<T> {
  if (!input.readOnly) await input.seedDefaults();
  return input.list();
}

export async function listChatChannelsReadOnlySafe<T>(input: {
  readOnly: boolean;
  seedGeneral: () => Promise<void>;
  list: () => Promise<T>;
}): Promise<T> {
  // Channel listing is a read surface. A shared view must never turn that read
  // into a durable local write by auto-creating General.
  if (!input.readOnly) await input.seedGeneral();
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
