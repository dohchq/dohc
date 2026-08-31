export type ShareAccess = "view" | "comment";

export interface ViewMeta {
  access: ShareAccess;
  effectiveSelector: {
    paths: string[];
    versionId: string | null;
    access: ShareAccess;
  };
  lastSettledAtMs: number | null;
  lastSettledKnown: boolean;
}

export interface RelayOp {
  relaySeq: number;
  opKind: "workspace.init" | "moment.append" | "version.create";
  payload: unknown;
  recordedAtMs: number;
}

export interface SharedFile {
  path: string;
  blobSha256: string;
  contentKind: "text" | "binary";
}

export interface NamedDiscussionAuthor {
  kind: "named";
  displayName: string;
}

export interface LinkDiscussionAuthor {
  kind: "link";
  displayName: string;
  unverified: true;
}

export interface LiveDiscussionMessage {
  messageId: string;
  createdAtMs: number;
  deleted: false;
  body: string;
  author: NamedDiscussionAuthor | LinkDiscussionAuthor;
}

export interface DeletedDiscussionMessage {
  messageId: string;
  createdAtMs: number;
  deleted: true;
}

export type PublicDiscussionMessage =
  | LiveDiscussionMessage
  | DeletedDiscussionMessage;

export type DiscussionAppendResult =
  | {
      kind: "live";
      message: LiveDiscussionMessage & { author: LinkDiscussionAuthor };
    }
  | { kind: "deleted"; message: DeletedDiscussionMessage };

export interface PublicDiscussionPage {
  messages: PublicDiscussionMessage[];
  nextCursor: string | null;
  activityRevision: number;
  profileName: string | null;
}

export type DiscussionComposerState = "available" | "blocked" | "paused";

export interface PublicDiscussionActivity {
  access: ShareAccess;
  latestRevision: number;
  cursorRevision: number;
  hasMore: boolean;
  messages: PublicDiscussionMessage[];
  composerState: DiscussionComposerState;
}

export type FileAccumulator = Map<string, SharedFile>;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

function discussionAuthor(value: unknown): NamedDiscussionAuthor | LinkDiscussionAuthor | null {
  const author = record(value);
  if (!author || typeof author.displayName !== "string" || author.displayName.length === 0) {
    return null;
  }
  if (author.kind === "named" && hasExactKeys(author, ["kind", "displayName"])) {
    return { kind: "named", displayName: author.displayName };
  }
  if (
    author.kind === "link" &&
    author.unverified === true &&
    hasExactKeys(author, ["kind", "displayName", "unverified"])
  ) {
    return { kind: "link", displayName: author.displayName, unverified: true };
  }
  return null;
}

function discussionMessage(value: unknown): PublicDiscussionMessage | null {
  const message = record(value);
  if (
    !message ||
    typeof message.messageId !== "string" ||
    message.messageId.length === 0 ||
    typeof message.createdAtMs !== "number" ||
    !Number.isSafeInteger(message.createdAtMs) ||
    message.createdAtMs < 0
  ) {
    return null;
  }
  if (
    message.deleted === true &&
    hasExactKeys(message, ["messageId", "createdAtMs", "deleted"])
  ) {
    return {
      messageId: message.messageId,
      createdAtMs: message.createdAtMs,
      deleted: true,
    };
  }
  const author = discussionAuthor(message.author);
  if (
    message.deleted !== false ||
    typeof message.body !== "string" ||
    message.body.length === 0 ||
    !author ||
    !hasExactKeys(message, ["messageId", "createdAtMs", "deleted", "body", "author"])
  ) {
    return null;
  }
  return {
    messageId: message.messageId,
    createdAtMs: message.createdAtMs,
    deleted: false,
    body: message.body,
    author,
  };
}

function discussionOrder(
  left: PublicDiscussionMessage,
  right: PublicDiscussionMessage,
): number {
  if (left.createdAtMs !== right.createdAtMs) {
    return left.createdAtMs - right.createdAtMs;
  }
  return left.messageId < right.messageId
    ? -1
    : left.messageId > right.messageId
      ? 1
      : 0;
}

export function parseDiscussionPage(
  value: unknown,
  direction: "oldest-first" | "newest-first" = "oldest-first",
): PublicDiscussionPage | null {
  const page = record(value);
  if (
    !page ||
    !hasExactKeys(page, [
      "ok",
      "messages",
      "nextCursor",
      "activityRevision",
      "profileName",
    ]) ||
    page.ok !== true ||
    !Array.isArray(page.messages) ||
    !isRevision(page.activityRevision) ||
    (page.profileName !== null &&
      (typeof page.profileName !== "string" || page.profileName.length === 0)) ||
    (page.nextCursor !== null &&
      (typeof page.nextCursor !== "string" ||
        !/^[A-Za-z0-9_-]{1,1024}$/u.test(page.nextCursor)))
  ) {
    return null;
  }
  const messages: PublicDiscussionMessage[] = [];
  for (const rawMessage of page.messages) {
    const message = discussionMessage(rawMessage);
    if (!message) return null;
    if (messages.length > 0) {
      const order = discussionOrder(messages.at(-1)!, message);
      if (direction === "newest-first" ? order <= 0 : order >= 0) return null;
    }
    messages.push(message);
  }
  if (direction === "newest-first") messages.reverse();
  return {
    messages,
    nextCursor: page.nextCursor as string | null,
    activityRevision: page.activityRevision,
    profileName: page.profileName as string | null,
  };
}

function isRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function parseDiscussionActivity(value: unknown): PublicDiscussionActivity | null {
  const activity = record(value);
  if (
    !activity ||
    !hasExactKeys(activity, [
      "ok",
      "access",
      "latestRevision",
      "cursorRevision",
      "hasMore",
      "messages",
      "composerState",
    ]) ||
    activity.ok !== true ||
    (activity.access !== "view" && activity.access !== "comment") ||
    !isRevision(activity.latestRevision) ||
    !isRevision(activity.cursorRevision) ||
    activity.cursorRevision > activity.latestRevision ||
    typeof activity.hasMore !== "boolean" ||
    (activity.hasMore
      ? activity.cursorRevision >= activity.latestRevision
      : activity.cursorRevision !== activity.latestRevision) ||
    !Array.isArray(activity.messages) ||
    (activity.composerState !== "available" &&
      activity.composerState !== "blocked" &&
      activity.composerState !== "paused")
  ) {
    return null;
  }
  const messages: PublicDiscussionMessage[] = [];
  for (const rawMessage of activity.messages) {
    const message = discussionMessage(rawMessage);
    if (!message || (messages.length > 0 && discussionOrder(messages.at(-1)!, message) >= 0)) {
      return null;
    }
    messages.push(message);
  }
  return {
    access: activity.access,
    latestRevision: activity.latestRevision,
    cursorRevision: activity.cursorRevision,
    hasMore: activity.hasMore,
    messages,
    composerState: activity.composerState,
  };
}

export function parseDiscussionAppendResult(value: unknown): DiscussionAppendResult | null {
  const result = record(value);
  if (!result || result.ok !== true || !hasExactKeys(result, ["ok", "message"])) {
    return null;
  }
  const message = discussionMessage(result.message);
  if (!message) return null;
  if (message.deleted) return { kind: "deleted", message };
  if (message.author.kind !== "link") return null;
  return { kind: "live", message: { ...message, author: message.author } };
}

export function parseDiscussionWriteState(
  value: unknown,
): "blocked" | "paused" | "limit-reached" | null {
  const result = record(value);
  if (
    !result ||
    result.ok !== false ||
    !hasExactKeys(result, ["ok", "state"])
  ) {
    return null;
  }
  if (
    result.state === "blocked" ||
    result.state === "paused" ||
    result.state === "limit-reached"
  ) {
    return result.state;
  }
  return null;
}

function sameDiscussionMessage(
  left: PublicDiscussionMessage,
  right: PublicDiscussionMessage,
): boolean {
  if (
    left.messageId !== right.messageId ||
    left.createdAtMs !== right.createdAtMs ||
    left.deleted !== right.deleted
  ) {
    return false;
  }
  if (left.deleted || right.deleted) return left.deleted && right.deleted;
  return left.body === right.body &&
    left.author.kind === right.author.kind &&
    left.author.displayName === right.author.displayName &&
    (left.author.kind === "named" ||
      (right.author.kind === "link" && right.author.unverified === true));
}

export function mergeDiscussionMessages(
  current: readonly PublicDiscussionMessage[],
  incoming: readonly PublicDiscussionMessage[],
): PublicDiscussionMessage[] | null {
  const merged = [...current];
  const known = new Map(merged.map((message) => [message.messageId, message]));
  let needsSort = false;
  for (const message of incoming) {
    const existing = known.get(message.messageId);
    if (!existing) {
      known.set(message.messageId, message);
      merged.push(message);
      needsSort = true;
      continue;
    }
    if (sameDiscussionMessage(existing, message)) continue;
    if (
      existing.deleted &&
      !message.deleted &&
      existing.createdAtMs === message.createdAtMs
    ) {
      continue;
    }
    if (
      !existing.deleted &&
      message.deleted &&
      existing.createdAtMs === message.createdAtMs
    ) {
      const existingIndex = merged.indexOf(existing);
      if (existingIndex === -1) return null;
      merged[existingIndex] = message;
      known.set(message.messageId, message);
      continue;
    }
    return null;
  }
  if (needsSort) merged.sort(discussionOrder);
  return merged;
}

export function mergeDiscussionWindowMessages(
  current: readonly PublicDiscussionMessage[],
  incoming: readonly PublicDiscussionMessage[],
): {
  messages: PublicDiscussionMessage[];
  withheldTombstones: DeletedDiscussionMessage[];
} | null {
  const loadedIds = new Set(current.map((message) => message.messageId));
  const visible: PublicDiscussionMessage[] = [];
  const withheldTombstones: DeletedDiscussionMessage[] = [];
  for (const message of incoming) {
    if (loadedIds.has(message.messageId) || !message.deleted) {
      visible.push(message);
    } else {
      withheldTombstones.push(message);
    }
  }
  const messages = mergeDiscussionMessages(current, visible);
  return messages === null ? null : { messages, withheldTombstones };
}

function storedFile(value: unknown): SharedFile | null {
  const payload = record(value);
  if (!payload) return null;
  const path = payload.path;
  const blobSha256 = payload.blobSha256;
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    typeof blobSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(blobSha256)
  ) {
    return null;
  }
  return {
    path,
    blobSha256,
    contentKind: payload.contentKind === "binary" ? "binary" : "text",
  };
}

export function accumulatorFromCurrentFiles(value: unknown): FileAccumulator | null {
  if (!Array.isArray(value)) return null;
  const files: FileAccumulator = new Map();
  for (const rawFile of value) {
    const file = storedFile(rawFile);
    if (!file || files.has(file.path)) return null;
    files.set(file.path, file);
  }
  return files;
}

function path(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function blobSha256(value: unknown): string | null {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value)
    ? value
    : null;
}

export function foldLogOps(
  files: FileAccumulator,
  ops: readonly RelayOp[],
): void {
  for (const op of ops) {
    const payload = record(op.payload);
    if (!payload) continue;
    if (op.opKind === "version.create" && Array.isArray(payload.forkSnapshots)) {
      for (const snapshot of payload.forkSnapshots) {
        const file = storedFile(snapshot);
        if (file && !files.has(file.path)) files.set(file.path, file);
      }
      continue;
    }
    if (op.opKind !== "moment.append") continue;
    if (!matchesOperation(payload.operation)) continue;
    const rawBeforePath = payload.payloadBeforePath;
    const rawBeforeBlobSha256 = payload.payloadBeforeBlobSha256;
    const hasNoBefore =
      (rawBeforePath === null || rawBeforePath === undefined) &&
      (rawBeforeBlobSha256 === null || rawBeforeBlobSha256 === undefined);
    const beforePath = path(rawBeforePath);
    const beforeBlobSha256 = blobSha256(rawBeforeBlobSha256);
    const before = beforePath && beforeBlobSha256
      ? { path: beforePath, blobSha256: beforeBlobSha256 }
      : null;
    if (!hasNoBefore && !before) continue;

    if (payload.operation === "delete") {
      if (!before) continue;
      const current = files.get(before.path);
      if (!current || current.blobSha256 !== before.blobSha256) continue;
      files.delete(before.path);
      continue;
    }

    const afterPath = path(payload.payloadAfterPath);
    const afterBlobSha256 = blobSha256(payload.payloadAfterBlobSha256);
    if (!afterPath || !afterBlobSha256) continue;
    if (hasNoBefore) {
      if (files.has(afterPath)) continue;
    } else {
      if (!before) continue;
      const current = files.get(before.path);
      if (current) {
        if (current.blobSha256 !== before.blobSha256) continue;
        if (before.path !== afterPath && files.has(afterPath)) continue;
        if (before.path !== afterPath) files.delete(before.path);
      } else if (files.has(afterPath)) {
        continue;
      }
    }
    files.set(afterPath, {
      path: afterPath,
      blobSha256: afterBlobSha256,
      contentKind: payload.payloadAfterContentKind === "binary" ? "binary" : "text",
    });
  }
}

function matchesOperation(value: unknown): value is "write" | "rename" | "delete" {
  return value === "write" || value === "rename" || value === "delete";
}

export function filesFromAccumulator(
  files: ReadonlyMap<string, SharedFile>,
): SharedFile[] {
  return [...files.values()].sort((left, right) => left.path.localeCompare(right.path));
}

export function filesFromLog(ops: readonly RelayOp[]): SharedFile[] {
  const files: FileAccumulator = new Map();
  foldLogOps(files, ops);
  return filesFromAccumulator(files);
}

export function isMarkdown(path: string): boolean {
  return /\.(?:md|markdown)$/iu.test(path);
}

export function isExcalidraw(path: string): boolean {
  return /\.excalidraw$/iu.test(path);
}

export function isRasterImage(path: string): boolean {
  return /\.(?:gif|jpe?g|png|webp)$/iu.test(path);
}

export function isSvg(path: string): boolean {
  return /\.svg$/iu.test(path);
}

export function resolveSharedFile(
  href: string,
  currentPath: string,
  files: ReadonlyMap<string, SharedFile>,
): SharedFile | null {
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/iu.test(href)) return null;
  try {
    const base = new URL(currentPath, "https://share.invalid/");
    const resolved = new URL(href, base);
    if (resolved.origin !== "https://share.invalid" || resolved.search || resolved.hash) {
      return null;
    }
    const path = decodeURIComponent(resolved.pathname).replace(/^\/+/, "");
    return files.get(path) ?? null;
  } catch {
    return null;
  }
}

export function resolveSharedImage(
  href: string,
  currentPath: string,
  files: ReadonlyMap<string, SharedFile>,
  session: string,
): string | null {
  const blobMatch =
    /^\/api\/view\/blob\/([a-f0-9]{64})(?:\?session=[A-Za-z0-9_-]{12})?$/u.exec(href);
  if (blobMatch) return `/api/view/blob/${blobMatch[1]}?session=${session}`;
  const file = resolveSharedFile(href, currentPath, files);
  return file && isRasterImage(file.path)
    ? `/api/view/blob/${file.blobSha256}?session=${session}`
    : null;
}
