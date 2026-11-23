import { Excalidraw, restore } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
} from "@excalidraw/excalidraw/types";
import type { PublicExcalidrawScene } from "./excalidraw";
import { Icon } from "./icons";

const DARK_MEDIA = "(prefers-color-scheme: dark)";
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 4;

type ZoomValue = ReturnType<ExcalidrawImperativeAPI["getAppState"]>["zoom"]["value"];

function usePrefersDark(): boolean {
  const [dark, setDark] = useState(() => window.matchMedia?.(DARK_MEDIA).matches ?? false);
  useEffect(() => {
    const query = window.matchMedia?.(DARK_MEDIA);
    if (!query) return;
    const update = () => setDark(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return dark;
}

export default function ExcalidrawView(props: { scene: PublicExcalidrawScene }) {
  const dark = usePrefersDark();
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const initialData = useMemo(() => {
    const restored = restore(
      {
        elements: props.scene.elements,
        appState: props.scene.appState,
        files: {},
      } as unknown as ExcalidrawInitialDataState,
      null,
      null,
      { repairBindings: true },
    );
    return {
      ...restored,
      files: {},
      scrollToContent: true,
    } satisfies ExcalidrawInitialDataState;
  }, [props.scene]);

  const handleApi = useCallback((instance: ExcalidrawImperativeAPI) => {
    apiRef.current = instance;
    setApi(instance);
  }, []);

  const fitView = useCallback(() => {
    apiRef.current?.scrollToContent(undefined, {
      fitToViewport: true,
      viewportZoomFactor: 0.9,
      minZoom: MIN_ZOOM,
      maxZoom: 1,
    });
  }, []);

  useEffect(() => {
    if (!api) return;
    const frame = window.requestAnimationFrame(() => fitView());
    return () => window.cancelAnimationFrame(frame);
  }, [api, fitView]);

  const stepZoom = (factor: number) => {
    const current = apiRef.current;
    if (!current) return;
    const { zoom, scrollX, scrollY, width, height } = current.getAppState();
    const currentZoom = zoom.value;
    const value = (
      factor < 1
        ? Math.min(currentZoom, Math.max(MIN_ZOOM, currentZoom * factor))
        : Math.max(currentZoom, Math.min(MAX_ZOOM, currentZoom * factor))
    ) as ZoomValue;
    if (value === currentZoom) return;
    const delta = 1 / value - 1 / currentZoom;
    current.updateScene({
      appState: {
        zoom: { value },
        scrollX: scrollX + (width / 2) * delta,
        scrollY: scrollY + (height / 2) * delta,
      },
    });
  };

  return (
    <div className="excalidraw-view">
      <Excalidraw
        initialData={initialData}
        excalidrawAPI={handleApi}
        theme={dark ? "dark" : "light"}
        viewModeEnabled
        autoFocus={false}
        aiEnabled={false}
        validateEmbeddable={() => false}
        renderEmbeddable={() => null}
        onLinkOpen={(_element, event) => event.preventDefault()}
        UIOptions={{
          canvasActions: {
            loadScene: false,
            saveToActiveFile: false,
            export: false,
          },
        }}
      />
      <div className="excalidraw-controls" role="group" aria-label="Drawing zoom">
        <button
          type="button"
          className="icon-button"
          aria-label="Zoom out"
          onClick={() => stepZoom(0.8)}
        >
          <Icon name="minus" size={16} />
        </button>
        <button type="button" className="icon-button" aria-label="Reset view" onClick={fitView}>
          <Icon name="refresh" size={15} />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="Zoom in"
          onClick={() => stepZoom(1.25)}
        >
          <Icon name="plus" size={16} />
        </button>
      </div>
    </div>
  );
}
