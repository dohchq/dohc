export type ExcalidrawDocument = {
  type: "excalidraw";
  version?: number;
  source?: string;
  elements: unknown[];
  appState: Record<string, unknown>;
  files: Record<string, unknown>;
};

// The ordinary New file flow creates an empty file first. Treat that exact
// state as a new blank drawing, then let the guarded autosave write this
// portable document through the same path as the first canvas change.
export const EMPTY_EXCALIDRAW_DOCUMENT = JSON.stringify(
  {
    type: "excalidraw",
    version: 2,
    source: "dohc",
    elements: [],
    appState: {
      gridSize: null,
      viewBackgroundColor: "#ffffff",
    },
    files: {},
  },
  null,
  2,
);

function objectRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function parseExcalidrawDocument(text: string): ExcalidrawDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("The drawing is not valid JSON.");
  }

  const document = objectRecord(parsed);
  if (!document || document.type !== "excalidraw") {
    throw new Error("The file is not an Excalidraw drawing.");
  }
  if (document.elements !== undefined && !Array.isArray(document.elements)) {
    throw new Error("The drawing has an invalid elements list.");
  }
  const appState =
    document.appState === undefined ? {} : objectRecord(document.appState);
  if (!appState) {
    throw new Error("The drawing has invalid app state.");
  }
  const files = document.files === undefined ? {} : objectRecord(document.files);
  if (!files) {
    throw new Error("The drawing has invalid embedded files.");
  }

  return {
    type: "excalidraw",
    ...(typeof document.version === "number"
      ? { version: document.version }
      : {}),
    ...(typeof document.source === "string" ? { source: document.source } : {}),
    elements: document.elements ?? [],
    appState,
    files,
  };
}
