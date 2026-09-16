export const GENERAL_CHANNEL_WIRE_ID = "channel_wire_general_v1";
export const AGENT_CHANNEL_WIRE_ID = "channel_wire_agent_v1";

// The slug the engine derives from a channel name (`channel_slug_for_name`):
// NFC, lowercase; whitespace and `_` become `-`; other characters outside
// `[a-z0-9-]` drop; runs of `-` collapse; ends trim. A group's default
// folder is its slug, so both sides must spell it the same way.
export function channelSlugForName(name: string): string {
  const lowered = name.normalize("NFC").toLowerCase();
  let out = "";
  for (const ch of lowered) {
    if (/\s|_/u.test(ch)) out += "-";
    else if (/[a-z0-9-]/u.test(ch)) out += ch;
  }
  return out.replace(/-+/gu, "-").replace(/^-|-$/gu, "");
}
