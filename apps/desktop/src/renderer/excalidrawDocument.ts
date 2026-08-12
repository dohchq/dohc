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

function validPoint(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    typeof value[0] === "number" &&
    Number.isFinite(value[0]) &&
    typeof value[1] === "number" &&
    Number.isFinite(value[1])
  );
}

function validFractionalIndex(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value !== "string" || !/^[0-9A-Za-z]+$/.test(value)) return false;

  const head = value[0];
  let integerLength = 0;
  if (head >= "a" && head <= "z") {
    integerLength = head.charCodeAt(0) - "a".charCodeAt(0) + 2;
  } else if (head >= "A" && head <= "Z") {
    integerLength = "Z".charCodeAt(0) - head.charCodeAt(0) + 2;
  }
  const fractionalPart = value.slice(integerLength);
  return (
    integerLength > 0 &&
    value.length >= integerLength &&
    value !== `A${"0".repeat(26)}` &&
    !fractionalPart.endsWith("0")
  );
}

function validateRestorableElement(value: unknown): void {
  const element = objectRecord(value);
  if (!element || typeof element.type !== "string" || element.type.length === 0) {
    throw new Error("The drawing has an invalid element.");
  }

  if (!validFractionalIndex(element.index)) {
    throw new Error("The drawing has an invalid element order.");
  }

  if (
    element.link !== undefined &&
    element.link !== null &&
    typeof element.link !== "string"
  ) {
    // Common-element restore normalizes a truthy link with `link.trim()`.
    throw new Error("The drawing has an invalid element link.");
  }

  if (element.type === "text") {
    // Legacy text restore calls `font.split(...)`. Height-based line-height
    // recovery also normalizes the original text before applying defaults.
    if ("font" in element && typeof element.font !== "string") {
      throw new Error("The drawing has an invalid text font.");
    }
    if (element.text !== undefined && typeof element.text !== "string") {
      throw new Error("The drawing has invalid text content.");
    }
  }

  if (
    element.boundElementIds !== undefined &&
    element.boundElementIds !== null &&
    !Array.isArray(element.boundElementIds)
  ) {
    // Legacy binding migration calls `boundElementIds.map(...)`.
    throw new Error("The drawing has invalid legacy element bindings.");
  }

  // Binding repair calls `.slice()` and then reads every binding's ID.
  if (element.boundElements !== undefined && element.boundElements !== null) {
    if (
      !Array.isArray(element.boundElements) ||
      element.boundElements.some((binding) => {
        const record = objectRecord(binding);
        return !record || typeof record.id !== "string";
      })
    ) {
      throw new Error("The drawing has invalid element bindings.");
    }
  }

  const requiresPoints =
    element.type === "line" ||
    element.type === "arrow" ||
    element.type === "freedraw";
  // Visibility checks read `.length` for linear and freedraw elements. Linear
  // restore also indexes the first two coordinate tuples directly.
  if (!Array.isArray(element.points)) {
    if (requiresPoints || element.points !== undefined) {
      throw new Error("The drawing has invalid element points.");
    }
  } else if (element.points.some((point) => !validPoint(point))) {
    throw new Error("The drawing has invalid element points.");
  }

  for (const key of ["startBinding", "endBinding"] as const) {
    const bindingValue = element[key];
    if (bindingValue === undefined || bindingValue === null) continue;
    const binding = objectRecord(bindingValue);
    if (
      !binding ||
      (binding.fixedPoint !== undefined &&
        binding.fixedPoint !== null &&
        !validPoint(binding.fixedPoint))
    ) {
      throw new Error("The drawing has an invalid point binding.");
    }
  }
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
  elements.forEach(validateRestorableElement);
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
