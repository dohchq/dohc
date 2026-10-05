/** Display metadata only. Media types, read/write policy and live sessions have separate classifiers. */
export type FileDisplayKind =
  | "markdown"
  | "drawing"
  | "csv"
  | "json"
  | "text"
  | "image"
  | "audio"
  | "pdf"
  | "database"
  | "binary";

type KindGlyphId =
  | "file-text"
  | "file-spreadsheet"
  | "file-code"
  | "pen-tool"
  | "image"
  | "music"
  | "database"
  | "file";

type FileKindAction =
  | "open"
  | "move-tab-to-new-group"
  | "copy-path"
  | "show-in-explorer"
  | "open-history"
  | "rename"
  | "delete"
  | "pin"
  | "unpin"
  | "share"
  | "export-zip"
  | "open-externally"
  | "copy-markdown"
  | "export-markdown"
  | "export-html"
  | "export-pdf";

export interface FileKindRecord {
  readonly displayKind: FileDisplayKind;
  readonly glyphId: KindGlyphId;
  readonly displayNameRule: "basename";
  readonly extensions: readonly string[];
  readonly opens: {
    readonly surface: "tab";
    readonly view: FileDisplayKind;
    readonly content: "text" | "asset" | "database" | "unsupported";
  };
  /** Candidate actions; handlers and menus still decide availability and authority. */
  readonly actions: readonly FileKindAction[];
  /** References carry workspaceId and path as a locator, not durable identity or authority. */
  readonly reference: { readonly shape: "workspace-path" };
}

const FILE_ACTIONS = [
  "open", "move-tab-to-new-group", "copy-path", "show-in-explorer", "open-history",
  "rename", "delete", "pin", "unpin", "share",
  "export-zip", "open-externally",
] as const satisfies readonly FileKindAction[];
const FILE_REFERENCE = { shape: "workspace-path" } as const;

export const FILE_KIND_RECORDS = {
  markdown: {
    displayKind: "markdown", glyphId: "file-text", displayNameRule: "basename",
    extensions: ["md", "markdown"],
    opens: { surface: "tab", view: "markdown", content: "text" },
    actions: [...FILE_ACTIONS, "copy-markdown", "export-markdown", "export-html", "export-pdf"],
    reference: FILE_REFERENCE,
  },
  drawing: {
    displayKind: "drawing", glyphId: "pen-tool", displayNameRule: "basename",
    extensions: ["excalidraw"],
    opens: { surface: "tab", view: "drawing", content: "text" },
    actions: FILE_ACTIONS, reference: FILE_REFERENCE,
  },
  csv: {
    displayKind: "csv", glyphId: "file-spreadsheet", displayNameRule: "basename",
    extensions: ["csv", "tsv", "tab"],
    opens: { surface: "tab", view: "csv", content: "text" },
    actions: FILE_ACTIONS, reference: FILE_REFERENCE,
  },
  json: {
    displayKind: "json", glyphId: "file-code", displayNameRule: "basename",
    extensions: ["json"],
    opens: { surface: "tab", view: "json", content: "text" },
    actions: FILE_ACTIONS, reference: FILE_REFERENCE,
  },
  text: {
    displayKind: "text", glyphId: "file-code", displayNameRule: "basename",
    extensions: [
      "txt", "html", "htm", "xml", "css", "scss", "sass", "less", "js", "jsx",
      "ts", "tsx", "mjs", "cjs", "yaml", "yml", "toml", "ini", "env", "log",
      "sql", "sh", "bash", "zsh", "ps1", "py", "rb", "go", "rs", "java", "c",
      "cpp", "h", "hpp",
    ],
    opens: { surface: "tab", view: "text", content: "text" },
    actions: FILE_ACTIONS, reference: FILE_REFERENCE,
  },
  image: {
    displayKind: "image", glyphId: "image", displayNameRule: "basename",
    extensions: ["png", "jpg", "jpeg", "webp", "gif", "svg"],
    opens: { surface: "tab", view: "image", content: "asset" },
    actions: FILE_ACTIONS, reference: FILE_REFERENCE,
  },
  audio: {
    displayKind: "audio", glyphId: "music", displayNameRule: "basename",
    extensions: ["m4a", "mp3", "wav", "ogg"],
    opens: { surface: "tab", view: "audio", content: "asset" },
    actions: FILE_ACTIONS, reference: FILE_REFERENCE,
  },
  pdf: {
    displayKind: "pdf", glyphId: "file-text", displayNameRule: "basename",
    extensions: ["pdf"],
    opens: { surface: "tab", view: "pdf", content: "asset" },
    actions: FILE_ACTIONS, reference: FILE_REFERENCE,
  },
  database: {
    displayKind: "database", glyphId: "database", displayNameRule: "basename",
    extensions: ["sqlite", "sqlite3", "db"],
    opens: { surface: "tab", view: "database", content: "database" },
    actions: FILE_ACTIONS, reference: FILE_REFERENCE,
  },
  binary: {
    displayKind: "binary", glyphId: "file", displayNameRule: "basename",
    extensions: [],
    opens: { surface: "tab", view: "binary", content: "unsupported" },
    actions: FILE_ACTIONS, reference: FILE_REFERENCE,
  },
} as const satisfies {
  [Kind in FileDisplayKind]: FileKindRecord & {
    readonly displayKind: Kind;
    readonly opens: FileKindRecord["opens"] & { readonly view: Kind };
  };
};

const KIND_BY_EXTENSION = new Map<string, FileKindRecord>(
  Object.values(FILE_KIND_RECORDS).flatMap((record) =>
    record.extensions.map((extension) => [extension, record] as const),
  ),
);

/** Preserves the renderer's last-dot classification, including dotfiles. */
export function fileKindForPath(path: string): FileKindRecord {
  const dot = path.lastIndexOf(".");
  const extension = dot === -1 ? "" : path.slice(dot + 1).toLowerCase();
  return KIND_BY_EXTENSION.get(extension) ?? FILE_KIND_RECORDS.binary;
}
