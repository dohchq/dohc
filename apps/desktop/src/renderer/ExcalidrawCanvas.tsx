import {
  CaptureUpdateAction,
  Excalidraw,
  restore,
  serializeAsJSON,
} from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  BinaryFileData,
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
} from "@excalidraw/excalidraw/types";
import type * as Y from "yjs";
import type { ExcalidrawDocument } from "./excalidrawDocument";
import { bridge } from "./bridge";
import {
  applyCanvasSceneChange,
  LOCAL_EXCALIDRAW_ORIGIN,
  rememberRemoteScene,
  sceneForCanvas,
  type SceneRemoteEchoes,
} from "./collab/excalidrawSceneAdapter";

export type ExcalidrawCanvasProps = {
  document: ExcalidrawDocument;
  readOnly: boolean;
  onChange?: (serialized: string) => void;
  sceneDoc?: Y.Doc;
  hydrateAssets?: () => Promise<readonly BinaryFileData[]>;
  onAssetRefusedChange?: (refused: boolean) => void;
};

export default function ExcalidrawCanvas(props: ExcalidrawCanvasProps) {
  // Restore once here so our first serialized snapshot matches the normalized
  // scene Excalidraw mounts. Opening an old but valid file must not rewrite it
  // until the scene actually changes.
  const initial = useMemo(() => {
    if (props.sceneDoc) {
      const scene = sceneForCanvas(props.sceneDoc);
      return {
        scene: {
          ...scene,
          files: {},
          scrollToContent: scene.elements.length > 0,
        } as unknown as ExcalidrawInitialDataState,
        serialized: "",
      };
    }
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
  }, [props.document, props.sceneDoc]);
  const lastSerialized = useRef(initial.serialized);
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const remoteEchoes = useRef<SceneRemoteEchoes>(new Map());
  const hydratedFileIds = useRef<Set<string>>(new Set());
  const boundSceneDoc = useRef(props.sceneDoc);
  if (boundSceneDoc.current !== props.sceneDoc) {
    boundSceneDoc.current = props.sceneDoc;
    remoteEchoes.current.clear();
    hydratedFileIds.current.clear();
  }

  const renderSceneDoc = useCallback(() => {
    if (!props.sceneDoc || !apiRef.current) return;
    const scene = sceneForCanvas(props.sceneDoc);
    rememberRemoteScene(scene.elements, remoteEchoes.current);
    apiRef.current.updateScene({
      elements: scene.elements as unknown as Parameters<
        ExcalidrawImperativeAPI["updateScene"]
      >[0]["elements"],
      appState: scene.appState as unknown as Parameters<
        ExcalidrawImperativeAPI["updateScene"]
      >[0]["appState"],
      captureUpdate: CaptureUpdateAction.NEVER,
    });
  }, [props.sceneDoc]);

  useEffect(() => {
    const doc = props.sceneDoc;
    if (!doc) return;
    const onTransaction = (transaction: Y.Transaction) => {
      if (transaction.origin === LOCAL_EXCALIDRAW_ORIGIN) return;
      renderSceneDoc();
    };
    doc.on("afterTransaction", onTransaction);
    renderSceneDoc();
    return () => doc.off("afterTransaction", onTransaction);
  }, [props.sceneDoc, renderSceneDoc]);

  useEffect(() => {
    hydratedFileIds.current.clear();
    if (!props.sceneDoc || !props.hydrateAssets || !api) return;
    let active = true;
    void props
      .hydrateAssets()
      .then((files) => {
        if (!active || apiRef.current !== api) return;
        for (const file of files) hydratedFileIds.current.add(file.id);
        api.addFiles([...files]);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [api, props.hydrateAssets, props.sceneDoc]);

  return (
    <div className="absolute inset-0" data-testid="excalidraw-canvas">
      <Excalidraw
        initialData={initial.scene}
        excalidrawAPI={(api) => {
          if (apiRef.current !== api) setApi(api);
          apiRef.current = api;
          renderSceneDoc();
        }}
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
          ...(props.sceneDoc ? { tools: { image: false } } : {}),
        }}
        onChange={
          props.readOnly
            ? undefined
            : (elements, appState, files) => {
                if (props.sceneDoc) {
                  const result = applyCanvasSceneChange({
                    doc: props.sceneDoc,
                    elements,
                    appState: appState as unknown as Record<string, unknown>,
                    files: files as unknown as Record<string, unknown>,
                    remoteEchoes: remoteEchoes.current,
                    hydratedFileIds: hydratedFileIds.current,
                  });
                  if (result.assetsRefused) {
                    props.onAssetRefusedChange?.(true);
                    renderSceneDoc();
                  } else if (result.changed) {
                    props.onAssetRefusedChange?.(false);
                  }
                  return;
                }
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
