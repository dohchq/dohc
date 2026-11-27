import {
  EXCALIDRAW_EXPORTABLE_APP_STATE,
  revisionKey,
  type ElementSnapshot,
  type JsonObject,
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
  preserved?: ElementSnapshot[];
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

function snapshot(elements: readonly ElementSnapshot[]) {
  const base = new Map<string, string>();
  for (const e of elements) {
    if (!e.isDeleted) base.set(e.id, revisionKey(e.id, e.version, e.versionNonce));
  }
  return base;
}

function isChangedElement(e: ElementSnapshot, base: ReadonlyMap<string, string>) {
  if (e.type === "text" && e.isDeleted !== true && (typeof e.text !== "string" || !e.text))
    return false;
  const prev = base.get(e.id);
  if (prev === undefined && e.isDeleted) return false;
  return prev !== revisionKey(e.id, e.version, e.versionNonce);
}

function collectDelta(elements: readonly ElementSnapshot[], base: ReadonlyMap<string, string>) {
  const changed: ElementSnapshot[] = [];
  for (const e of elements) {
    if (isChangedElement(e, base)) changed.push(JSON.parse(JSON.stringify(e)) as ElementSnapshot);
  }
  return changed;
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

function mergePreserved(
  remote: readonly ElementSnapshot[],
  preserved: readonly ElementSnapshot[] | undefined,
) {
  if (!preserved || preserved.length === 0) return remote;
  const byId = new Map(preserved.map((e) => [e.id, e]));
  const merged = remote.map((e) => {
    const kept = byId.get(e.id);
    if (!kept) return e;
    byId.delete(e.id);
    return kept;
  });
  for (const kept of byId.values()) merged.push(kept);
  return merged;
}

function SketchCanvas() {
  const [loaded, setLoaded] = useState<{
    mount: number;
    readOnly: boolean;
    scene: ReturnType<typeof restoreScene>;
  } | null>(null);
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const baseRef = useRef<Map<string, string>>(new Map());
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
      baseRef.current = snapshot(scene.elements);
      setDirty(false);
      setTheme(next.theme);
      setLoaded((prev) => ({ mount: (prev?.mount ?? 0) + 1, readOnly: next.readOnly, scene }));
    };
    host.__dohcSketchTheme = (next) => setTheme(next);
    host.__dohcSketchApplySaved = (next) => {
      const scene = restoreScene(next);
      baseRef.current = snapshot(scene.elements);
      const elements = mergePreserved(scene.elements, next.preserved);
      setDirty((next.preserved?.length ?? 0) > 0);
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
        elements: elements as unknown as Parameters<
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
        const elements = api
          ? collectDelta(
              api.getSceneElementsIncludingDeleted() as unknown as ElementSnapshot[],
              baseRef.current,
            )
          : [];
        post("collected", { token, elements });
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
            : (elements) => {
                if (readOnlyRef.current) return;
                const list = elements as unknown as readonly ElementSnapshot[];
                setDirty(list.some((e) => isChangedElement(e, baseRef.current)));
              }
        }
      >
        {loaded.readOnly ? null : (
          <MainMenu>
            <MainMenu.DefaultItems.ClearCanvas />
          </MainMenu>
        )}
      </Excalidraw>
    </div>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<SketchCanvas />);
