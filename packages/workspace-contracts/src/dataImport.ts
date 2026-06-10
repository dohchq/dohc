export type ImportSource =
  | { kind: "asset"; path: string }
  | { kind: "atom"; path: string }
  | { kind: "inline"; name: string; mediaType: string; body: string };

export type ImportTarget =
  | { kind: "atom"; path: string; contentType: string }
  | { kind: "sqlite"; path: string; tableName: string }
  | { kind: "collection"; path: string };

export type ImportDataRequest = {
  source: ImportSource;
  target: ImportTarget;
  mode: "infer-schema" | "provided-schema";
  schema?: Record<
    string,
    "text" | "integer" | "real" | "boolean" | "datetime"
  >;
};
