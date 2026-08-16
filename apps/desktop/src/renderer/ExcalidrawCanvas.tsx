import {
  CaptureUpdateAction,
  Excalidraw,
  restore,
  serializeAsJSON,
} from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  BinaryFileData,
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
} from "@excalidraw/excalidraw/types";
import type * as Y from "yjs";
import type { ExcalidrawDocument } from "./excalidrawDocument";
import { openLinkExternally } from "./editor/linkMenu";
import {
  applyCanvasSceneChange,
  createSceneRemoteEchoes,
  rememberRemoteScene,
  sceneForCanvas,
  type SceneRemoteEchoes,
} from "./collab/excalidrawSceneAdapter";
import {
  bindExcalidrawPresence,
  type ExcalidrawPointerUpdate,
  type ExcalidrawPresenceBinding,
  type ExcalidrawPresenceCollaboration,
} from "./collab/excalidrawPresence";

export type ExcalidrawCanvasProps = {
  document: ExcalidrawDocument;
  readOnly: boolean;
  autoFocus?: boolean;
  onChange?: (serialized: string) => void;
  sceneDoc?: Y.Doc;
  hydrateAssets?: () => Promise<readonly BinaryFileData[]>;
  onAssetRefusedChange?: (refused: boolean) => void;
  presence?: ExcalidrawPresenceCollaboration & { topic: string };
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
  const readOnlyRef = useRef(props.readOnly);
  readOnlyRef.current = props.readOnly;
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const mountedRef = useRef(false);
  const [readyApi, setReadyApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const [presenceBound, setPresenceBound] = useState(false);
  const remoteEchoes = useRef<SceneRemoteEchoes>(createSceneRemoteEchoes());
  // Per-canvas, not module-global: two panes of one document share one
  // Y.Doc, and each pane must treat only ITS OWN transactions as local — the
  // other pane's edits are remote to this one and must render here.
  const localOrigin = useRef<symbol>(Symbol("dohc.localExcalidrawChange"));
  const hydratedFileIds = useRef<Set<string>>(new Set());
  const presenceBinding = useRef<ExcalidrawPresenceBinding | null>(null);
  const presenceHandoff = useRef<Promise<void>>(Promise.resolve());
  const boundSceneDoc = useRef(props.sceneDoc);
  const sceneDocGeneration = useRef(0);
  if (boundSceneDoc.current !== props.sceneDoc) {
    boundSceneDoc.current = props.sceneDoc;
    remoteEchoes.current = createSceneRemoteEchoes();
    hydratedFileIds.current.clear();
    // Remount the canvas below. Excalidraw's imperative API can add files but
    // never remove them, so a replacement document that reuses a fileId would
    // otherwise show the retired lineage's bytes until — or forever, if — its
    // own asset read lands.
    sceneDocGeneration.current += 1;
  }

  useLayoutEffect(() => {
    mountedRef.current = true;
    if (apiRef.current) setReadyApi(apiRef.current);
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const renderSceneDoc = useCallback(() => {
    if (!props.sceneDoc || !readyApi) return;
    const scene = sceneForCanvas(props.sceneDoc);
    rememberRemoteScene(scene, remoteEchoes.current);
    readyApi.updateScene({
      elements: scene.elements as unknown as Parameters<
        ExcalidrawImperativeAPI["updateScene"]
      >[0]["elements"],
      appState: scene.appState as unknown as Parameters<
        ExcalidrawImperativeAPI["updateScene"]
      >[0]["appState"],
      captureUpdate: CaptureUpdateAction.NEVER,
    });
  }, [props.sceneDoc, readyApi]);

  useEffect(() => {
    const doc = props.sceneDoc;
    if (!doc) return;
    const onTransaction = (transaction: Y.Transaction) => {
      if (transaction.origin === localOrigin.current) return;
      renderSceneDoc();
    };
    doc.on("afterTransaction", onTransaction);
    renderSceneDoc();
    return () => doc.off("afterTransaction", onTransaction);
  }, [props.sceneDoc, renderSceneDoc]);

  useEffect(() => {
    hydratedFileIds.current.clear();
    const api = readyApi;
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
  }, [props.hydrateAssets, props.sceneDoc, readyApi]);

  useEffect(() => {
    setPresenceBound(false);
    if (props.readOnly || !props.sceneDoc || !props.presence || !readyApi) return;
    const { sceneDoc, presence } = props;
    let binding: ExcalidrawPresenceBinding | null = null;
    let cancelled = false;
    // Rebinding reuses the same topic and client id, so the new binding must
    // wait out the old one's leave: publishing first would let that leave
    // delete the fresh relay entry and peers would lose this editor until the
    // next pointer update or heartbeat.
    presenceHandoff.current = presenceHandoff.current.then(() => {
      if (cancelled) return;
      try {
        binding = bindExcalidrawPresence({
          doc: sceneDoc,
          transport: presence.transport,
          topic: presence.topic,
          clientId: presence.clientId,
          displayName: presence.displayName,
          getApi: () => (apiRef.current === readyApi ? readyApi : null),
        });
      } catch {
        // Presence is optional. A binding failure cannot affect the scene.
        return;
      }
      presenceBinding.current = binding;
      setPresenceBound(true);
    });
    return () => {
      cancelled = true;
      const current = binding;
      if (!current) return;
      if (presenceBinding.current === current) presenceBinding.current = null;
      // Detach synchronously; only the channel's leave is the rebind barrier.
      const stopped = current.destroy();
      presenceHandoff.current = presenceHandoff.current.then(() => stopped);
    };
  }, [props.presence, props.readOnly, props.sceneDoc, readyApi]);

  return (
    <div className="absolute inset-0" data-testid="excalidraw-canvas">
      <Excalidraw
        key={sceneDocGeneration.current}
        initialData={initial.scene}
        isCollaborating={presenceBound}
        onPointerUpdate={
          presenceBound
            ? (update) => {
                if (readOnlyRef.current) return;
                presenceBinding.current?.updatePointer(
                  update as ExcalidrawPointerUpdate,
                );
              }
            : undefined
        }
        excalidrawAPI={(api) => {
          apiRef.current = api;
          queueMicrotask(() => {
            if (!mountedRef.current || apiRef.current !== api) return;
            setReadyApi(api);
          });
        }}
        viewModeEnabled={props.readOnly}
        autoFocus={!props.readOnly && (props.autoFocus ?? true)}
        aiEnabled={false}
        validateEmbeddable={false}
        onLinkOpen={(element, event) => {
          // The audited bridge allowlists exactly http(s) and mailto; other
          // schemes stay refused by the shell's window handler.
          if (
            !element.link ||
            !/^(?:https?:\/\/|mailto:)/iu.test(element.link)
          ) {
            return;
          }
          // Excalidraw otherwise calls window.open, which the desktop shell
          // denies. Keep navigation inside dohc's audited URL bridge.
          event.preventDefault();
          void openLinkExternally(element.link);
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
                if (readOnlyRef.current) return;
                presenceBinding.current?.updateSelection(
                  appState.selectedElementIds,
                );
                if (props.sceneDoc) {
                  const result = applyCanvasSceneChange({
                    doc: props.sceneDoc,
                    elements,
                    appState: appState as unknown as Record<string, unknown>,
                    files: files as unknown as Record<string, unknown>,
                    remoteEchoes: remoteEchoes.current,
                    hydratedFileIds: hydratedFileIds.current,
                    origin: localOrigin.current,
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
