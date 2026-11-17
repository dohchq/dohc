export const GENERAL_CHANNEL_WIRE_ID = "channel_wire_general_v1";
export const AGENT_CHANNEL_WIRE_ID = "channel_wire_agent_v1";

const DEFAULT_AGENT_ID = "default";
const AGENT_ID = /^(?!.*--)[a-z][a-z0-9-]{0,63}(?<!-)$/;

/** The wire id of an agent's chat. The engine writes it the same way. */
export function agentChannelWireId(agentId: string): string {
  return agentId === DEFAULT_AGENT_ID
    ? AGENT_CHANNEL_WIRE_ID
    : `${AGENT_CHANNEL_WIRE_ID}_${agentId}`;
}

/** The agent whose chat a wire id names, or null. The engine reads it the same way. */
export function agentIdForChannelWireId(wireId: string): string | null {
  if (wireId === AGENT_CHANNEL_WIRE_ID) return DEFAULT_AGENT_ID;
  const prefix = `${AGENT_CHANNEL_WIRE_ID}_`;
  if (!wireId.startsWith(prefix)) return null;
  const agentId = wireId.slice(prefix.length);
  return AGENT_ID.test(agentId) && agentId !== DEFAULT_AGENT_ID ? agentId : null;
}

/**
 * Whether a channel is a Group: an ordinary channel, never General, a direct
 * message, or an agent chat. `kind` is the channel's kind in the owner's log.
 * The relay's workspace reach and the automation reach check both ask this.
 */
export function isWorkspaceGroup(
  wireId: string | null,
  kind: string | null | undefined,
): wireId is string {
  return (
    typeof wireId === "string" &&
    wireId.length > 0 &&
    wireId !== GENERAL_CHANNEL_WIRE_ID &&
    !wireId.startsWith(AGENT_CHANNEL_WIRE_ID) &&
    kind === "channel"
  );
}
