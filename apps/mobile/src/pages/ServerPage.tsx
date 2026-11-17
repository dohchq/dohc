import type { ServerProblemKind } from "@dohc/interface-words/account";
import { confirmWords } from "@dohc/interface-words/confirmations";
import { documentWords } from "@dohc/interface-words/documents";
import { Stack, useIsFocused, useLocalSearchParams, usePreventRemove } from "expo-router";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentRef,
} from "react";
import { Alert, PixelRatio, Pressable, StyleSheet, Text, View } from "react-native";
import { useKeyboardState } from "react-native-keyboard-controller";
import { useReducedMotion } from "react-native-reanimated";
import { WebView } from "react-native-webview";
import { PageScrollTop } from "../../modules/page-scroll-top";
import { useAccount, useSignIn } from "../account/AccountProvider";
import { copyText } from "../copy";
import { pageTitle } from "../home/homeModel";
import { phoneWrites } from "../server/phoneWrites";
import { views } from "../server/workspaceData";
import { useTheme } from "../theme";
import { NoWorkspace, ScreenFailure, useWorkspaceGap } from "../workspace/ListStates";
import { useKeptContentProblem, useProblemText, useView } from "../workspace/useView";
import { editorFolderUri, editorHtmlUri, isOutOfSpace } from "./editorFile";
import {
  createPageLive,
  holdsUnsent,
  liveMark,
  type PageLive,
  type PageLiveState,
} from "./pageLive";
import {
  explanationOf,
  labelOf,
  LoadingLines,
  Mark,
  pageStyles as styles,
  Strip,
  type MarkKey,
} from "./pageParts";

// A page opened from a Notice names its workspace. It shows only while that workspace is the one open, so it never
// reads the page from another.
export function ServerPage() {
  const { data } = useAccount();
  const { path = "", workspace } = useLocalSearchParams<{ path?: string; workspace?: string }>();
  if (workspace !== undefined && data?.workspaceId !== workspace) return <ElsewherePage />;
  return <PageScreen key={`${data?.instance ?? 0}:${path}`} path={path} />;
}

/** A page whose workspace is no longer the one open, as when another device hid it. */
function ElsewherePage() {
  const theme = useTheme();
  return (
    <View style={[styles.screen, { backgroundColor: theme.bg }]}>
      <ScreenFailure text={documentWords.noLongerAvailable} />
    </View>
  );
}

const noSession = () => () => undefined;
const NO_STATE: PageLiveState = { phase: "ended", reason: null, facts: null };
/** A failed open's cause, as the server's other failures say it; null for a lost connection. */
const openProblem = (reason: string): ServerProblemKind | null =>
  reason === "not-found"
    ? "refused"
    : reason === "offline" ||
        reason === "server-busy" ||
        reason === "refused" ||
        reason === "invalid"
      ? reason
      : null;

function PageScreen({ path }: { path: string }) {
  const theme = useTheme();
  const name = path.split("/").pop() ?? path;
  const view = useMemo(() => views.page(path), [path]);
  const { state, retry } = useView(view);
  const problemText = useProblemText();
  const kept = useKeptContentProblem(state.problem, retry);
  const reduceMotion = useReducedMotion();
  const focused = useIsFocused();
  const { data, livePages } = useAccount();
  const signIn = useSignIn();
  const web = useRef<ComponentRef<typeof WebView>>(null);

  // A page deleted while open keeps the last text its workspace's store read of it.
  const deleted = state.value?.kind === "missing" && state.value.last !== undefined;
  const markdown =
    state.value?.kind === "page"
      ? state.value.markdown
      : state.value?.kind === "missing"
        ? (state.value.last ?? null)
        : null;

  // The web view's page, prepared once; Try again after a lost page prepares it again.
  const [uri, setUri] = useState<string | null>(null);
  const [lostPage, setLostPage] = useState<false | "failed" | "noSpace">(false);
  const [attempt, setAttempt] = useState(0);
  const [painted, setPainted] = useState(false);
  useEffect(() => {
    let current = true;
    editorHtmlUri().then(
      (found) => {
        if (current) setUri(found);
      },
      (error: unknown) => {
        if (current) setLostPage(isOutOfSpace(error) ? "noSpace" : "failed");
      },
    );
    return () => {
      current = false;
    };
  }, [attempt]);

  // With phone writes on, the page opens live once its web view has drawn the text read. The session ends with the web
  // view, and with the sign-in or workspace (appTeardown), which closes its socket before anything else.
  const editsLive = phoneWrites && state.value?.kind === "page" && data !== null;
  const [live, setLive] = useState<PageLive | null>(null);
  useEffect(() => {
    if (!editsLive || !painted || live || !data) return;
    setLive(
      createPageLive({
        client: signIn.client,
        workspaceId: data.workspaceId,
        path,
        post: (message) =>
          web.current?.injectJavaScript(`window.__dohcLive?.(${JSON.stringify(message)}); true;`),
      }),
    );
  }, [editsLive, painted, live, data, signIn, path]);
  useEffect(() => {
    if (!live || !data) return;
    const remove = livePages.add({ signIn, workspaceId: data.workspaceId }, live);
    live.start();
    return () => {
      remove();
      live.end();
    };
    // Registered once, for the sign-in and workspace it opened in: a change of either ends it (appTeardown).
  }, [live]);
  const liveState = useSyncExternalStore(
    live?.subscribe ?? noSession,
    live?.state ?? (() => NO_STATE),
  );
  // The page keeps its web view while it holds a provider, or may get one, so text the server read later never
  // replaces the live document or edits it hasn't applied.
  const holding =
    live !== null &&
    liveState.phase !== "ended" &&
    !(liveState.phase === "refused" && liveState.facts === null);

  // Text that changes after the first mounts a fresh editor, which covers itself with the loading lines until it paints.
  const [revision, setRevision] = useState(0);
  const shown = useRef(markdown);
  useEffect(() => {
    if (holding || shown.current === markdown) return;
    const first = shown.current === null;
    shown.current = markdown;
    if (first || markdown === null) return;
    setPainted(false);
    setRevision((value) => value + 1);
  }, [markdown, holding]);
  const reopen = () => {
    setLostPage(false);
    setPainted(false);
    setUri(null);
    setAttempt((value) => value + 1);
  };

  const markKey: MarkKey = deleted
    ? "deleted"
    : live
      ? liveMark(liveState)
      : editsLive
        ? "opening"
        : "readOnlyPhone";
  const [explaining, setExplaining] = useState(false);
  const handleMessage = (raw: string) => {
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof data !== "object" || data === null || !("kind" in data)) return;
    if (data.kind === "live") live?.receive(data);
    if (data.kind === "painted") setPainted(true);
    // The page's fonts didn't load, so it didn't draw: Try again mounts a fresh page.
    if (data.kind === "fontsFailed") setLostPage("failed");
    if (data.kind === "markdown" && "markdown" in data && typeof data.markdown === "string")
      copied.current(data.markdown);
    if (data.kind === "markdownUnavailable" && markdown !== null) copied.current(markdown);
  };
  const injected =
    markdown === null
      ? undefined
      : `window.__dohcPage = ${JSON.stringify({
          title: pageTitle(path),
          properties: [],
          markdown,
          large: false,
          editable: false,
          live: editsLive,
          textScale: PixelRatio.getFontScale(),
        })}; true;`;

  // Copy as Markdown copies the page as the web view holds it, edits included; a page without one, as it was read.
  const copied = useRef((text: string) => copyText(text));
  const copyMarkdown = (then?: () => void) => {
    copied.current = (text) => {
      copyText(text);
      then?.();
    };
    if (web.current)
      web.current.injectJavaScript(
        `(window.__dohcCopyMarkdown ?? (() => window.ReactNativeWebView?.postMessage('{"kind":"markdownUnavailable"}')))(); true;`,
      );
    else if (markdown !== null) copied.current(markdown);
  };
  // Leaving with edits the server hasn't applied asks first: only this web view's memory holds them. The way out runs
  // once the next render has let the page go.
  const [leaving, setLeaving] = useState<(() => void) | null>(null);
  usePreventRemove(holdsUnsent(liveState) && !leaving, ({ repeat }) => {
    const leave = () => setLeaving(() => repeat);
    Alert.alert(documentWords.unsentTitle, documentWords.unsentBody, [
      { text: confirmWords.cancel, style: "cancel" },
      { text: documentWords.copyAsMarkdown, onPress: () => copyMarkdown(leave) },
      { text: documentWords.discardEdits, style: "destructive", onPress: leave },
    ]);
  });
  useEffect(() => leaving?.(), [leaving]);

  // "Done" is the system's word for closing the keyboard (a platform difference): it shows only while typing. The page
  // hears how much the keyboard covers and keeps the caret above it.
  const typing = useKeyboardState((keyboard) => keyboard.isVisible);
  const keyboardHeight = useKeyboardState((keyboard) => (keyboard.isVisible ? keyboard.height : 0));
  useEffect(() => {
    web.current?.injectJavaScript(`window.__dohcKeyboard?.(${keyboardHeight}); true;`);
  }, [keyboardHeight]);
  const endEditing = () => web.current?.injectJavaScript("window.__dohcEndEditing?.(); true;");

  // No workspace open, as when another device hid the last one: the page says why, as Home and Chats do.
  const gap = useWorkspaceGap();
  const failure = gap ? (
    <NoWorkspace />
  ) : state.value?.kind === "missing" && !deleted ? (
    <ScreenFailure text={documentWords.noLongerAvailable} />
  ) : state.value?.kind === "too-large" ? (
    <ScreenFailure text={documentWords.tooLargeToOpen} />
  ) : markdown === null && state.problem === "restoring" ? (
    <ScreenFailure text={documentWords.restoring} onRetry={retry} />
  ) : markdown === null && state.problem ? (
    <ScreenFailure
      text={documentWords.couldntRead}
      cause={problemText(state.problem)}
      onRetry={retry}
    />
  ) : lostPage ? (
    <ScreenFailure
      text={documentWords.couldntOpen}
      cause={lostPage === "noSpace" ? documentWords.notEnoughStorage : undefined}
      onRetry={reopen}
    />
  ) : null;
  // A session whose web view is gone has no provider left: it ends, and a new web view opens the page again.
  const webShown = failure === null && uri !== null && injected !== undefined;
  useEffect(() => {
    if (!webShown) setLive(null);
  }, [webShown]);

  // What stopped editing, under the header, with Try again when another open may work.
  const lostReason = liveState.phase === "lost" ? liveState.reason : null;
  const liveStrip =
    liveState.phase === "refused" ? (
      <Strip theme={theme} icon="lock" text={explanationOf(markKey)} />
    ) : lostReason !== null ? (
      <Strip
        theme={theme}
        icon="lock"
        text={((problem) => (problem ? problemText(problem) : explanationOf(markKey)))(
          openProblem(lostReason),
        )}
        action={documentWords.tryAgain}
        onAction={() => live?.retry()}
      />
    ) : null;

  return (
    <View style={[styles.screen, { backgroundColor: theme.bg }]}>
      <Stack.Screen
        options={{
          title: name,
          headerLargeTitle: false,
          headerTransparent: false,
          headerStyle: { backgroundColor: theme.bg },
          headerShadowVisible: false,
          headerTitle: () =>
            markdown === null ? (
              <Text
                style={[styles.name, { color: theme.ink }]}
                numberOfLines={1}
                accessibilityRole="header"
              >
                {name}
              </Text>
            ) : (
              <Pressable
                onPress={() => setExplaining((value) => !value)}
                style={[styles.headerTitle, styles.titleTarget]}
                accessibilityRole="button"
                accessibilityLabel={`${name}, ${labelOf(markKey)}`}
                accessibilityValue={{ text: explanationOf(markKey) }}
              >
                <Text style={[styles.name, { color: theme.ink }]} numberOfLines={1}>
                  {name}
                </Text>
                <Mark markKey={markKey} theme={theme} />
              </Pressable>
            ),
        }}
      />
      {markdown === null ? null : (
        <Stack.Toolbar placement="right">
          {typing ? (
            <Stack.Toolbar.Button variant="done" onPress={endEditing}>
              Done
            </Stack.Toolbar.Button>
          ) : null}
          <Stack.Toolbar.Menu
            hidden={typing}
            icon="ellipsis"
            accessibilityLabel={documentWords.documentActions}
          >
            <Stack.Toolbar.MenuAction icon="doc.on.doc" onPress={() => copyMarkdown()}>
              {documentWords.copyAsMarkdown}
            </Stack.Toolbar.MenuAction>
          </Stack.Toolbar.Menu>
        </Stack.Toolbar>
      )}
      {failure ?? (
        <>
          {/* What's shown stays while a refresh that failed, or a failing feed, waits for Try again. */}
          {kept && markdown !== null && !holding ? (
            <Strip
              theme={theme}
              icon="failed"
              text={kept.text}
              action={documentWords.tryAgain}
              onAction={kept.retry}
            />
          ) : null}
          {liveStrip}
          {webShown ? (
            <PageScrollTop
              key={`${attempt}:${revision}`}
              active={focused}
              ready={painted}
              style={styles.web}
            >
              <WebView
                ref={web}
                originWhitelist={["file://*"]}
                source={{ uri }}
                // Read access to the editor's folder only: the page never reads the rest of the app's files.
                allowingReadAccessToURL={editorFolderUri}
                allowFileAccess
                injectedJavaScriptBeforeContentLoaded={injected}
                onMessage={(event) => handleMessage(event.nativeEvent.data)}
                onError={() => setLostPage("failed")}
                onContentProcessDidTerminate={() => setLostPage("failed")}
                keyboardDisplayRequiresUserAction={false}
                // WebKit's own bar above the keyboard repeats Done; the header's system Done is the one way out.
                hideKeyboardAccessoryView
                removeIosKeyboardObserver
                scrollEnabled={false}
                style={[styles.web, { backgroundColor: theme.bg }]}
              />
            </PageScrollTop>
          ) : null}
          {painted ? null : <LoadingLines theme={theme} reduceMotion={reduceMotion} />}
        </>
      )}
      {explaining ? (
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={() => setExplaining(false)}
          accessibilityElementsHidden
        >
          <View
            style={[
              styles.popover,
              { top: 4, backgroundColor: theme.raised, borderColor: theme.raisedLine },
            ]}
          >
            <Text style={[styles.popoverText, { color: theme.ink }]}>{explanationOf(markKey)}</Text>
          </View>
        </Pressable>
      ) : null}
    </View>
  );
}
