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
  useSyncExternalStore,
} from "react";
import type {
  BinaryFileData,
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
} from "@excalidraw/excalidraw/types";
import type * as Y from "yjs";
import type { ExcalidrawDocument } from "./excalidrawDocument";
import { openLinkExternally } from "./linkActivation";
import { ExcalidrawSceneBinding } from "./collab/excalidrawSceneAdapter";
import {
  bindExcalidrawPresence,
  type ExcalidrawPointerUpdate,
  type ExcalidrawPresenceBinding,
  type ExcalidrawPresenceCollaboration,
} from "./collab/excalidrawPresence";
import { useAsyncResponseEffect } from "./useAsyncResponseEffect";

function readTheme(): "light" | "dark" {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

function subscribeTheme(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
}

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
  const theme = useSyncExternalStore(subscribeTheme, readTheme);
  const sceneBinding = useMemo(
    () => (props.sceneDoc ? new ExcalidrawSceneBinding(props.sceneDoc) : null),
    [props.sceneDoc],
  );
  // Restore once here so our first serialized snapshot matches the normalized
  // scene Excalidraw mounts. Opening an old but valid file must not rewrite it
  // until the scene actually changes.
  const initial = useMemo(() => {
    if (sceneBinding) {
      const scene = sceneBinding.canvas();
      return {
        scene: {
          elements: scene.elements,
          appState: scene.appState,
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
  }, [props.document, sceneBinding]);
  const lastSerialized = useRef(initial.serialized);
  const readOnlyRef = useRef(props.readOnly);
  readOnlyRef.current = props.readOnly;
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const mountedRef = useRef(false);
  const [readyApi, setReadyApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const [presenceBound, setPresenceBound] = useState(false);
  // Per-canvas, not module-global: two panes of one document share one
  // Y.Doc, and each pane must treat only its own transactions as local — the
  // other pane's edits are remote to this one and must render here.
  const localOrigin = useRef<symbol>(Symbol("dohc.localExcalidrawChange"));
  const hydratedFileIds = useRef<Set<string>>(new Set());
  const activeSceneBinding = useRef(sceneBinding);
  activeSceneBinding.current = sceneBinding;
  const pendingSceneChange = useRef<{
    binding: ExcalidrawSceneBinding;
    elements: readonly unknown[];
    appState: Record<string, unknown>;
    files: Record<string, unknown>;
  } | null>(null);
  const sceneChangeFrame = useRef<number | null>(null);
  const presenceBinding = useRef<ExcalidrawPresenceBinding | null>(null);
  const presenceHandoff = useRef<Promise<void>>(Promise.resolve());
  const boundSceneDoc = useRef(props.sceneDoc);
  const sceneDocGeneration = useRef(0);
  if (boundSceneDoc.current !== props.sceneDoc) {
    boundSceneDoc.current = props.sceneDoc;
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

  useLayoutEffect(() => {
    if (props.readOnly && sceneChangeFrame.current !== null) {
      cancelAnimationFrame(sceneChangeFrame.current);
      sceneChangeFrame.current = null;
      pendingSceneChange.current = null;
    }
    return () => {
      if (sceneChangeFrame.current !== null) {
        cancelAnimationFrame(sceneChangeFrame.current);
        sceneChangeFrame.current = null;
      }
      pendingSceneChange.current = null;
    };
  }, [props.readOnly, sceneBinding]);

  const renderSceneDoc = useCallback(
    (transaction?: Y.Transaction) => {
      if (!sceneBinding || !readyApi) return;
      const scene = sceneBinding.remote(transaction);
      readyApi.updateScene({
        elements: scene.elements as unknown as Parameters<
          ExcalidrawImperativeAPI["updateScene"]
        >[0]["elements"],
        appState: scene.appState as unknown as Parameters<
          ExcalidrawImperativeAPI["updateScene"]
        >[0]["appState"],
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    },
    [sceneBinding, readyApi],
  );
  const renderSceneDocRef = useRef(renderSceneDoc);
  renderSceneDocRef.current = renderSceneDoc;
  const onAssetRefusedChangeRef = useRef(props.onAssetRefusedChange);
  onAssetRefusedChangeRef.current = props.onAssetRefusedChange;

  useEffect(() => {
    const doc = props.sceneDoc;
    if (!doc || !sceneBinding || !readyApi) return;
    const onTransaction = (transaction: Y.Transaction) => {
      if (transaction.origin === localOrigin.current) return;
      renderSceneDoc(transaction);
    };
    doc.on("afterTransaction", onTransaction);
    sceneBinding.refresh();
    renderSceneDoc();
    return () => doc.off("afterTransaction", onTransaction);
  }, [props.sceneDoc, readyApi, renderSceneDoc, sceneBinding]);

  useAsyncResponseEffect(
    () => {
      hydratedFileIds.current.clear();
      if (!props.sceneDoc || !props.hydrateAssets || !readyApi) return null;
      return props.hydrateAssets();
    },
    {
      onSuccess: (files) => {
        if (!readyApi || apiRef.current !== readyApi) return;
        for (const file of files) hydratedFileIds.current.add(file.id);
        try {
          readyApi.addFiles([...files]);
        } catch {
          // Asset hydration is optional. A rejected file cannot break the scene.
        }
      },
      onError: () => {
        if (!readyApi || apiRef.current !== readyApi) return;
        props.onAssetRefusedChange?.(true);
      },
    },
    [
      props.hydrateAssets,
      props.onAssetRefusedChange,
      props.sceneDoc,
      readyApi,
    ],
  );

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
        theme={theme}
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
                if (sceneBinding) {
                  pendingSceneChange.current = {
                    binding: sceneBinding,
                    elements,
                    appState: appState as unknown as Record<string, unknown>,
                    files: files as unknown as Record<string, unknown>,
                  };
                  if (sceneChangeFrame.current === null) {
                    sceneChangeFrame.current = requestAnimationFrame(() => {
                      sceneChangeFrame.current = null;
                      const pending = pendingSceneChange.current;
                      pendingSceneChange.current = null;
                      if (
                        !pending ||
                        readOnlyRef.current ||
                        activeSceneBinding.current !== pending.binding
                      ) {
                        return;
                      }
                      const result = pending.binding.apply({
                        elements: pending.elements,
                        appState: pending.appState,
                        files: pending.files,
                        hydratedFileIds: hydratedFileIds.current,
                        origin: localOrigin.current,
                      });
                      if (result.assetsRefused) {
                        onAssetRefusedChangeRef.current?.(true);
                        renderSceneDocRef.current();
                      } else if (result.changed) {
                        onAssetRefusedChangeRef.current?.(false);
                      }
                    });
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
