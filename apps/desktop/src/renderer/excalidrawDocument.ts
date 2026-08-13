import { assertRestorableElement } from "@dohc/excalidraw-scene";

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

function validateEmbeddedFiles(files: Record<string, unknown>): void {
  for (const value of Object.values(files)) {
    const file = objectRecord(value);
    if (
      !file ||
      (file.dataURL !== undefined && typeof file.dataURL !== "string") ||
      (file.mimeType !== undefined && typeof file.mimeType !== "string")
    ) {
      throw new Error("The drawing has an invalid embedded file.");
    }
  }
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
  const elements = document.elements ?? [];
  elements.forEach(assertRestorableElement);
  const appState =
    document.appState === undefined ? {} : objectRecord(document.appState);
  if (!appState) {
    throw new Error("The drawing has invalid app state.");
  }
  if (appState.activeTool !== undefined && !objectRecord(appState.activeTool)) {
    // restoreAppState reads `activeTool.type` and `activeTool.locked` directly.
    throw new Error("The drawing has an invalid active tool.");
  }
  const files = document.files === undefined ? {} : objectRecord(document.files);
  if (!files) {
    throw new Error("The drawing has invalid embedded files.");
  }
  validateEmbeddedFiles(files);

  return {
    type: "excalidraw",
    ...(typeof document.version === "number"
      ? { version: document.version }
      : {}),
    ...(typeof document.source === "string" ? { source: document.source } : {}),
    elements,
    appState,
    files,
  };
}
