// A work link: <server origin>/l/<43-character work reference>.
// The link names one message, file, record, or app. It grants nothing;
// whoever opens it needs their own access to the workspace that holds it.
const WORK_REFERENCE_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const WORK_LINK_PATH_PATTERN = /^\/l\/([A-Za-z0-9_-]{43})$/u;
const MAX_WORK_LINK_LENGTH = 2048;

export interface WorkLink {
  /** The origin of the server that serves the link, such as `https://dohc.example`. */
  readonly server: string;
  readonly reference: string;
}

export function isWorkReference(value: string): boolean {
  return WORK_REFERENCE_PATTERN.test(value);
}

/** The origin of an http(s) server URL without credentials, or null. */
export function workLinkServerOrigin(value: string): string | null {
  if (value.length === 0 || value.length > MAX_WORK_LINK_LENGTH) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** The path a server serves a work reference at. */
export function workLinkPathReference(pathname: string): string | null {
  return WORK_LINK_PATH_PATTERN.exec(pathname)?.[1] ?? null;
}

export function parseWorkLinkUrl(raw: string): WorkLink | null {
  if (raw.length === 0 || raw.length > MAX_WORK_LINK_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password || url.search || url.hash) return null;
  const reference = workLinkPathReference(url.pathname);
  return reference === null ? null : { server: url.origin, reference };
}

export function buildWorkLinkUrl(link: WorkLink): string {
  if (!isWorkReference(link.reference)) throw new Error("invalid work reference");
  if (workLinkServerOrigin(link.server) !== link.server) throw new Error("invalid work link server");
  return `${link.server}/l/${link.reference}`;
}
