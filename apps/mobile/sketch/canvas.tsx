import {
  EXCALIDRAW_EXPORTABLE_APP_STATE,
  revisionKey,
  stableJson,
  type ElementSnapshot,
  type JsonObject,
  type JsonValue,
} from "@dohc/excalidraw-scene";
import { CaptureUpdateAction, Excalidraw, MainMenu, restore } from "@excalidraw/excalidraw";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  BinaryFileData,
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
} from "@excalidraw/excalidraw/types";

interface SketchPayload {
  elements: ElementSnapshot[];
  appState: JsonObject;
  files: Record<string, BinaryFileData>;
  readOnly: boolean;
  theme: "light" | "dark";
}

interface SketchHostWindow extends Window {
  ReactNativeWebView?: { postMessage?: (message: string) => void };
  __dohcSketchLoad?: (payload: SketchPayload) => void;
  __dohcSketchApplySaved?: (payload: SketchPayload) => void;
  __dohcSketchCollect?: (token: number) => void;
  __dohcSketchTheme?: (theme: "light" | "dark") => void;
}

const host = window as SketchHostWindow;
const post = (kind: string, payload: Record<string, unknown> = {}) =>
  host.ReactNativeWebView?.postMessage?.(JSON.stringify({ kind, ...payload }));

function snapshot(elements: readonly ElementSnapshot[], appState: Record<string, unknown>) {
  const el = new Map<string, string>();
  for (const e of elements) {
    if (!e.isDeleted) el.set(e.id, revisionKey(e.id, e.version, e.versionNonce));
  }
  const state = new Map<string, string>();
  for (const key of EXCALIDRAW_EXPORTABLE_APP_STATE) {
    if (appState[key] !== undefined) state.set(key, stableJson(appState[key]));
  }
  return { elements: el, appState: state };
}

function collectDelta(
  elements: readonly ElementSnapshot[],
  appState: Record<string, unknown>,
  base: { elements: ReadonlyMap<string, string>; appState: ReadonlyMap<string, string> },
) {
  const changedElements: ElementSnapshot[] = [];
  for (const e of elements) {
    if (e.type === "text" && e.isDeleted !== true && (typeof e.text !== "string" || !e.text))
      continue;
    const prev = base.elements.get(e.id);
    if (prev === undefined && e.isDeleted) continue;
    if (prev !== revisionKey(e.id, e.version, e.versionNonce)) {
      changedElements.push(JSON.parse(JSON.stringify(e)) as ElementSnapshot);
    }
  }
  const changedAppState: Record<string, JsonValue> = {};
  for (const key of EXCALIDRAW_EXPORTABLE_APP_STATE) {
    if (appState[key] === undefined) continue;
    const normalized = JSON.parse(JSON.stringify(appState[key])) as JsonValue;
    if (base.appState.get(key) !== stableJson(normalized)) changedAppState[key] = normalized;
  }
  return { elements: changedElements, appState: changedAppState };
}

function restoreScene(payload: SketchPayload) {
  const r = restore(
    {
      elements: payload.elements,
      appState: payload.appState,
      files: payload.files,
    } as unknown as ExcalidrawInitialDataState,
    null,
    null,
    { repairBindings: true },
  );
  return {
    elements: r.elements as unknown as ElementSnapshot[],
    appState: r.appState as unknown as Record<string, unknown>,
    files: r.files ?? payload.files,
  };
}

function SketchCanvas() {
  const [loaded, setLoaded] = useState<{
    mount: number;
    readOnly: boolean;
    scene: ReturnType<typeof restoreScene>;
  } | null>(null);
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const baseRef = useRef(snapshot([], {}));
  const dirtyRef = useRef(false);
  const paintedMountRef = useRef(0);
  const readOnlyRef = useRef(true);
  readOnlyRef.current = loaded?.readOnly ?? true;

  const setDirty = (next: boolean) => {
    if (dirtyRef.current === next) return;
    dirtyRef.current = next;
    post("dirty", { dirty: next });
  };

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    host.__dohcSketchLoad = (next) => {
      const scene = restoreScene(next);
      baseRef.current = snapshot(scene.elements, scene.appState);
      setDirty(false);
      setTheme(next.theme);
      setLoaded((prev) => ({ mount: (prev?.mount ?? 0) + 1, readOnly: next.readOnly, scene }));
    };
    host.__dohcSketchTheme = (next) => setTheme(next);
    host.__dohcSketchApplySaved = (next) => {
      const scene = restoreScene(next);
      baseRef.current = snapshot(scene.elements, scene.appState);
      setDirty(false);
      const api = apiRef.current;
      if (!api) return;
      const files = Object.values(scene.files);
      if (files.length > 0) api.addFiles(files);
      const appState = Object.fromEntries(
        EXCALIDRAW_EXPORTABLE_APP_STATE.flatMap((k) =>
          scene.appState[k] === undefined ? [] : [[k, scene.appState[k]]],
        ),
      );
      api.updateScene({
        elements: scene.elements as unknown as Parameters<
          ExcalidrawImperativeAPI["updateScene"]
        >[0]["elements"],
        appState: appState as unknown as Parameters<
          ExcalidrawImperativeAPI["updateScene"]
        >[0]["appState"],
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    };
    host.__dohcSketchCollect = (token) => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      requestAnimationFrame(() => {
        const api = apiRef.current;
        if (!api) return post("collected", { token, elements: [], appState: {} });
        const delta = collectDelta(
          api.getSceneElementsIncludingDeleted() as unknown as ElementSnapshot[],
          api.getAppState() as unknown as Record<string, unknown>,
          baseRef.current,
        );
        post("collected", { token, ...delta });
      });
    };
    post("started");
  }, []);

  if (!loaded) return null;
  const initialData = {
    ...loaded.scene,
    scrollToContent: loaded.scene.elements.length > 0,
  } as unknown as ExcalidrawInitialDataState;

  return (
    <div style={{ position: "fixed", inset: 0 }}>
      <Excalidraw
        key={loaded.mount}
        initialData={initialData}
        theme={theme}
        viewModeEnabled={loaded.readOnly}
        autoFocus={false}
        aiEnabled={false}
        validateEmbeddable={false}
        onLinkOpen={(_element, event) => event.preventDefault()}
        excalidrawAPI={(api) => {
          apiRef.current = api;
          if (paintedMountRef.current === loaded.mount) return;
          paintedMountRef.current = loaded.mount;
          const files = Object.values(loaded.scene.files);
          if (files.length > 0) api.addFiles(files);
          post("painted");
        }}
        UIOptions={{
          canvasActions: {
            loadScene: false,
            saveToActiveFile: false,
            export: false,
            toggleTheme: false,
          },
          tools: { image: false },
        }}
        onChange={
          loaded.readOnly
            ? undefined
            : (elements, appState) => {
                if (readOnlyRef.current) return;
                const delta = collectDelta(
                  elements as unknown as ElementSnapshot[],
                  appState as unknown as Record<string, unknown>,
                  baseRef.current,
                );
                setDirty(delta.elements.length > 0 || Object.keys(delta.appState).length > 0);
              }
        }
      >
        {loaded.readOnly ? null : (
          <MainMenu>
            <MainMenu.DefaultItems.ClearCanvas />
            <MainMenu.DefaultItems.ChangeCanvasBackground />
          </MainMenu>
        )}
      </Excalidraw>
    </div>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<SketchCanvas />);
