import {
  Excalidraw,
  restore,
  serializeAsJSON,
} from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import { useMemo, useRef } from "react";
import type { ExcalidrawInitialDataState } from "@excalidraw/excalidraw/types";
import type { ExcalidrawDocument } from "./excalidrawDocument";
import { bridge } from "./bridge";

export type ExcalidrawCanvasProps = {
  document: ExcalidrawDocument;
  readOnly: boolean;
  onChange?: (serialized: string) => void;
};

export default function ExcalidrawCanvas(props: ExcalidrawCanvasProps) {
  // Restore once here so our first serialized snapshot matches the normalized
  // scene Excalidraw mounts. Opening an old but valid file must not rewrite it
  // until the scene actually changes.
  const initial = useMemo(() => {
    const restored = restore(
      props.document as ExcalidrawInitialDataState,
      null,
      null,
      { repairBindings: true },
    );
    return {
      scene: {
        ...restored,
        scrollToContent: true,
      },
      serialized: serializeAsJSON(
        restored.elements,
        restored.appState,
        restored.files,
        "local",
      ),
    };
  }, [props.document]);
  const lastSerialized = useRef(initial.serialized);

  return (
    <div className="absolute inset-0" data-testid="excalidraw-canvas">
      <Excalidraw
        initialData={initial.scene}
        viewModeEnabled={props.readOnly}
        autoFocus={!props.readOnly}
        aiEnabled={false}
        validateEmbeddable={false}
        onLinkOpen={(element, event) => {
          // Excalidraw otherwise calls window.open, which the desktop shell
          // denies. Keep navigation inside dohc's audited URL bridge.
          event.preventDefault();
          if (!element.link) return;
          void bridge()
            .openExternalUrl({ url: element.link })
            .catch(() => undefined);
        }}
        UIOptions={{
          canvasActions: {
            loadScene: false,
            saveToActiveFile: false,
            export: false,
          },
        }}
        onChange={
          props.readOnly
            ? undefined
            : (elements, appState, files) => {
                const serialized = serializeAsJSON(
                  elements,
                  appState,
                  files,
                  "local",
                );
                if (serialized === lastSerialized.current) return;
                lastSerialized.current = serialized;
                props.onChange?.(serialized);
              }
        }
      />
    </div>
  );
}
