// Which relay share rows this app's PATH/VERSION manager lists, per lane.
//
// Two managers split the relay's listing: chat-channel grants belong to the
// Chats surface (`listChatChannelShares`), path and version shares belong to
// Settings → Cloud. The split has to be exhaustive for GRANTED rows, because
// ending a share is only possible from the manager that lists it.
//
// That is what makes a DAMAGED row awkward. The chat manager scopes by
// `selector.kind` and `channelWireId`, and a damaged row has no selector at
// all — so a damaged row claiming to be a chat-channel grant can never appear
// there. Excluding it here too would strand it in neither manager, with no
// way left to end it.
//
// So: a READABLE chat-channel selector is the other manager's, and leaves
// both lanes. A damaged row stays in GRANTED whatever kind it claims, and is
// dropped from RECEIVED, where an invitation whose grant cannot be read
// offers the recipient nothing to accept.

type ShareRow = Record<string, unknown>;

/** A row whose selector the relay could read, naming a chat-channel grant. */
export function isReadableChatChannelRow(row: ShareRow): boolean {
  return (row.selector as { kind?: unknown } | undefined)?.kind === "chat-channel";
}

/** A row the relay could not read at all. */
export function isDamagedShareRow(row: ShareRow): boolean {
  return row.selector === null || row.selector === undefined;
}

export function pathShareLanes(listing: {
  granted?: ShareRow[];
  received?: ShareRow[];
}): { granted: ShareRow[]; received: ShareRow[] } {
  return {
    granted: (listing.granted ?? []).filter((row) => !isReadableChatChannelRow(row)),
    received: (listing.received ?? []).filter(
      (row) => !isReadableChatChannelRow(row) && row.selectorKind !== "chat-channel",
    ),
  };
}
