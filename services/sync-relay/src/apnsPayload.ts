import { domainToUnicode } from "node:url";
import { scanChatLinks } from "@dohc/workspace-contracts/chat-mentions";
import { hiddenFile } from "./accountFeed";

export const APNS_PAYLOAD_MAX_BYTES = 4096;

// Each URL pattern costs a bounded amount per position, so it stays linear in the text.
// A URL with a scheme, whatever its host.
const SCHEME_URL = /[a-z][a-z0-9+.-]{0,31}:\/\/\S*/giu;
// A URL without one: a dotted host, localhost, or an IP, perhaps after a user and before a path.
const BARE_URL =
  /(?<![\p{L}\p{N}_-])(?:[^\s/?#@[\]]{1,64}@)?((?:[\p{L}\p{N}-]{1,63}\.){1,8}\p{L}{2,63}|localhost|\[[0-9a-f:.]{2,45}\]|\d{1,3}(?:\.\d{1,3}){3})(?::\d{1,5})?(?:[/?#]\S*)?/giu;
// A capability path pasted without its host.
const BARE_LINK_PATH = /(?<![\w/])\/l\/[A-Za-z0-9_-]+\S*/gu;

const urlHost = (url: string) => {
  const host = URL.parse(url)?.hostname ?? "";
  return domainToUnicode(host) || host || "a link";
};

/** A Markdown link or image keeps its words; its whole target goes, to the closing parenthesis or the line's end. */
function withholdTargets(text: string): string {
  const opener = /!?\[([^[\]\r\n]*)\]\(/gu;
  let kept = "";
  let at = 0;
  for (let found = opener.exec(text); found; found = opener.exec(text)) {
    let end = opener.lastIndex;
    for (let depth = 1; depth > 0 && end < text.length && !"\r\n".includes(text[end]!); end++)
      depth += text[end] === "(" ? 1 : text[end] === ")" ? -1 : 0;
    kept += text.slice(at, found.index) + found[1];
    at = opener.lastIndex = end;
  }
  return kept + text.slice(at);
}

/**
 * Text as a lock screen may show it: a file link as its file's name unless hidden, no work-link
 * reference or Markdown target, and every URL reduced to its host. Reads at most 4096 code points.
 */
export function apnsText(message: string): string {
  // A lone surrogate becomes U+FFFD, which keeps every index the link scan returns.
  const points = [...message.toWellFormed()];
  const body = points.slice(0, APNS_PAYLOAD_MAX_BYTES).join("");
  let text = "";
  let at = 0;
  const { files, works } = scanChatLinks(body);
  for (const link of [...files, ...works].sort((a, b) => a.start - b.start)) {
    const name =
      "path" in link
        ? hiddenFile(link.path)
          ? "a file"
          : link.path.split("/").at(-1) || "a file"
        : "a link";
    text += body.slice(at, link.start) + name;
    at = link.end;
  }
  text += body.slice(at);
  // A malformed link the scan refused keeps nothing after its opener.
  const cleaned = withholdTargets(text.replace(/@\[[^\]\r\n]*\]?/gu, "a file"))
    .replace(SCHEME_URL, urlHost)
    .replace(BARE_URL, (_match, host: string) => host)
    .replace(BARE_LINK_PATH, "a link")
    .replace(/^\s{0,3}(?:#{1,6}|>|[-*+]|\d{1,9}[.)])\s+/gmu, "")
    .replace(/(\*\*|__|~~)(.+?)\1/gu, "$2")
    .replace(/`+/gu, "")
    .replace(/[\p{Cc}\p{Cf}<>]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return points.length > APNS_PAYLOAD_MAX_BYTES ? `${cleaned}…` : cleaned;
}

/**
 * The APNs JSON body: the alert and the identifiers the phone needs to open the message. The body
 * is cut by code point until the whole JSON, escaped, fits Apple's 4096 bytes.
 */
export function apnsPayload(input: {
  title: string;
  body: string;
  threadKey: string;
  data: Record<string, string | number>;
}): string {
  const build = (body: string) =>
    JSON.stringify({
      aps: { alert: { title: input.title, body }, sound: "default", "thread-id": input.threadKey },
      ...input.data,
    });
  const whole = build(input.body);
  if (Buffer.byteLength(whole) <= APNS_PAYLOAD_MAX_BYTES) return whole;
  // JSON escapes each code point on its own, so their escaped sizes add up.
  let room = APNS_PAYLOAD_MAX_BYTES - Buffer.byteLength(build("…"));
  let body = "";
  for (const point of input.body) {
    room -= Buffer.byteLength(JSON.stringify(point)) - 2;
    if (room < 0) break;
    body += point;
  }
  const payload = build(`${body}…`);
  if (Buffer.byteLength(payload) > APNS_PAYLOAD_MAX_BYTES)
    throw new RangeError("APNs payload too large");
  return payload;
}
