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
  try {
    const { hostname } = new URL(url);
    return domainToUnicode(hostname) || hostname || "a link";
  } catch {
    return "a link";
  }
};

/**
 * Text as a lock screen may show it: plain text, a file link as its file's
 * name unless that file is hidden, no work-link reference, no Markdown
 * target, and every URL reduced to its host. Reads at most the first 4096
 * code points, more than an alert can show.
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
  const cleaned = text
    // A malformed link the scan refused keeps nothing after its opener.
    .replace(/@\[[^\]\r\n]*\]?/gu, "a file")
    // Markdown images and links keep their words, never their targets, even one with parentheses.
    .replace(/!?\[([^[\]\r\n]*)\]\((?:[^()[\]\s]|\([^()[\]\s]*\))*\)/gu, "$1")
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

const byteLength = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

/**
 * The APNs JSON body: the alert and the identifiers the phone needs to open
 * the message. The body text is cut by code point until the whole JSON,
 * escaped, fits Apple's 4096 bytes.
 */
export function apnsPayload(input: {
  title: string;
  body: string;
  threadKey: string;
  data: Record<string, string | number>;
}): string {
  const build = (body: string) => ({
    aps: { alert: { title: input.title, body }, sound: "default", "thread-id": input.threadKey },
    ...input.data,
  });
  // Every code point takes at least one byte, so no more than the limit can fit.
  const all = [...input.body];
  const points = all.slice(0, APNS_PAYLOAD_MAX_BYTES);
  const cut = (count: number) =>
    count === all.length ? input.body : `${points.slice(0, count).join("")}…`;
  if (byteLength(build(cut(points.length))) <= APNS_PAYLOAD_MAX_BYTES)
    return JSON.stringify(build(cut(points.length)));
  let low = 0;
  let high = points.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (byteLength(build(cut(middle))) <= APNS_PAYLOAD_MAX_BYTES) low = middle;
    else high = middle - 1;
  }
  const payload = JSON.stringify(build(cut(low)));
  if (Buffer.byteLength(payload) > APNS_PAYLOAD_MAX_BYTES)
    throw new RangeError("APNs payload too large");
  return payload;
}
