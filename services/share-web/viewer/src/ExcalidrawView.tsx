import {
  Excalidraw,
  restore,
} from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import { useMemo } from "react";
import type { ExcalidrawInitialDataState } from "@excalidraw/excalidraw/types";
import type { PublicExcalidrawScene } from "./excalidraw";

export default function ExcalidrawView(props: { scene: PublicExcalidrawScene }) {
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

  return (
    <div className="excalidraw-view">
      <Excalidraw
        initialData={initialData}
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
    </div>
  );
}
