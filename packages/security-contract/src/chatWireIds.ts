export const GENERAL_CHANNEL_WIRE_ID = "channel_wire_general_v1";
export const AGENT_CHANNEL_WIRE_ID = "channel_wire_agent_v1";

// The slug the engine derives from a channel name (`channel_slug_for_name`):
// NFC, lowercase; whitespace and `_` become `-`; other characters outside
// `[a-z0-9-]` drop; runs of `-` collapse; ends trim. A group's default
// folder is its slug, so both sides must spell it the same way.
// A group's default folder, from its name: NFC, lowercase, whitespace and
// `_` become `-`, letters and digits of any script stay, the rest drops.
// The wire slug above is ASCII for engine parity; a folder is a name on
// disk, and "会议" deserves a folder called 会议.
export function groupFolderForName(name: string): string {
  const lowered = name.normalize("NFC").toLowerCase().replace(/\p{White_Space}+/gu, "-");
  let out = "";
  for (const ch of lowered) {
    if (ch === "_") out += "-";
    else if (/[\p{L}\p{N}-]/u.test(ch)) out += ch;
  }
  return out.replace(/-+/gu, "-").replace(/^-|-$/gu, "");
}

export function channelSlugForName(name: string): string {
  const lowered = name.normalize("NFC").toLowerCase().replace(/\p{White_Space}+/gu, "-");
  let out = "";
  for (const ch of lowered) {
    if (ch === "_") out += "-";
    else if (/[a-z0-9-]/u.test(ch)) out += ch;
  }
  return out.replace(/-+/gu, "-").replace(/^-|-$/gu, "");
}
