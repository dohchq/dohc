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
    const beforePath =
      typeof payload.payloadBeforePath === "string" ? payload.payloadBeforePath : null;
    const currentPath = typeof payload.path === "string" ? payload.path : null;
    if (payload.operation === "delete") {
      if (beforePath) files.delete(beforePath);
      if (currentPath) files.delete(currentPath);
      continue;
    }
    const afterPath =
      typeof payload.payloadAfterPath === "string" ? payload.payloadAfterPath : null;
    const blobSha256 = payload.payloadAfterBlobSha256;
    if (!afterPath || typeof blobSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(blobSha256)) {
      continue;
    }
    if (beforePath && beforePath !== afterPath) files.delete(beforePath);
    files.set(afterPath, {
      path: afterPath,
      blobSha256,
      contentKind: payload.payloadAfterContentKind === "binary" ? "binary" : "text",
    });
  }
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
