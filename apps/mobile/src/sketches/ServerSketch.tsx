import type { ElementSnapshot, JsonObject } from "@dohc/excalidraw-scene";
import { confirmWords } from "@dohc/interface-words/confirmations";
import { documentWords } from "@dohc/interface-words/documents";
import { workspaceWords } from "@dohc/interface-words/workspace";
import * as Crypto from "expo-crypto";
import { Stack, useLocalSearchParams, usePreventRemove } from "expo-router";
import { useCallback, useEffect, useRef, useState, type ComponentRef } from "react";
import { ActivityIndicator, Alert, Platform, StyleSheet, useColorScheme, View } from "react-native";
import { useReducedMotion } from "react-native-reanimated";
import { WebView } from "react-native-webview";
import { useAccount, useSignIn } from "../account/AccountProvider";
import { HeaderButton } from "../AndroidHeader";
import { isOutOfSpace } from "../pages/editorFile";
import { LoadingLines, pageStyles, Strip } from "../pages/pageParts";
import { shownProblem } from "../server/client";
import {
  readSketch,
  saveSketch,
  type SketchReadResult,
  type SketchScene,
} from "../server/phoneSketches";
import { writesIn } from "../server/phoneWrites";
import { views } from "../server/workspaceData";
import { useTheme } from "../theme";
import { NoWorkspace, ScreenFailure, useWorkspaceGap } from "../workspace/ListStates";
import { useProblemText } from "../workspace/useView";
import { sketchFolderUri, sketchHtmlUri } from "./sketchFile";
import { sketchTitle } from "./sketchList";

type Delta = { elements: ElementSnapshot[]; appState: JsonObject };
type ReadState =
  | { kind: "loading" }
  | { kind: "ready"; scene: SketchScene }
  | { kind: "refused"; refusal: Exclude<SketchReadResult["kind"], "sketch"> }
  | { kind: "failed"; cause: string };

export function ServerSketch() {
  const { data } = useAccount();
  const { path = "" } = useLocalSearchParams<{ path?: string }>();
  if (!data)
    return (
      <View style={pageStyles.screen}>
        <NoWorkspace />
      </View>
    );
  if (data.joined) {
    return (
      <View style={pageStyles.screen}>
        <Stack.Screen options={{ title: sketchTitle(path) }} />
        <ScreenFailure text={workspaceWords.sketchUnavailableJoined} />
      </View>
    );
  }
  return <SketchScreen key={`${data.instance}:${path}`} path={path} />;
}

function SketchScreen({ path }: { path: string }) {
  const theme = useTheme();
  const scheme = useColorScheme() === "dark" ? "dark" : "light";
  const reduceMotion = useReducedMotion();
  const problemText = useProblemText();
  const { data } = useAccount();
  const signIn = useSignIn();
  const gap = useWorkspaceGap();
  const editable = writesIn(data);
  const web = useRef<ComponentRef<typeof WebView>>(null);

  const [uri, setUri] = useState<string | null>(null);
  const [assetError, setAssetError] = useState<false | "failed" | "noSpace">(false);
  const [readState, setReadState] = useState<ReadState>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [webPhase, setWebPhase] = useState<"idle" | "started" | "painted">("idle");
  const [edit, setEdit] = useState({
    dirty: false,
    saving: false,
    error: null as string | null,
    conflicts: 0,
    missingAssets: 0,
  });
  const [leaving, setLeaving] = useState<(() => void) | null>(null);

  const sceneRef = useRef<SketchScene | null>(null);
  const loadedIntoWeb = useRef(false);
  const collectToken = useRef(0);
  const pendingCollect = useRef<{
    token: number;
    timer: ReturnType<typeof setTimeout>;
    resolve(d: Delta): void;
    reject(e: Error): void;
  } | null>(null);
  const saveAbortRef = useRef<AbortController | null>(null);
  const saveRequestId = useRef<string | null>(null);

  const cancelCollect = useCallback((reason: string) => {
    const p = pendingCollect.current;
    if (!p) return;
    clearTimeout(p.timer);
    pendingCollect.current = null;
    p.reject(new Error(reason));
  }, []);

  useEffect(
    () => () => {
      cancelCollect("unmounted");
      saveAbortRef.current?.abort();
    },
    [cancelCollect],
  );

  useEffect(() => {
    let active = true;
    setAssetError(false);
    setUri(null);
    sketchHtmlUri().then(
      (found) => active && setUri(found),
      (err: unknown) => active && setAssetError(isOutOfSpace(err) ? "noSpace" : "failed"),
    );
    return () => {
      active = false;
    };
  }, [attempt]);

  useEffect(() => {
    if (!data) return;
    const controller = new AbortController();
    setReadState({ kind: "loading" });
    loadedIntoWeb.current = false;
    setWebPhase("idle");
    setEdit({ dirty: false, saving: false, error: null, conflicts: 0, missingAssets: 0 });
    readSketch(signIn.client, data.workspaceId, path, controller.signal).then(
      (answer) => {
        if (controller.signal.aborted || !signIn.isCurrent() || !data.isOpen()) return;
        if (answer.kind === "sketch") {
          sceneRef.current = answer;
          setEdit((prev) => ({ ...prev, missingAssets: answer.missingAssets }));
          setReadState({ kind: "ready", scene: answer });
        } else {
          setReadState({ kind: "refused", refusal: answer.kind });
        }
      },
      (err: unknown) => {
        if (controller.signal.aborted || !signIn.isCurrent() || !data.isOpen()) return;
        const problem = shownProblem(err);
        if (problem !== null) setReadState({ kind: "failed", cause: problemText(problem) });
      },
    );
    return () => controller.abort();
  }, [attempt, data, path, problemText, signIn]);

  const sendScene = useCallback(
    (scene: SketchScene, fn: "__dohcSketchLoad" | "__dohcSketchApplySaved") =>
      web.current?.injectJavaScript(
        `window.${fn}?.(${JSON.stringify({ elements: scene.elements, appState: scene.appState, files: scene.files, readOnly: !editable, theme: scheme })}); true;`,
      ),
    [editable, scheme],
  );

  useEffect(() => {
    if (webPhase === "idle" || readState.kind !== "ready" || loadedIntoWeb.current) return;
    loadedIntoWeb.current = true;
    sendScene(readState.scene, "__dohcSketchLoad");
  }, [webPhase, readState, sendScene]);

  useEffect(() => {
    if (webPhase !== "idle")
      web.current?.injectJavaScript(`window.__dohcSketchTheme?.(${JSON.stringify(scheme)}); true;`);
  }, [webPhase, scheme]);

  const collectFromWeb = useCallback(
    () =>
      new Promise<Delta>((resolve, reject) => {
        cancelCollect("superseded");
        const token = ++collectToken.current;
        const timer = setTimeout(() => cancelCollect("collect-timeout"), 5_000);
        pendingCollect.current = { token, timer, resolve, reject };
        web.current?.injectJavaScript(`window.__dohcSketchCollect?.(${token}); true;`);
      }),
    [cancelCollect],
  );

  const performSave = useCallback(async (): Promise<boolean> => {
    if (!data || !editable || edit.saving || !sceneRef.current) return false;
    setEdit((prev) => ({ ...prev, saving: true, error: null, conflicts: 0 }));
    const requestId = (saveRequestId.current ??= Crypto.randomUUID());
    const controller = new AbortController();
    saveAbortRef.current = controller;
    try {
      const delta = await collectFromWeb();
      if (controller.signal.aborted || !signIn.isCurrent() || !data.isOpen()) return false;
      const answer = await saveSketch(
        signIn.client,
        data.workspaceId,
        {
          path,
          objectId: sceneRef.current.objectId,
          requestId,
          elements: delta.elements,
          ...(Object.keys(delta.appState).length > 0 ? { appState: delta.appState } : {}),
        },
        controller.signal,
      );
      if (controller.signal.aborted || !signIn.isCurrent() || !data.isOpen()) return false;
      if (answer.kind === "saved") {
        saveRequestId.current = null;
        sceneRef.current = answer;
        setEdit({
          dirty: false,
          saving: false,
          error: null,
          conflicts: answer.lostElementIds.length,
          missingAssets: answer.missingAssets,
        });
        sendScene(answer, "__dohcSketchApplySaved");
        void data.refresh(views.files);
        return true;
      }
      setEdit((prev) => ({
        ...prev,
        saving: false,
        error:
          answer.kind === "invalid"
            ? workspaceWords.sketchInvalid
            : workspaceWords.sketchChangedElsewhere,
      }));
      return false;
    } catch (err: unknown) {
      if (controller.signal.aborted || !signIn.isCurrent() || !data.isOpen()) return false;
      const problem = shownProblem(err);
      setEdit((prev) => ({
        ...prev,
        saving: false,
        error: problem !== null ? problemText(problem) : workspaceWords.sketchSaveFailed,
      }));
      return false;
    } finally {
      if (saveAbortRef.current === controller) saveAbortRef.current = null;
      setEdit((prev) => (prev.saving ? { ...prev, saving: false } : prev));
    }
  }, [collectFromWeb, data, edit.saving, editable, path, problemText, sendScene, signIn]);

  usePreventRemove(editable && edit.dirty && !leaving, ({ repeat }) => {
    const leave = () => setLeaving(() => repeat);
    Alert.alert(workspaceWords.sketchUnsavedTitle, workspaceWords.sketchUnsavedBody, [
      { text: confirmWords.cancel, style: "cancel" },
      {
        text: workspaceWords.sketchSave,
        onPress: () => void performSave().then((ok) => ok && leave()),
      },
      { text: documentWords.discardEdits, style: "destructive", onPress: leave },
    ]);
  });
  useEffect(() => leaving?.(), [leaving]);

  const handleMessage = (raw: string) => {
    let msg: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null) return;
      msg = parsed as Record<string, unknown>;
    } catch {
      return;
    }
    if (msg.kind === "started") setWebPhase((p) => (p === "idle" ? "started" : p));
    else if (msg.kind === "painted") setWebPhase("painted");
    else if (msg.kind === "dirty" && typeof msg.dirty === "boolean") {
      setEdit((prev) =>
        prev.dirty === msg.dirty ? prev : { ...prev, dirty: msg.dirty as boolean },
      );
      if (msg.dirty) saveRequestId.current = null;
    } else if (msg.kind === "collected" && pendingCollect.current?.token === msg.token) {
      const p = pendingCollect.current;
      if (!p) return;
      clearTimeout(p.timer);
      pendingCollect.current = null;
      p.resolve({
        elements: Array.isArray(msg.elements) ? (msg.elements as ElementSnapshot[]) : [],
        appState:
          typeof msg.appState === "object" && msg.appState !== null
            ? (msg.appState as JsonObject)
            : {},
      });
    }
  };

  const retry = () => setAttempt((n) => n + 1);
  const webFailed = () => {
    cancelCollect("webview-error");
    setAssetError("failed");
  };
  const failure = gap ? (
    <NoWorkspace />
  ) : assetError ? (
    <ScreenFailure
      text={workspaceWords.sketchReadFailed}
      cause={assetError === "noSpace" ? documentWords.notEnoughStorage : undefined}
      onRetry={retry}
    />
  ) : readState.kind === "refused" ? (
    <ScreenFailure
      text={
        readState.refusal === "too-large"
          ? documentWords.tooLargeToOpen
          : readState.refusal === "invalid"
            ? workspaceWords.sketchInvalid
            : documentWords.noLongerAvailable
      }
    />
  ) : readState.kind === "failed" ? (
    <ScreenFailure text={workspaceWords.sketchReadFailed} cause={readState.cause} onRetry={retry} />
  ) : null;

  const canSave = editable && readState.kind === "ready" && (edit.dirty || edit.saving);
  const webShown = failure === null && uri !== null && readState.kind === "ready";
  const strips = [
    edit.error
      ? {
          key: "err",
          icon: "failed" as const,
          text: `${workspaceWords.sketchSaveFailed} ${edit.error}`,
          action: documentWords.tryAgain,
          onAction: () => void performSave(),
        }
      : null,
    edit.conflicts > 0
      ? {
          key: "conf",
          icon: "lock" as const,
          text: workspaceWords.sketchSaveConflict(edit.conflicts),
          action: documentWords.dismiss,
          onAction: () => setEdit((p) => ({ ...p, conflicts: 0 })),
        }
      : null,
    edit.missingAssets > 0
      ? {
          key: "miss",
          icon: "lock" as const,
          text: workspaceWords.sketchAssetsMissing(edit.missingAssets),
          action: documentWords.dismiss,
          onAction: () => setEdit((p) => ({ ...p, missingAssets: 0 })),
        }
      : null,
  ].filter((s): s is NonNullable<typeof s> => s !== null);

  return (
    <View style={[pageStyles.screen, { backgroundColor: theme.bg }]}>
      <Stack.Screen
        options={{
          title: sketchTitle(path),
          headerLargeTitle: false,
          headerStyle: { backgroundColor: theme.bg },
          headerShadowVisible: false,
          headerRight:
            Platform.OS === "android" && canSave
              ? () =>
                  edit.saving ? (
                    <View style={styles.spinner}>
                      <ActivityIndicator accessibilityLabel={workspaceWords.sketchSaving} />
                    </View>
                  ) : (
                    <HeaderButton
                      label={workspaceWords.sketchSave}
                      onPress={() => void performSave()}
                    />
                  )
              : undefined,
        }}
      />
      {Platform.OS === "ios" && canSave ? (
        <Stack.Toolbar placement="right">
          {edit.saving ? (
            <Stack.Toolbar.View>
              <ActivityIndicator accessibilityLabel={workspaceWords.sketchSaving} />
            </Stack.Toolbar.View>
          ) : (
            <Stack.Toolbar.Button variant="done" onPress={() => void performSave()}>
              {workspaceWords.sketchSave}
            </Stack.Toolbar.Button>
          )}
        </Stack.Toolbar>
      ) : null}
      {failure ?? (
        <>
          {strips.map((s) => (
            <Strip
              key={s.key}
              theme={theme}
              icon={s.icon}
              text={s.text}
              action={s.action}
              onAction={s.onAction}
            />
          ))}
          {webShown ? (
            <View style={pageStyles.web} pointerEvents={edit.saving ? "none" : "auto"}>
              <WebView
                ref={web}
                originWhitelist={["file://*"]}
                source={{ uri }}
                allowingReadAccessToURL={sketchFolderUri}
                allowFileAccess
                onMessage={(e) => handleMessage(e.nativeEvent.data)}
                onError={webFailed}
                onContentProcessDidTerminate={webFailed}
                onRenderProcessGone={webFailed}
                scrollEnabled={false}
                textZoom={100}
                style={[pageStyles.web, { backgroundColor: theme.bg }]}
              />
            </View>
          ) : null}
          {webPhase === "painted" ? null : (
            <LoadingLines theme={theme} reduceMotion={reduceMotion} />
          )}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  spinner: { minWidth: 48, minHeight: 48, alignItems: "center", justifyContent: "center" },
});
