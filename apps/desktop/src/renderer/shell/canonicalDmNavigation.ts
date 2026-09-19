import type { DmRecord } from "../../ipc/bridgeContract";
import type { ChatsNav } from "../workbench/ChatsView";
import type { DmChatLocator } from "./chatOpenTarget";

export function resolveCanonicalDm(
  locator: DmChatLocator,
  dms: readonly DmRecord[],
): DmRecord | null {
  // A renderer-supplied graph/backlink row is only a locator. Never construct
  // a DM record from its display metadata: require a canonical main-derived DM
  // with the same running thread and every available stable channel identity.
  if (!locator.channelId && !locator.channelWireId) return null;
  return dms.find(
    (dm) =>
      dm.threadId === locator.threadId &&
      (!locator.channelId || dm.channelId === locator.channelId) &&
      (!locator.channelWireId || dm.channelWireId === locator.channelWireId),
  ) ?? null;
}

export async function runCanonicalDmNavigation(input: {
  locator: DmChatLocator;
  syncDms: () => Promise<{ available: boolean; dms: DmRecord[] }>;
  isCurrent: () => boolean;
  open: (nav: Extract<ChatsNav, { level: "dm" }>) => void;
  onUnavailable: (error?: unknown) => void;
}): Promise<void> {
  try {
    const result = await input.syncDms();
    if (!input.isCurrent()) return;
    // `available` controls whether a new DM can be created; it does not make
    // already-local conversations unreadable while signed out or offline.
    const dm = resolveCanonicalDm(input.locator, result.dms);
    if (!dm) {
      input.onUnavailable();
      return;
    }
    input.open({
      level: "dm",
      dm,
      ...(input.locator.focusMessageId
        ? { focusMessageId: input.locator.focusMessageId }
        : {}),
    });
  } catch (error) {
    if (input.isCurrent()) input.onUnavailable(error);
  }
}
