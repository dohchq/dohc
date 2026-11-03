import type { SaveState } from "@dohc/workspace-contracts/save-state";
import type { BinaryFileData } from "@excalidraw/excalidraw/types";
import {
  Suspense,
  lazy,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type LazyExoticComponent,
} from "react";
import type { ExcalidrawCanvasProps } from "./ExcalidrawCanvas";
import type { ReportButtonError } from "./collections/useAutomationButtons";
import {
  excalidrawPresenceTopic,
  type ExcalidrawPresenceFactory,
} from "./collab/excalidrawPresence";
import type { UseEngineDoc } from "./collab/useEngineDoc";
import { binaryFileDataFromArtifact } from "./excalidrawAssets";
import {
  EMPTY_EXCALIDRAW_DOCUMENT,
  parseExcalidrawDocument,
} from "./excalidrawDocument";
import {
  EngineArtifactAssetsInvalidNotice,
  EngineMayHoldDocumentNotice,
  OpenExternallyButton,
  ViewActions,
} from "./fileInspectorUi";
import { TriangleAlert } from "lucide-react";
import { EmptyState } from "./ui/controls";
import { SkeletonRows } from "./ui/SkeletonRows";
import { StateMark } from "./ui/StateMark";
import type { SharedLocalDocument } from "./sharedLocalDocument";
import { useAutosavedTextDraft, type DraftFlush } from "./useAutosavedTextDraft";

const LazyExcalidrawCanvas = lazy(() => import("./ExcalidrawCanvas")) as
  LazyExoticComponent<(props: ExcalidrawCanvasProps) => React.ReactElement>;

export function DrawingView({
  body,
  contentHash,
  contentRequestId,
  contentReadTicket,
  latestContentRequestId,
  refreshAfterConflict,
  workspaceId,
  path,
  readOnly,
  autoFocus,
  truncated,
  reopenKey,
  switchReadPending,
  switchUnresyncedRef,
  onSaveStateChange,
  registerDraftFlush,
  onShare,
  notice,
  recoveryNotices,
  engine,
  onRetryEngineOpen,
  presenceFactory,
  localBuffer,
  onButtonError,
}: {
  body: string;
  contentHash: string | null;
  contentRequestId: number;
  contentReadTicket: number;
  latestContentRequestId: number;
  refreshAfterConflict: () => void;
  workspaceId: string;
  path: string;
  readOnly: boolean;
  autoFocus?: boolean;
  truncated: boolean;
  reopenKey?: number;
  switchReadPending: boolean;
  switchUnresyncedRef: { current: boolean };
  registerDraftFlush?: (flush: DraftFlush | null) => void;
  onShare?: () => void;
  notice?: React.ReactNode;
  recoveryNotices: React.ReactNode;
  engine: UseEngineDoc;
  onRetryEngineOpen: () => void;
  presenceFactory?: ExcalidrawPresenceFactory | null;
  onSaveStateChange?: (state: SaveState) => void;
  localBuffer: SharedLocalDocument;
  onButtonError?: ReportButtonError;
}) {
  const engineMode = engine.available && engine.doc !== null;
  const engineReadOnly =
    engine.opening ||
    engine.deletedWhileEditing ||
    engine.readOnlyWhileEditing ||
    engine.permanentFailureWhileEditing ||
    engine.engineMayHoldDocument ||
    engine.artifactAssetsInvalid ||
    engine.removalInProgress !== null;
  const editor = useAutosavedTextDraft({
    body,
    contentHash,
    contentRequestId,
    contentReadTicket,
    latestContentRequestId,
    refreshAfterConflict,
    workspaceId,
    path,
    disabled: readOnly || truncated || engineMode || engineReadOnly,
    reopenKey,
    switchReadPending,
    switchUnresyncedRef,
    onSaveStateChange: engineMode || engine.opening ? undefined : onSaveStateChange,
    registerDraftFlush,
    localBuffer,
  });
  const blankFile = !engineMode && editor.getDraft().trim() === "";
  const [assetRefused, setAssetRefused] = useState(false);
  const [assetHydrationFailures, setAssetHydrationFailures] = useState(0);
  const [assetHydrationAttempt, setAssetHydrationAttempt] = useState(0);
  useEffect(() => {
    setAssetRefused(false);
    setAssetHydrationFailures(0);
  }, [path, engine.doc]);
  useEffect(() => {
    if (!blankFile || readOnly || truncated || engine.opening) return;
    editor.setDraft(EMPTY_EXCALIDRAW_DOCUMENT);
    // The accepted disk revision is the trigger. setDraft is intentionally
    // omitted: the autosave hook returns a fresh closure on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor.valueRevision, blankFile, readOnly, truncated, engine.opening]);
  // Local Excalidraw changes update the autosave draft but the mounted canvas
  // already owns that scene. Parse again only when a disk read replaces the
  // draft; this avoids restoring the whole scene on every pointer update.
  const document = useMemo(() => {
    if (truncated) {
      return {
        value: null,
        error: "dohc cannot open a partial Excalidraw file.",
      };
    }
    try {
      return {
        value: parseExcalidrawDocument(
          blankFile ? EMPTY_EXCALIDRAW_DOCUMENT : editor.getDraft(),
        ),
        error: null,
      };
    } catch (cause) {
      return {
        value: null,
        error: cause instanceof Error ? cause.message : "The drawing is invalid.",
      };
    }
    // valueRevision advances only when the hook accepts a new disk snapshot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor.valueRevision, truncated]);

  useEffect(() => {
    if (!engineMode) return;
    onSaveStateChange?.(engine.saveState);
  }, [engineMode, engine.saveState, onSaveStateChange]);

  const canvasReadOnly = readOnly || engineReadOnly;
  const drawingReady = engineMode || document.value !== null;
  // Two panes of one drawing share a session but must not share a relay
  // presence entry: entries are keyed by client id, so a shared id makes one
  // pane's leave erase the user while the other pane is still open. Each
  // pane derives its own client id; peers merge the awareness states.
  const presencePaneId = useId();
  const presence = useMemo(() => {
    if (
      !engineMode ||
      !engine.objectId ||
      !engine.versionId ||
      !presenceFactory
    ) {
      return undefined;
    }
    try {
      return {
        transport: presenceFactory.transportForScope({
          kind: "workspace",
          workspaceId,
        }),
        topic: excalidrawPresenceTopic({
          workspaceId,
          versionId: engine.versionId,
          objectId: engine.objectId,
        }),
        clientId: `${presenceFactory.clientId}#${presencePaneId}`,
        displayName: presenceFactory.displayName,
      };
    } catch {
      // Presence is optional. A transport failure cannot affect the drawing.
      return undefined;
    }
  }, [
    engine.objectId,
    engine.versionId,
    engineMode,
    presenceFactory,
    presencePaneId,
    workspaceId,
  ]);
  const hydrationSession = useMemo(() => {
    if (!engineMode || !engine.doc || engine.artifactAssets.length === 0) {
      return null;
    }
    return {
      workspaceId,
      path,
      doc: engine.doc,
      descriptors: engine.artifactAssets,
      read: engine.readArtifactAsset,
    };
  }, [
    engine.artifactAssets,
    engine.doc,
    engine.readArtifactAsset,
    engineMode,
    path,
    workspaceId,
  ]);
  const activeHydrationSession = useRef(hydrationSession);
  useLayoutEffect(() => {
    activeHydrationSession.current = hydrationSession;
    return () => {
      if (activeHydrationSession.current === hydrationSession) {
        activeHydrationSession.current = null;
      }
    };
  }, [hydrationSession]);
  const hydrateAssets = useMemo<ExcalidrawCanvasProps["hydrateAssets"]>(() => {
    if (!hydrationSession) return undefined;
    return async () => {
      const files: BinaryFileData[] = [];
      let failures = 0;
      if (activeHydrationSession.current === hydrationSession) {
        setAssetHydrationFailures(0);
      }
      for (const descriptor of hydrationSession.descriptors) {
        if (activeHydrationSession.current !== hydrationSession) return [];
        try {
          const loaded = await hydrationSession.read(descriptor);
          if (activeHydrationSession.current !== hydrationSession) continue;
          const file = binaryFileDataFromArtifact(descriptor, loaded);
          // A read that succeeds but cannot convert (a changed descriptor, a
          // mime type outside the allowlist) is still a missing image — it
          // must surface the hydration warning, not vanish silently.
          if (file) files.push(file);
          else failures += 1;
        } catch {
          // One missing asset cannot stop the drawing or its other assets.
          failures += 1;
        }
      }
      if (activeHydrationSession.current !== hydrationSession) return [];
      setAssetHydrationFailures(failures);
      return files;
    };
  }, [assetHydrationAttempt, hydrationSession]);
  const drawingChipState =
    engineMode &&
    (engine.deletedWhileEditing)
      ? engine.goneCause!
      : readOnly || (truncated && !engineMode) || engineReadOnly
        ? "read-only"
        : engineMode
          ? engine.saveState
          : editor.saveState;
  // Three reasons a drawing is read-only, named in the order they are known:
  // the share is read-only, the live session cannot take edits (its notice
  // says why), or the bounded read cut the file short.
  // A read-only status after every edit saved sets nothing aside.
  const drawingShown = engine.readOnlyWhileEditing
    ? engine.saveState.kind === "unknown" && engine.readOnlyDraftId === null
      ? "read-only"
      : "read-only-transition"
    : drawingChipState !== "read-only"
      ? drawingChipState
      : readOnly
        ? "read-only"
        : engineReadOnly
          ? "read-only-unavailable"
          : "too-large";

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-bg" data-testid="file-inspector">
      <ViewActions
        onShare={onShare}
        status={
          <StateMark
            testId="drawing-save-state"
            truncate
            quietWhenCalm
            state={drawingChipState}
            shown={drawingShown}
            // A failed history replacement freezes the drawing read-only; its
            // save error says why, as the Markdown chip does.
            title={engine.saveError && (engine.retryReplacement || (typeof drawingChipState !== "string" && drawingChipState.kind === "error")) ? engine.saveError : undefined}
            onRetry={engine.retryReplacement ?? undefined}
          />
        }
      />
      {engineMode || engine.opening ? null : notice}
      {recoveryNotices}
      {engine.engineMayHoldDocument ? (
        <EngineMayHoldDocumentNotice
          onRetry={onRetryEngineOpen}
          contentShown={document.value !== null}
        />
      ) : null}
      {engine.artifactAssetsInvalid ? (
        <EngineArtifactAssetsInvalidNotice workspaceId={workspaceId} path={path} onError={onButtonError} />
      ) : null}
      {assetRefused ? (
        <div
          className="border-b border-line bg-panel-2 px-4 py-2 text-xs text-warning"
          data-testid="drawing-assets-refused"
        >
          This image was not added. Collaborative drawings cannot add images
          yet.
        </div>
      ) : null}
      {assetHydrationFailures > 0 ? (
        <div
          className="flex items-center justify-between gap-3 border-b border-line bg-panel-2 px-4 py-2 text-xs text-warning"
          data-testid="drawing-asset-hydration-error"
        >
          <span>
            dohc could not load {assetHydrationFailures}{" "}
            {assetHydrationFailures === 1 ? "image" : "images"}.
          </span>
          <button
            type="button"
            className="shrink-0 text-text underline underline-offset-2"
            onClick={() => setAssetHydrationAttempt((attempt) => attempt + 1)}
          >
            Try again
          </button>
        </div>
      ) : null}
      {engine.opening ? (
        <SkeletonRows layout="panel" testId="view-drawing-opening" label="Loading drawing…" />
      ) : truncated && !engineMode ? (
        <EmptyState
          data-testid="view-drawing-truncated"
          title="This drawing is too large for dohc to open."
        />
      ) : drawingReady ? (
        <div
          className="relative min-h-0 flex-1 overflow-hidden"
          data-testid="view-drawing"
        >
          <Suspense fallback={<SkeletonRows layout="panel" label="Loading drawing…" className="h-full" />}>
            <LazyExcalidrawCanvas
              key={engineMode ? "engine-scene" : editor.valueRevision}
              document={
                document.value ?? parseExcalidrawDocument(EMPTY_EXCALIDRAW_DOCUMENT)
              }
              sceneDoc={engine.doc ?? undefined}
              hydrateAssets={hydrateAssets}
              presence={presence}
              readOnly={canvasReadOnly}
              autoFocus={autoFocus}
              onAssetRefusedChange={setAssetRefused}
              onChange={canvasReadOnly || engineMode ? undefined : editor.setDraft}
            />
          </Suspense>
        </div>
      ) : (
        <EmptyState
          data-testid="view-drawing-error"
          icon={TriangleAlert}
          tone="danger"
          title={`dohc could not open this drawing. ${document.error ?? "The drawing is invalid."}`}
        >
          <OpenExternallyButton workspaceId={workspaceId} path={path} onError={onButtonError} />
        </EmptyState>
      )}
    </div>
  );
}
