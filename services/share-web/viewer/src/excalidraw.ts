import { asRecord } from "@dohc/workspace-core/records";
export interface PublicExcalidrawScene {
  elements: Record<string, unknown>[];
  appState: {
    gridSize: null;
    viewBackgroundColor: string;
  };
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
  const scene = asRecord(parsed);
  if (scene?.type !== "excalidraw" || !Array.isArray(scene.elements)) {
    return null;
  }
  const elements: Record<string, unknown>[] = [];
  for (const value of scene.elements) {
    const element = asRecord(value);
    if (!element || typeof element.type !== "string") return null;
    if (element.type === "embeddable" || element.type === "iframe") continue;
    elements.push({ ...element, link: null });
  }
  const appState = asRecord(scene.appState);
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
