import { createHash } from "node:crypto";
import type {
  Actor,
  AtomKind,
  ImportDataRequest,
  WorkspaceBackend,
} from "@dohc/workspace-contracts";

type ImportSourceText = {
  name: string;
  mediaType: string;
  body: string;
};

type SqliteImportInput = {
  name: string;
  mediaType: string;
  body: string;
  tableName: string;
  mode?: "infer-schema" | "provided-schema";
  schema?: ImportDataRequest["schema"];
};

type SqliteImportOk = {
  ok: true;
  tableName: string;
  rowCount: number;
  sourceHash: string;
  tableSchema: Array<{
    name: string;
    type: string;
    primaryKey?: boolean;
    nullable?: boolean;
  }>;
  snapshot: unknown;
  operation: Record<string, unknown>;
  bytesBase64: string;
  size: number;
  sha256: string;
};

type SqliteImportResult =
  | SqliteImportOk
  | { ok: false; code: string; message: string };

export type ImportDataServiceOptions = {
  backend: WorkspaceBackend;
  actor: Actor;
  request: ImportDataRequest;
  sqlite?: {
    importData(input: SqliteImportInput): Promise<SqliteImportResult>;
  };
};

export type ImportDataResult =
  | {
      ok: true;
      target: ImportDataRequest["target"];
      sourceHash: string;
      rowCount?: number;
      operation?: Record<string, unknown>;
    }
  | {
      ok: false;
      code: string;
      message: string;
    };

export async function importData({
  backend,
  actor,
  request,
  sqlite,
}: ImportDataServiceOptions): Promise<ImportDataResult> {
  const source = await readSource(backend, actor, request);
  if (isImportSourceError(source)) return source;

  if (request.target.kind === "atom") {
    await backend.createAtom(actor, {
      path: request.target.path,
      kind: atomKindForContentType(request.target.contentType),
      body: source.body,
    });
    return {
      ok: true,
      target: request.target,
      sourceHash: sha256(source.body),
    };
  }

  if (request.target.kind === "sqlite") {
    if (!sqlite) {
      return {
        ok: false,
        code: "sqlite-import-unavailable",
        message: "SQLite import worker is not configured.",
      };
    }
    const imported = await sqlite.importData({
      name: source.name,
      mediaType: source.mediaType,
      body: source.body,
      tableName: request.target.tableName,
      mode: request.mode,
      schema: request.schema,
    });
    if (!imported.ok) return imported;
    await backend.saveAsset(actor, {
      path: request.target.path,
      kind: "sqlite",
      mediaType: "application/vnd.sqlite3",
      bytes: new Uint8Array(Buffer.from(imported.bytesBase64, "base64")),
    });
    return {
      ok: true,
      target: request.target,
      sourceHash: imported.sourceHash,
      rowCount: imported.rowCount,
      operation: imported.operation,
    };
  }

  return {
    ok: false,
    code: "unsupported-import-target",
    message: "Collection imports are not implemented by this backend yet.",
  };
}

async function readSource(
  backend: WorkspaceBackend,
  actor: Actor,
  request: ImportDataRequest,
): Promise<ImportSourceText | Extract<ImportDataResult, { ok: false }>> {
  if (request.source.kind === "inline") return request.source;
  if (request.source.kind === "atom") {
    const text = await backend.readText(actor, request.source.path);
    return {
      name: request.source.path.split("/").pop() ?? request.source.path,
      mediaType: mediaTypeForPath(request.source.path),
      body: text.body,
    };
  }
  const asset = await backend.readAsset(actor, request.source.path);
  if (!isTextImportMediaType(asset.mediaType, request.source.path)) {
    return {
      ok: false,
      code: "unsupported_media_type",
      message: `import source ${request.source.path} is not text-compatible: ${asset.mediaType}`,
    };
  }
  let body: string;
  try {
    body = new TextDecoder("utf-8", { fatal: true }).decode(asset.bytes);
  } catch (error) {
    return {
      ok: false,
      code: "invalid_text_encoding",
      message: `could not decode text import source ${request.source.path}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return {
    name: request.source.path.split("/").pop() ?? request.source.path,
    mediaType: asset.mediaType,
    body,
  };
}

function isTextImportMediaType(mediaType: string, path: string) {
  const lowerMediaType = mediaType.toLowerCase();
  const lowerPath = path.toLowerCase();
  return (
    lowerMediaType.startsWith("text/") ||
    lowerMediaType.includes("json") ||
    lowerMediaType.includes("csv") ||
    lowerMediaType.includes("markdown") ||
    lowerPath.endsWith(".md") ||
    lowerPath.endsWith(".markdown") ||
    lowerPath.endsWith(".txt") ||
    lowerPath.endsWith(".csv") ||
    lowerPath.endsWith(".json") ||
    lowerPath.endsWith(".jsonl")
  );
}

function isImportSourceError(
  source: ImportSourceText | Extract<ImportDataResult, { ok: false }>,
): source is Extract<ImportDataResult, { ok: false }> {
  return "ok" in source && source.ok === false;
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function atomKindForContentType(contentType: string): AtomKind {
  const lower = contentType.toLowerCase();
  if (lower.includes("csv")) return "csv";
  if (lower.includes("json")) return "json";
  if (lower.includes("html")) return "html";
  if (lower.includes("markdown")) return "markdown";
  return "text";
}

function mediaTypeForPath(path: string) {
  const lower = path.toLowerCase();
  if (lower.endsWith(".csv")) return "text/csv";
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".jsonl")) return "application/x-ndjson";
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) {
    return "text/markdown";
  }
  if (lower.endsWith(".pdf")) return "application/pdf";
  return "text/plain";
}
