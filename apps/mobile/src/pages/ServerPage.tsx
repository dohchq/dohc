import type { ServerProblemKind } from "@dohc/interface-words/account";
import { collectionWords } from "@dohc/interface-words/collections";
import { confirmWords } from "@dohc/interface-words/confirmations";
import { documentWords } from "@dohc/interface-words/documents";
import type { FieldDefinition } from "@dohc/workspace-contracts/collection";
import {
  Stack,
  useIsFocused,
  useLocalSearchParams,
  usePreventRemove,
  useRouter,
} from "expo-router";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentRef,
} from "react";
import { Check, EllipsisVertical } from "lucide-react-native";
import { Alert, PixelRatio, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { useKeyboardState } from "react-native-keyboard-controller";
import { useReducedMotion } from "react-native-reanimated";
import { WebView } from "react-native-webview";
import { PageScrollTop } from "../../modules/page-scroll-top";
import { useAccount, useSignIn } from "../account/AccountProvider";
import { HeaderButton } from "../AndroidHeader";
import { useShownWorkspaces } from "../chats/Workspaces";
import { PropertyEditorSheet } from "../collections/DocumentCollectionScreens";
import { copyText, useCopiedMark } from "../copy";
import { useFileLifecycle } from "../home/FileNameSheet";
import { pageTitle } from "../home/homeModel";
import { shownProblem } from "../server/client";
import {
  canWriteFiles,
  isLifecycleManagedPath,
  newFileRequestId,
  parentFolder,
} from "../server/fileWrites";
import type { RecordValue } from "../server/phoneCollections";
import { documentCollectionWrites } from "../server/phoneDocumentCollections";
import { phoneWrites } from "../server/phoneWrites";
import { views } from "../server/workspaceData";
import { useTheme } from "../theme";
import { TOUCH } from "../touch";
import { NoWorkspace, ScreenFailure, useWorkspaceGap } from "../workspace/ListStates";
import { useKeptContentProblem, useProblemText, useView } from "../workspace/useView";
import { documentActions } from "./documentActions";
import { editorFolderUri, editorHtmlUri, isOutOfSpace } from "./editorFile";
import { createPageHost, createPageMountHold } from "./pageHost";
import { createPageLive, holdsPage, holdsUnsent, liveMark, type PageLiveState } from "./pageLive";
import { unwrittenText } from "./pageNotices";
import { pageTimings, timingOwner } from "./pageTimings";
import {
  explanationOf,
  labelOf,
  LoadingLines,
  Mark,
  pageStyles as styles,
  Strip,
  type MarkKey,
} from "./pageParts";

type PageParams = { path?: string; workspace?: string; t0?: string };
const inferPropertyField = (key: string, value: RecordValue): FieldDefinition => {
  if (typeof value === "boolean") return { name: key, type: "checkbox" };
  if (typeof value === "number") return { name: key, type: "number" };
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value))
    return { name: key, type: "date" };
  if (typeof value === "string" && /^https?:\/\//i.test(value)) return { name: key, type: "url" };
  return { name: key, type: "text" };
};
const pageScript = (
  path: string,
  markdown: string,
  live: boolean,
  propertyFields: readonly FieldDefinition[],
  propertiesEditable: boolean,
  relationLabels: Readonly<Record<string, string>>,
) =>
  `window.__dohcPage = ${JSON.stringify({
    title: pageTitle(path),
    properties: [],
    propertyFields,
    propertiesEditable,
    relationLabels,
    emptyPropertyLabel: collectionWords.emptyProperty,
    markdown,
    large: false,
    editable: false,
    live,
    textScale: PixelRatio.getFontScale(),
    touchSize: TOUCH,
  })}; true;`;

// A page opened from a Notice names its workspace. It shows only while that workspace is the one open, so it never
// reads the page from another.
export function ServerPage() {
  const { data } = useAccount();
  const signIn = useSignIn();
  const { path = "", workspace, t0 } = useLocalSearchParams<PageParams>();
  const [hold] = useState(createPageMountHold);
  const [, setSync] = useState(0);
  const onUnsent = useCallback(
    (forKey: string, next: boolean) => {
      if (hold.setUnsent(forKey, next)) setSync((value) => value + 1);
    },
    [hold],
  );
  if (workspace !== undefined && data?.workspaceId !== workspace) {
    hold.resolve(null, null, 0, "");
    return <ElsewherePage />;
  }
  const key = hold.resolve(signIn, data?.workspaceId ?? null, data?.instance ?? 0, path);
  return (
    <PageScreen
      key={key}
      mountKey={key}
      path={path}
      tap={Number(t0) || undefined}
      onUnsent={onUnsent}
    />
  );
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
const NO_STATE: PageLiveState = {
  phase: "ended",
  reason: null,
  facts: null,
  unsent: false,
  shown: false,
};
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

function PageScreen(props: {
  mountKey: string;
  path: string;
  tap?: number;
  onUnsent: (forKey: string, unsent: boolean) => void;
}) {
  const { mountKey, path, tap, onUnsent } = props;
  const theme = useTheme();
  const router = useRouter();
  const name = path.split("/").pop() ?? path;
  const view = useMemo(() => views.page(path), [path]);
  const { state, retry } = useView(view);
  const { state: docCollectionsState } = useView(views.documentCollections);
  const { current: currentWorkspace } = useShownWorkspaces();
  const folder = parentFolder(path);
  const docCollection = useMemo(
    () => (folder ? (docCollectionsState.value?.find((c) => c.path === folder) ?? null) : null),
    [docCollectionsState.value, folder],
  );
  const insideDocCollection = useMemo(
    () =>
      Boolean(
        folder &&
        docCollectionsState.value?.some(
          (c) => folder === c.path || folder.startsWith(`${c.path}/`),
        ),
      ),
    [docCollectionsState.value, folder],
  );
  const propertyFields = useMemo(() => docCollection?.fields ?? [], [docCollection]);
  const [relationLabels, setRelationLabels] = useState<Readonly<Record<string, string>>>({});
  const [editingProp, setEditingProp] = useState<{
    readonly key: string;
    readonly field: FieldDefinition;
    readonly value: RecordValue;
  } | null>(null);
  const [propSaving, setPropSaving] = useState(false);
  const [propError, setPropError] = useState<string | null>(null);
  const pendingPropReq = useRef<string | null>(null);
  const fallbackPropReq = useRef<{
    readonly key: string;
    readonly valueJson: string;
    readonly id: string;
  } | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const problemText = useProblemText();
  const kept = useKeptContentProblem(state.problem, retry);
  const reduceMotion = useReducedMotion();
  const focused = useIsFocused();
  const { data, livePages } = useAccount();
  const signIn = useSignIn();
  const web = useRef<ComponentRef<typeof WebView>>(null);
  const [mutating, setMutating] = useState(false);

  // A page deleted while open keeps the last text its workspace's store read of it.
  const deleted = state.value?.kind === "missing" && state.value.last !== undefined;
  const read =
    state.value?.kind === "page"
      ? state.value.markdown
      : state.value?.kind === "missing"
        ? (state.value.last ?? null)
        : null;

  // The web view's page, prepared once; Try again after a lost page prepares it again.
  const [uri, setUri] = useState<string | null>(null);
  const [lostPage, setLostPage] = useState<false | "failed" | "noSpace">(false);
  const [needsNewer, setNeedsNewer] = useState(false);
  const [unwritten, setUnwritten] = useState<{ mount: number; text: string } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [host] = useState(() =>
    createPageHost({ inject: (script) => web.current?.injectJavaScript(script) }),
  );
  const { mount, painted, live, stopped } = useSyncExternalStore(host.subscribe, host.state);
  const [timing] = useState(() => pageTimings?.open(name, timingOwner(signIn), tap));
  const [started, setStarted] = useState<number | null>(null);
  const [early, setEarly] = useState<{
    mount: number;
    markdown: string | null;
    objectId: string | null;
    script?: string;
  } | null>(null);
  const given = useRef<{ mount: number; markdown: string; objectId: string | null } | null>(null);
  const sentTo = (to: number) =>
    given.current?.mount === to
      ? given.current.markdown
      : early?.mount === to
        ? early.markdown
        : null;
  const sentObjectIdTo = (to: number) =>
    given.current?.mount === to
      ? given.current.objectId
      : early?.mount === to
        ? early.objectId
        : null;
  useEffect(() => () => void host.gone(), [host]);
  // The account's teardown reaches the page from the start, before any session opens.
  const workspaceId = data?.workspaceId;
  useEffect(() => {
    if (workspaceId !== undefined) return livePages.add({ signIn, workspaceId }, host);
  }, [livePages, signIn, workspaceId, host]);
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

  const canOpenLive = phoneWrites && data !== null;
  const editsLive = canOpenLive && state.value?.kind === "page" && !stopped && !mutating;
  const liveState = useSyncExternalStore(
    live?.subscribe ?? noSession,
    live?.state ?? (() => NO_STATE),
  );
  useEffect(() => {
    const update = () => onUnsent(mountKey, live !== null && holdsUnsent(live.state()));
    update();
    return live?.subscribe(update);
  }, [live, mountKey, onUnsent]);
  const holding = live !== null && holdsPage(liveState);
  const lifecycle = useFileLifecycle(currentWorkspace?.name ?? "");
  const readObjectId = state.value?.kind === "page" ? (state.value.objectId ?? null) : null;
  const displayedReadObjectId = holding ? (sentObjectIdTo(mount) ?? readObjectId) : readObjectId;
  const objectId =
    live !== null && liveState.shown ? (liveState.objectId ?? null) : displayedReadObjectId;
  const canEditFiles =
    canWriteFiles(data, currentWorkspace) &&
    isLifecycleManagedPath(path) &&
    !deleted &&
    objectId !== null &&
    !mutating;
  const canRenameFile = canEditFiles && !insideDocCollection;
  const canWriteProps = canWriteFiles(data, currentWorkspace) && !deleted && !mutating;
  const liveProps =
    canWriteProps && live !== null && liveState.shown && liveState.facts?.status === "live";
  const fallbackProps =
    canWriteProps &&
    objectId !== null &&
    liveState.phase === "refused" &&
    liveState.reason === "live-document-without-lineage";
  const propertiesEditable = liveProps || fallbackProps;
  useEffect(() => {
    if (!painted) return;
    web.current?.injectJavaScript(
      `window.__dohcSetPropertiesEditable?.(${JSON.stringify(propertiesEditable)}); true;`,
    );
  }, [painted, propertiesEditable]);
  useEffect(() => {
    if (!painted) return;
    web.current?.injectJavaScript(
      `window.__dohcSetPropertyContext?.(${JSON.stringify({ fields: propertyFields, relationLabels })}); true;`,
    );
  }, [painted, propertyFields, relationLabels]);
  useEffect(() => {
    if (!liveProps && pendingPropReq.current !== null) {
      pendingPropReq.current = null;
      setPropSaving(false);
      setPropError(collectionWords.editPropertyFailed);
    }
  }, [liveProps]);
  const saveProperty = async (
    nextValue: RecordValue,
    nextLabels?: Readonly<Record<string, string>>,
  ) => {
    if (!editingProp || propSaving) return;
    if (nextLabels && Object.keys(nextLabels).length > 0)
      setRelationLabels((cur) => ({ ...cur, ...nextLabels }));
    if (liveProps) {
      const reqId = newFileRequestId();
      pendingPropReq.current = reqId;
      setPropSaving(true);
      setPropError(null);
      web.current?.injectJavaScript(
        `window.__dohcPatchFrontmatter?.(${JSON.stringify({ key: editingProp.key, value: nextValue, requestId: reqId })}); true;`,
      );
      return;
    }
    if (!fallbackProps || !data || !objectId) {
      setPropError(collectionWords.editPropertyFailed);
      return;
    }
    const active = data;
    const valueJson = JSON.stringify(nextValue);
    if (
      fallbackPropReq.current?.key !== editingProp.key ||
      fallbackPropReq.current.valueJson !== valueJson
    )
      fallbackPropReq.current = { key: editingProp.key, valueJson, id: newFileRequestId() };
    setPropSaving(true);
    setPropError(null);
    try {
      const res = await documentCollectionWrites(
        signIn.client,
        active.workspaceId,
      ).editRecordFields({
        path,
        expectedObjectId: objectId,
        fields: { [editingProp.key]: nextValue },
        requestId: fallbackPropReq.current.id,
      });
      if (!mountedRef.current || !signIn.isCurrent() || !active.isOpen()) return;
      if (!res.ok) {
        setPropError(res.reason);
        return;
      }
      fallbackPropReq.current = null;
      setEditingProp(null);
      active.invalidate(views.page(path), true);
      active.invalidate(views.files);
    } catch (cause) {
      if (!mountedRef.current || !signIn.isCurrent() || !active.isOpen()) return;
      const prob = shownProblem(cause);
      setPropError(prob ? problemText(prob) : collectionWords.editPropertyFailed);
    } finally {
      if (mountedRef.current) setPropSaving(false);
    }
  };
  const closeSocketBeforeMutation = async () => {
    setMutating(true);
    await host.gone();
  };
  const guardUnsent = () => {
    if (!holdsUnsent(host.state().live?.state() ?? NO_STATE)) return false;
    Alert.alert(documentWords.unsentTitle, documentWords.unsentBody, [
      { text: confirmWords.cancel, style: "cancel" },
    ]);
    return true;
  };
  const startRename = () => {
    if (!canEditFiles || !objectId || guardUnsent()) return;
    lifecycle.openRename({
      path,
      objectId,
      before: closeSocketBeforeMutation,
      onDone: (nextPath) => router.replace({ pathname: "/page", params: { path: nextPath } }),
      onCancel: () => setMutating(false),
    });
  };
  const startDelete = () => {
    if (!canEditFiles || !objectId || guardUnsent()) return;
    lifecycle.confirmDelete({
      path,
      objectId,
      guard: guardUnsent,
      before: closeSocketBeforeMutation,
      onDone: () => (router.canGoBack() ? router.back() : router.replace("/")),
      onCancel: () => setMutating(false),
    });
  };

  // A page a live session holds keeps the text its editor mounted with. A later read the phone can't show (too large,
  // missing) never takes the editor away, with edits only its provider has.
  const markdown = holding ? (sentTo(mount) ?? read) : read;
  useEffect(() => {
    if (markdown !== null) timing?.("read");
  }, [markdown, timing]);
  const reopen = () => {
    setLostPage(false);
    setUri(null);
    setAttempt((value) => value + 1);
    void host.gone();
  };

  const markKey: MarkKey = deleted
    ? "deleted"
    : live
      ? liveMark(liveState)
      : editsLive
        ? "opening"
        : "readOnlyPhone";
  const [explaining, setExplaining] = useState(false);
  const handleMessage = (raw: string, from: number) => {
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof data !== "object" || data === null || !("kind" in data)) return;
    if (data.kind === "live") live?.receive(data);
    const current = from === host.state().mount;
    if (current && data.kind === "started") setStarted(from);
    if (data.kind === "painted") host.painted(from);
    if (current && (data.kind === "started" || data.kind === "painted")) timing?.(data.kind);
    // The page's fonts didn't load, so it didn't draw: Try again mounts a fresh page.
    if (data.kind === "fontsFailed") setLostPage("failed");
    if (data.kind === "unsupportedFormat") setNeedsNewer(true);
    if (current && data.kind === "unwritten")
      setUnwritten({ mount: from, text: unwrittenText("why" in data ? data.why : null) });
    if (
      current &&
      data.kind === "propertyTap" &&
      propertiesEditable &&
      "key" in data &&
      typeof data.key === "string"
    ) {
      const val = ("value" in data ? data.value : null) as RecordValue;
      const defined = propertyFields.find((f) => f.name === data.key);
      if (
        defined
          ? Array.isArray(val) &&
            defined.type !== "multi-select" &&
            !(defined.type === "relation" && defined.many)
          : val !== null && typeof val === "object"
      )
        return;
      const field = defined ?? inferPropertyField(data.key, val);
      fallbackPropReq.current = null;
      setPropError(null);
      setPropSaving(false);
      setEditingProp({ key: data.key, field, value: val });
    }
    if (
      current &&
      (data.kind === "propertySaved" || data.kind === "propertyError") &&
      "requestId" in data &&
      data.requestId === pendingPropReq.current
    ) {
      pendingPropReq.current = null;
      setPropSaving(false);
      if (data.kind === "propertySaved") setEditingProp(null);
      else
        setPropError(
          "reason" in data && data.reason === "refused"
            ? collectionWords.propertyRefused
            : collectionWords.editPropertyFailed,
        );
    }
    // The answer to the one Copy as Markdown waiting for it; the page can't copy unasked.
    if (data.kind === "markdown" || data.kind === "markdownUnavailable") {
      const done = copying.current;
      copying.current = null;
      const text =
        "markdown" in data && typeof data.markdown === "string" ? data.markdown : markdown;
      if (text !== null) done?.(text);
    }
  };
  useEffect(() => {
    const sent = sentTo(mount);
    if (started !== mount || markdown === null || sent === markdown) return;
    if (sent !== null && live) {
      void host.gone();
      return;
    }
    if (sent !== null && !painted) return;
    given.current = { mount, markdown, objectId: displayedReadObjectId };
    web.current?.injectJavaScript(
      sent === null
        ? pageScript(
            path,
            markdown,
            canOpenLive,
            propertyFields,
            propertiesEditable,
            relationLabels,
          )
        : `window.__dohcReplaceRead?.(${JSON.stringify(markdown)}); true;`,
    );
  }, [started, mount, markdown, painted, live, path, host, early]);

  // Copy as Markdown copies the live document once the page shows it, edits included; otherwise the text as it was read.
  const copying = useRef<((text: string) => void) | null>(null);
  const [copied, markCopied] = useCopiedMark();
  const copyMarkdown = (then?: () => void) => {
    const done = (text: string) => {
      copyText(text);
      markCopied();
      then?.();
    };
    if (web.current && live && liveState.phase !== "ended" && liveState.shown) {
      copying.current = done;
      web.current.injectJavaScript(
        `(window.__dohcCopyMarkdown ?? (() => window.ReactNativeWebView?.postMessage('{"kind":"markdownUnavailable"}')))(); true;`,
      );
    } else if (markdown !== null) done(markdown);
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
    if (!painted) return;
    web.current?.injectJavaScript(`window.__dohcKeyboard?.(${keyboardHeight}); true;`);
  }, [keyboardHeight, painted]);
  const endEditing = () => web.current?.injectJavaScript("window.__dohcEndEditing?.(); true;");

  // No workspace open, as when another device hid the last one: the page says why, as Home and Chats do.
  const gap = useWorkspaceGap();
  const failure = gap ? (
    <NoWorkspace />
  ) : needsNewer ? (
    <ScreenFailure text={documentWords.needsNewerDohc} />
  ) : state.value?.kind === "missing" && !deleted && !holding ? (
    <ScreenFailure text={documentWords.noLongerAvailable} />
  ) : state.value?.kind === "too-large" && !holding ? (
    <ScreenFailure text={documentWords.tooLargeToOpen} />
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
  // A session whose web view is gone has no provider left: it ends, and the next web view to draw opens the page again.
  const webShown = failure === null && uri !== null;
  if (webShown && early?.mount !== mount)
    setEarly({
      mount,
      markdown,
      objectId: displayedReadObjectId,
      script:
        markdown === null
          ? undefined
          : pageScript(
              path,
              markdown,
              canOpenLive,
              propertyFields,
              propertiesEditable,
              relationLabels,
            ),
    });
  useEffect(() => {
    if (!webShown) void host.gone();
  }, [webShown]);
  useEffect(() => {
    if (markdown === null && !holding && sentTo(mount) !== null) void host.gone();
  }, [markdown, holding, mount]);
  useEffect(() => {
    if (!editsLive || !webShown || !data) return;
    host.open((post) =>
      createPageLive({ client: signIn.client, workspaceId: data.workspaceId, path, post }),
    );
  }, [editsLive, webShown, painted, live, data, signIn, path]);

  // What stopped editing, under the header, with Try again when another open may work.
  const lostReason = liveState.phase === "lost" ? liveState.reason : null;
  const liveStrip =
    liveState.phase === "refused" &&
    (liveState.reason !== "read-only" || liveState.shown || liveState.unsent) ? (
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
          headerRight:
            Platform.OS === "android" && markdown !== null
              ? () =>
                  typing ? (
                    <HeaderButton label="Done" onPress={endEditing} />
                  ) : (
                    <HeaderButton
                      icon={copied ? Check : EllipsisVertical}
                      label={documentWords.documentActions}
                      onPress={() =>
                        void documentActions({
                          copyMarkdown: () => copyMarkdown(),
                          ...(canRenameFile ? { rename: startRename } : {}),
                          ...(canEditFiles ? { remove: startDelete } : {}),
                        })
                      }
                    />
                  )
              : undefined,
        }}
      />
      {Platform.OS !== "ios" || markdown === null ? null : (
        <Stack.Toolbar placement="right">
          {typing ? (
            <Stack.Toolbar.Button variant="done" onPress={endEditing}>
              Done
            </Stack.Toolbar.Button>
          ) : null}
          <Stack.Toolbar.Menu
            hidden={typing}
            icon={copied ? "checkmark" : "ellipsis"}
            accessibilityLabel={documentWords.documentActions}
          >
            <Stack.Toolbar.MenuAction icon="doc.on.doc" onPress={() => copyMarkdown()}>
              {documentWords.copyAsMarkdown}
            </Stack.Toolbar.MenuAction>
            {canRenameFile ? (
              <Stack.Toolbar.MenuAction icon="pencil" onPress={startRename}>
                {documentWords.rename}
              </Stack.Toolbar.MenuAction>
            ) : null}
            {canEditFiles ? (
              <Stack.Toolbar.MenuAction icon="trash" destructive onPress={startDelete}>
                {confirmWords.delete}
              </Stack.Toolbar.MenuAction>
            ) : null}
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
          {unwritten?.mount === mount ? (
            <Strip
              theme={theme}
              icon="failed"
              text={unwritten.text}
              action={documentWords.dismiss}
              onAction={() => setUnwritten(null)}
            />
          ) : null}
          {webShown ? (
            <PageScrollTop key={mount} active={focused} ready={painted} style={styles.web}>
              <WebView
                ref={web}
                originWhitelist={["file://*"]}
                source={{ uri }}
                // Read access to the editor's folder only: the page never reads the rest of the app's files.
                allowingReadAccessToURL={editorFolderUri}
                allowFileAccess
                injectedJavaScriptBeforeContentLoaded={
                  early?.mount === mount ? early.script : undefined
                }
                onMessage={(event) => handleMessage(event.nativeEvent.data, mount)}
                onError={() => setLostPage("failed")}
                onContentProcessDidTerminate={() => setLostPage("failed")}
                onRenderProcessGone={() => setLostPage("failed")}
                keyboardDisplayRequiresUserAction={false}
                // WebKit's own bar above the keyboard repeats Done; the header's system Done is the one way out.
                hideKeyboardAccessoryView
                removeIosKeyboardObserver
                scrollEnabled={false}
                // The page scales its text by the system's size (`textScale`); Android's web view would scale it again.
                textZoom={100}
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
      {lifecycle.sheet}
      <PropertyEditorSheet
        open={editingProp !== null}
        field={editingProp?.field ?? null}
        value={editingProp?.value ?? null}
        saving={propSaving}
        allowDismissWhileSaving={liveProps}
        error={propError}
        relationLabels={relationLabels}
        onClose={() => {
          if (!propSaving || liveProps) {
            pendingPropReq.current = null;
            setPropSaving(false);
            setEditingProp(null);
            setPropError(null);
          }
        }}
        onSave={(val, labels) => void saveProperty(val, labels)}
      />
    </View>
  );
}
