import { documentWords } from "@dohc/interface-words/documents";
import { Stack, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { PixelRatio, Pressable, StyleSheet, Text, View } from "react-native";
import { useReducedMotion } from "react-native-reanimated";
import { WebView } from "react-native-webview";
import { useAccount } from "../account/AccountProvider";
import { copyText } from "../copy";
import { pageTitle } from "../home/homeModel";
import { views } from "../server/workspaceData";
import { useTheme } from "../theme";
import { ScreenFailure } from "../workspace/ListStates";
import { useKeptContentProblem, useProblemText, useView } from "../workspace/useView";
import { editorFolderUri, editorHtmlUri, isOutOfSpace } from "./editorFile";
import { explanationOf, labelOf, LoadingLines, Mark, pageStyles as styles, Strip, type MarkKey } from "./pageParts";

// A page in a signed-in build, as the server's copy holds it, read-only: the phone can't save to the server yet. It
// reads again when the feed reports a change to its file, and the editor shows the new text. A page that's deleted
// while open keeps its last text, marked Deleted. A page the server can't send shows why in its place: it's gone, it's
// too large for the phone, it's being restored, or the read failed. Its header has no "Chat about" yet: the phone
// lists no file's chats.
//
// The screen starts afresh for each workspace store and path, so nothing it holds, the editor or the text it shows,
// outlives the workspace it was read from.
export function ServerPage() {
  const { data } = useAccount();
  const { path = "" } = useLocalSearchParams<{ path?: string }>();
  return <PageScreen key={`${data?.instance ?? 0}:${path}`} path={path} />;
}

function PageScreen({ path }: { path: string }) {
  const theme = useTheme();
  const name = path.split("/").pop() ?? path;
  const view = useMemo(() => views.page(path), [path]);
  const { state, retry } = useView(view);
  const problemText = useProblemText();
  const kept = useKeptContentProblem(state.problem, retry);
  const reduceMotion = useReducedMotion();

  // A page deleted while open keeps the last text its workspace's store read of it.
  const deleted = state.value?.kind === "missing" && state.value.last !== undefined;
  const markdown = state.value?.kind === "page" ? state.value.markdown : state.value?.kind === "missing" ? state.value.last ?? null : null;

  // The web view's page, prepared once; Try again after a lost page prepares it again.
  const [uri, setUri] = useState<string | null>(null);
  const [lostPage, setLostPage] = useState<false | "failed" | "noSpace">(false);
  const [attempt, setAttempt] = useState(0);
  const [painted, setPainted] = useState(false);
  useEffect(() => {
    let current = true;
    editorHtmlUri().then(
      found => { if (current) setUri(found); },
      (error: unknown) => { if (current) setLostPage(isOutOfSpace(error) ? "noSpace" : "failed"); },
    );
    return () => { current = false; };
  }, [attempt]);
  // Text that changes after the first mounts a fresh editor, which covers itself with the loading lines until it paints.
  const [revision, setRevision] = useState(0);
  const shown = useRef(markdown);
  useEffect(() => {
    if (shown.current === markdown) return;
    const first = shown.current === null;
    shown.current = markdown;
    if (first || markdown === null) return;
    setPainted(false);
    setRevision(value => value + 1);
  }, [markdown]);
  const reopen = () => { setLostPage(false); setPainted(false); setUri(null); setAttempt(value => value + 1); };

  const markKey: MarkKey = deleted ? "deleted" : "readOnlyPhone";
  const [explaining, setExplaining] = useState(false);
  const handleMessage = (raw: string) => {
    let data: unknown;
    try { data = JSON.parse(raw); } catch { return; }
    if (typeof data !== "object" || data === null || !("kind" in data)) return;
    if (data.kind === "painted") setPainted(true);
    // The page's fonts didn't load, so it didn't draw: Try again mounts a fresh page.
    if (data.kind === "fontsFailed") setLostPage("failed");
  };
  const injected = markdown === null ? undefined : `window.__dohcPage = ${JSON.stringify({
    title: pageTitle(path), properties: [], markdown, large: false, editable: false, textScale: PixelRatio.getFontScale(),
  })}; true;`;

  const failure = state.value?.kind === "missing" && !deleted ? <ScreenFailure text={documentWords.noLongerAvailable} />
    : state.value?.kind === "too-large" ? <ScreenFailure text={documentWords.tooLargeToOpen} />
    : markdown === null && state.problem === "restoring" ? <ScreenFailure text={documentWords.restoring} onRetry={retry} />
    : markdown === null && state.problem ? <ScreenFailure text={documentWords.couldntRead} cause={problemText(state.problem)} onRetry={retry} />
    : lostPage ? <ScreenFailure text={documentWords.couldntOpen} cause={lostPage === "noSpace" ? documentWords.notEnoughStorage : undefined} onRetry={reopen} />
    : null;

  return (
    <View style={[styles.screen, { backgroundColor: theme.bg }]}>
      <Stack.Screen options={{
        title: name, headerLargeTitle: false, headerTransparent: false, headerStyle: { backgroundColor: theme.bg }, headerShadowVisible: false,
        headerTitle: () => markdown === null ? (
          <Text style={[styles.name, { color: theme.ink }]} numberOfLines={1} accessibilityRole="header">{name}</Text>
        ) : (
          <Pressable onPress={() => setExplaining(value => !value)} style={[styles.headerTitle, styles.titleTarget]} accessibilityRole="button"
            accessibilityLabel={`${name}, ${labelOf(markKey)}`} accessibilityValue={{ text: explanationOf(markKey) }}>
            <Text style={[styles.name, { color: theme.ink }]} numberOfLines={1}>{name}</Text>
            <Mark markKey={markKey} theme={theme} />
          </Pressable>
        ),
      }} />
      {markdown === null ? null : (
        <Stack.Toolbar placement="right">
          <Stack.Toolbar.Menu icon="ellipsis" accessibilityLabel={documentWords.documentActions}>
            <Stack.Toolbar.MenuAction icon="doc.on.doc" onPress={() => copyText(markdown)}>{documentWords.copyAsMarkdown}</Stack.Toolbar.MenuAction>
          </Stack.Toolbar.Menu>
        </Stack.Toolbar>
      )}
      {failure ?? (
        <>
          {/* What's shown stays while a refresh that failed, or a failing feed, waits for Try again. */}
          {kept && markdown !== null ? <Strip theme={theme} icon="failed" text={kept.text} action={documentWords.tryAgain} onAction={kept.retry} /> : null}
          {uri && injected ? (
            <WebView
              key={`${attempt}:${revision}`}
              originWhitelist={["file://*"]}
              source={{ uri }}
              // Read access to the editor's folder only: the page never reads the rest of the app's files.
              allowingReadAccessToURL={editorFolderUri}
              allowFileAccess
              injectedJavaScriptBeforeContentLoaded={injected}
              onMessage={event => handleMessage(event.nativeEvent.data)}
              onError={() => setLostPage("failed")}
              onContentProcessDidTerminate={() => setLostPage("failed")}
              hideKeyboardAccessoryView
              scrollEnabled={false}
              style={[styles.web, { backgroundColor: theme.bg }]}
            />
          ) : null}
          {painted ? null : <LoadingLines theme={theme} reduceMotion={reduceMotion} />}
        </>
      )}
      {explaining ? (
        <Pressable style={StyleSheet.absoluteFill} onPress={() => setExplaining(false)} accessibilityElementsHidden>
          <View style={[styles.popover, { top: 4, backgroundColor: theme.raised, borderColor: theme.raisedLine }]}>
            <Text style={[styles.popoverText, { color: theme.ink }]}>{explanationOf(markKey)}</Text>
          </View>
        </Pressable>
      ) : null}
    </View>
  );
}
