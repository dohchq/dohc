export type ShareAccess = "view";

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

export type FileAccumulator = Map<string, SharedFile>;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
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
        if (file) files.set(file.path, file);
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
