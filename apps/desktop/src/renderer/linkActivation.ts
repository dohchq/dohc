import { bridge } from "./bridge";
import { confirmExternalOpen } from "./ExternalLinkConfirm";

const ALLOWED_LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);
// Anything that already looks like `scheme:...` (mailto:, javascript:,
// data:, ftp://, tel:, ...). We never rewrite a declared scheme — either
// it's on the allowlist below or the whole input is refused.
const EXPLICIT_SCHEME_RE = /^[a-z][a-z\d+.-]*:/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// `localhost:3000` / `example.com:8080` — a hostname followed by a numeric
// port reads as a `scheme:` to EXPLICIT_SCHEME_RE, so without this it would
// fall through to `null` instead of getting the usual https:// prefix.
// Restricted to `localhost` or a dotted host so declared schemes with numeric
// tails (`tel:1234`) aren't misread as host:port.
const HOST_PORT_RE =
  /^(?:localhost|[a-z0-9-]+(?:\.[a-z0-9-]+)+):\d+(?:[/?#].*)?$/i;

/** Validates + normalizes user-entered link text. Returns the safe,
 *  absolute URL string, or null if the input isn't a usable http(s)/mailto
 *  link. Bare hosts (`example.com`) get `https://` prepended; bare emails
 *  (`a@b.com`) get `mailto:` prepended; anything else must already declare
 *  an allowed scheme. */
export function normalizeLinkUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;

  const candidate = trimmed.startsWith("//")
    ? `https:${trimmed}`
    : HOST_PORT_RE.test(trimmed)
      ? `https://${trimmed}`
      : EXPLICIT_SCHEME_RE.test(trimmed)
        ? trimmed
        : EMAIL_RE.test(trimmed)
          ? `mailto:${trimmed}`
          : `https://${trimmed}`;

  try {
    const url = new URL(candidate);
    return ALLOWED_LINK_PROTOCOLS.has(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Opens a URL through the app's audited external-open pathway
 *  (desktop:open-external-url → shell.openExternal, gated to http(s)/mailto
 *  by isSafeExternalUrl). Invalid URLs and OS open failures are contained.
 *
 *  Every renderer surface that leaves dohc goes through here, so this is also
 *  where the workspace's privacy.confirmExternalLinks setting is honored. */
export async function openLinkExternally(rawUrl: string): Promise<void> {
  const normalized = normalizeLinkUrl(rawUrl);
  if (!normalized) return;
  if (!(await confirmExternalOpen(normalized))) return;
  try {
    await bridge().openExternalUrl({ url: normalized });
  } catch (error) {
    console.warn("[dohc] could not open external link:", error);
  }
}

function percentByteAt(value: string, index: number): number | null {
  const escape = value.slice(index, index + 3);
  return /^%[\da-f]{2}$/iu.test(escape)
    ? Number.parseInt(escape.slice(1), 16)
    : null;
}

function decodeHrefComponent(value: string): string {
  let decoded = "";
  for (let index = 0; index < value.length;) {
    const firstByte = percentByteAt(value, index);
    if (firstByte === null) {
      decoded += value[index];
      index += 1;
      continue;
    }
    if (firstByte < 0x80) {
      decoded += String.fromCharCode(firstByte);
      index += 3;
      continue;
    }

    const width =
      firstByte >= 0xc2 && firstByte <= 0xdf
        ? 2
        : firstByte >= 0xe0 && firstByte <= 0xef
          ? 3
          : firstByte >= 0xf0 && firstByte <= 0xf4
            ? 4
            : 0;
    if (width === 0) {
      decoded += value.slice(index, index + 3);
      index += 3;
      continue;
    }

    let end = index + 3;
    let continuationCount = 0;
    while (continuationCount < width - 1) {
      const byte = percentByteAt(value, end);
      if (byte === null || byte < 0x80 || byte > 0xbf) break;
      continuationCount += 1;
      end += 3;
    }
    const encoded = value.slice(index, end);
    if (continuationCount !== width - 1) {
      decoded += encoded;
      index = end;
      continue;
    }
    try {
      decoded += decodeURIComponent(encoded);
    } catch {
      decoded += encoded;
    }
    index = end;
  }
  return decoded;
}

export type WorkspaceLinkTarget = {
  path: string;
  rawFragment?: string;
};

type ReadOnlyLinkTarget =
  | { kind: "blocked" }
  | { kind: "external"; href: string }
  | { kind: "workspace"; target: WorkspaceLinkTarget };

function parseReadOnlyLinkHref(href: string): ReadOnlyLinkTarget {
  const trimmed = href.trim();
  if (!trimmed) return { kind: "blocked" };
  if (EXPLICIT_SCHEME_RE.test(trimmed) || trimmed.startsWith("//")) {
    return { kind: "external", href: trimmed };
  }

  const fragmentIndex = trimmed.indexOf("#");
  const beforeFragment =
    fragmentIndex === -1 ? trimmed : trimmed.slice(0, fragmentIndex);
  const queryIndex = beforeFragment.indexOf("?");
  const pathEnd = queryIndex === -1 ? beforeFragment.length : queryIndex;
  const rawPath = beforeFragment.slice(0, pathEnd);
  const rawFragment =
    fragmentIndex === -1 ? null : trimmed.slice(fragmentIndex + 1);
  const decodedPath = decodeHrefComponent(rawPath);

  // URL parsers ignore these controls inside a scheme. Check the same
  // collapsed spelling before the value can reach workspace navigation.
  const schemeCandidate = decodedPath.replace(/[\t\n\r]/g, "");
  if (EXPLICIT_SCHEME_RE.test(schemeCandidate)) return { kind: "blocked" };

  if (decodedPath.startsWith("//")) {
    return {
      kind: "external",
      href: `${decodedPath}${trimmed.slice(pathEnd)}`,
    };
  }

  if (!rawPath && rawFragment === null) return { kind: "blocked" };
  const explicitlyRelative =
    decodedPath.startsWith("./") ||
    decodedPath.startsWith("../") ||
    decodedPath.startsWith("/");
  const path = rawPath && !explicitlyRelative ? `./${decodedPath}` : decodedPath;
  return {
    kind: "workspace",
    target: {
      path,
      ...(rawFragment === null ? {} : { rawFragment }),
    },
  };
}

type ReadOnlyLinkEvent = {
  readonly detail: number;
  readonly repeat?: boolean;
  preventDefault(): void;
};

export function activateReadOnlyLinkHref(
  href: string,
  event: ReadOnlyLinkEvent,
  openWorkspaceLink?: (target: WorkspaceLinkTarget) => void,
): boolean {
  event.preventDefault();
  if (event.detail > 1 || event.repeat) return true;
  const target = parseReadOnlyLinkHref(href);
  if (target.kind === "external") void openLinkExternally(target.href);
  if (target.kind === "workspace") openWorkspaceLink?.(target.target);
  return true;
}
