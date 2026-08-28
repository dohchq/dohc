export interface PublicExcalidrawScene {
  elements: Record<string, unknown>[];
  appState: {
    gridSize: null;
    viewBackgroundColor: string;
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function parsePublicExcalidrawScene(
  text: string,
): PublicExcalidrawScene | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const scene = record(parsed);
  if (scene?.type !== "excalidraw" || !Array.isArray(scene.elements)) {
    return null;
  }
  const elements: Record<string, unknown>[] = [];
  for (const value of scene.elements) {
    const element = record(value);
    if (!element || typeof element.type !== "string") return null;
    if (element.type === "embeddable" || element.type === "iframe") continue;
    elements.push({ ...element, link: null });
  }
  const appState = record(scene.appState);
  const viewBackgroundColor =
    typeof appState?.viewBackgroundColor === "string" &&
      /^#[a-f0-9]{6}$/iu.test(appState.viewBackgroundColor)
      ? appState.viewBackgroundColor
      : "#ffffff";
  return {
    elements,
    appState: { gridSize: null, viewBackgroundColor },
  };
}
