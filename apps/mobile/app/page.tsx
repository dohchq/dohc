import { documentWords } from "@dohc/interface-words/documents";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { AlertTriangle, Lock, LoaderCircle } from "lucide-react-native";
import { useEffect, useMemo, useRef, useState, type ComponentRef, type ReactNode } from "react";
import { PixelRatio, Pressable, StyleSheet, Text, View } from "react-native";
import Animated, { FadeIn, useReducedMotion } from "react-native-reanimated";
import { Directory, File, Paths } from "expo-file-system";
import { useKeyboardState } from "react-native-keyboard-controller";
import { WebView } from "react-native-webview";
import { confirm } from "../src/confirm";
import { copyText } from "../src/copy";
import { demoMode } from "../src/demo";
import { DohcMark } from "../src/DohcMark";
import { ActionPill } from "../src/notices/ActionPill";
import { SyncBand } from "../src/notices/SyncBand";
import { editorFolderUri, editorFontFiles, editorHtmlUri, isOutOfSpace } from "../src/pages/editorFile";
import { editAnywayMessage, pageFailureAction, pageNotices, type PageHandlers } from "../src/pages/pageNotices";
import { samplePages } from "../src/pages/sample";
import { useTheme, type Theme } from "../src/theme";

type Failure = "couldntRead" | "couldntOpen" | "noLongerAvailable";
type MarkKey = keyof typeof documentWords.mark | "opening";
type MarkShape = "held" | "attention" | "working";

// Stands in for the server's answers until the phone opens live documents. Design review only.
const demo = {
  failure: demoMode === "page-fail-read" ? "couldntRead" as const : demoMode === "page-fail-missing" ? "noLongerAvailable" as const : null,
  opening: demoMode === "page-opening",
  couldNotOpen: demoMode === "page-fail-open",
  deleted: demoMode === "page-deleted" || demoMode === "page-deleted-explain",
  offline: demoMode === "page-offline",
};

// A page, as on the desktop: its name in the header, then icon, title, properties and body in one scroll.
// Calm states (saved, saving) draw nothing; anything else shows a mark beside the menu, and a tap explains it.
export default function Page() {
  const theme = useTheme();
  const router = useRouter();
  const { path = "trip/packing-list.md", t0, run = "1" } = useLocalSearchParams<{ path?: string; t0?: string; run?: string }>();
  const page = samplePages[path];
  const name = path.split("/").pop() ?? path;
  // "page-lossy-consented" shows the page as it is after Edit anyway is confirmed (design review only).
  const [consented, setConsented] = useState(demoMode === "page-lossy-consented");
  // In this sample, Try again succeeds: the page opens as it would once the server answers.
  const [retried, setRetried] = useState(false);
  // The web view lost its page (loading failed or its process ended). Try again mounts a fresh one.
  // How the page was lost, if it was: "noSpace" when the editor files couldn't be written for lack of space.
  const [lostPage, setLostPage] = useState<false | "failed" | "noSpace">(false);
  const [attempt, setAttempt] = useState(0);
  const [uri, setUri] = useState<string | null>(null);
  // Design review only: a page file that isn't there, so the real load fails and the page shows its failure.
  // The editor files couldn't be written (a full disk, say): the page shows the could-not-open strip, and Try again
  // prepares them again.
  useEffect(() => {
    let current = true;
    // Design review only: the first preparation fails, as a full disk would make it.
    // Design review only: the first preparation fails, as a failed write would; "page-no-space" fails it with the
    // system's out-of-space message.
    const prepare = attempt === 0 && demoMode === "page-cache-fails" ? Promise.reject(new Error("demo"))
      : attempt === 0 && demoMode === "page-no-space" ? Promise.reject(new Error("No space left on device"))
      : editorHtmlUri();
    prepare.then(
      found => {
        // Design review only: the first open finds the page's font files gone, so its fonts can't load.
        if (attempt === 0 && demoMode === "page-fonts-missing") for (const font of editorFontFiles) { try { font.delete(); } catch { /* already gone */ } }
        if (current) setUri(demoMode === "page-load-fails" ? found.replace(/page\.html$/, "missing.html") : found);
      },
      error => { if (current) setLostPage(isOutOfSpace(error) ? "noSpace" : "failed"); },
    );
    return () => { current = false; };
  }, [attempt]);
  const [explaining, setExplaining] = useState(demoMode === "page-deleted-explain");
  const startedAt = useMemo(() => Number(t0) || Date.now(), [t0]);
  // Loading lines cover the page until it reports its first paint, so a slow start is never a blank page.
  const [painted, setPainted] = useState(false);
  // Design review only: once the page paints, the editor files go, as when iOS clears the cache while the app runs,
  // and the page loads again without them. Try again must then open it.
  const [reload, setReload] = useState(0);
  useEffect(() => {
    if (demoMode !== "page-cache-cleared" || !painted || reload > 0 || attempt > 0) return;
    try { new Directory(editorFolderUri).delete(); } catch { /* already gone */ }
    setPainted(false);
    setReload(1);
  }, [painted]);
  // When the screen first rendered, to tell React Native's share of the time from the web view's.
  const mountAt = useRef(Date.now());
  // When the page's Inter faces had loaded, just before it drew: the part of the first text that waits for the font.
  const fontsAt = useRef<number | null>(null);
  const reduceMotion = useReducedMotion();

  const markKey: MarkKey | null = demo.deleted ? "deleted" : demo.offline ? "readOnlyOffline" : demo.opening ? "opening"
    : page?.large ? "tooLarge" : null;
  const lossy = page?.lossy === true && !consented;
  // A live note is always editable, as on the desktop, unless something holds it read-only.
  const couldNotOpen = demo.couldNotOpen && !retried;
  const editable = page !== undefined && !page.large && !lossy && markKey === null && !couldNotOpen;
  const web = useRef<ComponentRef<typeof WebView>>(null);
  useEffect(() => { web.current?.injectJavaScript(`window.__dohcSetEditable?.(${editable}); true;`); }, [editable]);
  // "Done" is the system's word for closing the keyboard (a platform difference): it shows only while typing.
  const typing = useKeyboardState(state => state.isVisible);
  // WKWebView's own keyboard handling is off (it moved the page on every tap), so the page hears how much the
  // keyboard covers and keeps the caret above it.
  const keyboardHeight = useKeyboardState(state => (state.isVisible ? state.height : 0));
  useEffect(() => { web.current?.injectJavaScript(`window.__dohcKeyboard?.(${keyboardHeight}); true;`); }, [keyboardHeight]);
  const endEditing = () => web.current?.injectJavaScript("window.__dohcEndEditing?.(); true;");
  // A large file has no editor, and a page that didn't load has no web view: both copy the text as it was read.
  const copyMarkdown = () => {
    if (!page) return;
    if (page.large || !web.current) { copyText(page.markdown); return; }
    web.current.injectJavaScript(`(window.__dohcCopyMarkdown ?? (() => window.ReactNativeWebView?.postMessage('{"kind":"markdownUnavailable"}')))(); true;`);
  };
  // A page whose view couldn't load shows nothing to read, so it takes the page-level failure, as Couldn't read does.
  // A path with no page stays missing whatever Try again does; Try again clears only a demo's failure.
  const failure: Failure | null = lostPage ? "couldntOpen" : page === undefined ? "noLongerAvailable" : retried ? null : demo.failure;

  const editAnyway = async () => {
    const sure = await confirm({
      title: documentWords.editAnywayTitle, message: editAnywayMessage(page?.history ?? null),
      confirm: documentWords.editAnyway, destructive: true,
    });
    if (sure) setConsented(true);
  };

  const handlers: PageHandlers = {
    retry: () => {
      // The web view waits for the editor files to be prepared again, so it never loads a file that's gone.
      if (lostPage) { setLostPage(false); setPainted(false); setUri(null); setAttempt(value => value + 1); } else setRetried(true);
    },
    editAnyway: () => void editAnyway(),
  };

  // Design review only: open the Edit anyway sheet without a tap.
  useEffect(() => {
    if (demoMode !== "page-lossy-sheet") return;
    const timer = setTimeout(() => void editAnyway(), 900);
    return () => clearTimeout(timer);
  }, []);

  // Time from the tap to the first text on screen, kept for launch measurements.
  const handleMessage = (raw: string) => {
    let data: unknown;
    try { data = JSON.parse(raw); } catch { return; }
    if (typeof data !== "object" || data === null || !("kind" in data)) return;
    // The typing report has no time stamp of its own, so it's handled before the timed messages.
    if (data.kind === "typing") { void new File(Paths.document, "page-typing.json").write(JSON.stringify({ path, ...data })); return; }
    // The editor's answer to Copy as Markdown: the page with the person's edits.
    if (data.kind === "markdown" && "markdown" in data && typeof data.markdown === "string") { copyText(data.markdown); return; }
    if (data.kind === "markdownUnavailable") { if (page) copyText(page.markdown); return; }
    if (!("at" in data) || typeof data.at !== "number") return;
    if (data.kind === "fonts") { fontsAt.current = data.at; return; }
    // The page's fonts didn't load, so it didn't draw: the could-not-open strip, and Try again mounts a fresh page.
    if (data.kind === "fontsFailed") { setLostPage("failed"); return; }
    if (data.kind === "painted") {
      setPainted(true);
      // A file the simulator script reads, as the editor test does; nothing shows on screen.
      void new File(Paths.document, `page-first-text-${run}.json`).write(JSON.stringify({ path, run: Number(run), t0: startedAt, ms: Math.round(data.at - startedAt),
        mountMs: Math.round(mountAt.current - startedAt), fontsMs: fontsAt.current === null ? null : Math.round(fontsAt.current - startedAt) }));
      // Design review only: "page-warm" opens the page again three times in the same run, for warm timings.
      if (demoMode === "page-warm" && Number(run) < 4) {
        setTimeout(() => router.replace({ pathname: "/page", params: { path, t0: String(Date.now()), run: String(Number(run) + 1) } }), 800);
      }
    }
  };

  // The page and its settings, injected before the page script runs.
  const pageJson = page ? JSON.stringify({
    title: page.title, icon: page.icon, properties: page.properties, markdown: page.markdown, large: page.large === true, editable,
    textScale: PixelRatio.getFontScale(), autotype: demoMode === "page-type",
  }) : "null";
  const injected = page ? `window.__dohcPage = ${pageJson}; true;` : undefined;

  return (
    <View style={[styles.screen, { backgroundColor: theme.bg }]}>
      {/* The file's name, and under it the mark when there is one, as a conversation's name sits over its members. */}
      <Stack.Screen options={{
        title: name, headerLargeTitle: false, headerTransparent: false, headerStyle: { backgroundColor: theme.bg }, headerShadowVisible: false,
        // With a mark, the whole title block is the tap target, as iOS treats a tappable title.
        headerTitle: () => markKey ? (
          <Pressable onPress={() => setExplaining(value => !value)} style={[styles.headerTitle, styles.titleTarget]} accessibilityRole="button"
            accessibilityLabel={`${name}, ${labelOf(markKey)}`} accessibilityValue={{ text: explanationOf(markKey) }}>
            <Text style={[styles.name, { color: theme.ink }]} numberOfLines={1}>{name}</Text>
            <Mark markKey={markKey} theme={theme} />
          </Pressable>
        ) : (
          <Text style={[styles.name, { color: theme.ink }]} numberOfLines={1} accessibilityRole="header">{name}</Text>
        ),
      }} />
      <Stack.Toolbar placement="right">
        {typing ? <Stack.Toolbar.Button variant="done" onPress={endEditing}>Done</Stack.Toolbar.Button> : null}
        <Stack.Toolbar.Button hidden={typing} icon="bubble.left" accessibilityLabel={documentWords.openChat(name)} onPress={() => router.back()} />
        <Stack.Toolbar.Menu hidden={typing} icon="ellipsis" accessibilityLabel={documentWords.documentActions}>
          <Stack.Toolbar.MenuAction icon="doc.on.doc" onPress={copyMarkdown}>{documentWords.copyAsMarkdown}</Stack.Toolbar.MenuAction>
        </Stack.Toolbar.Menu>
      </Stack.Toolbar>
      {demo.offline ? <SyncBand problem="serverUnreachable" /> : null}
      {failure ? (
        // As the desktop's empty state: a failure draws the triangle in danger, a missing thing the dohc mark.
        <View style={styles.failure}>
          {failure !== "noLongerAvailable"
            ? <AlertTriangle size={22} color={theme.danger} strokeWidth={1.9} />
            : <DohcMark size={30} color={theme.line} />}
          <Text style={[styles.failureText, { color: theme.muted }]}>{documentWords[failure]}</Text>
          {/* Try again helps only once space is freed, so the page says what to do first. */}
          {lostPage === "noSpace" ? <Text style={[styles.failureText, { color: theme.muted }]}>{documentWords.notEnoughStorage}</Text> : null}
          {/* A file that's gone has nothing to try again: only a failure Try again can fix offers it. */}
          {failure === "noLongerAvailable" ? null : <ActionPill label={pageFailureAction.label} onPress={handlers[pageFailureAction.name]} />}
        </View>
      ) : page ? (
        <>
          {pageNotices({ couldNotOpen, lossy, large: page.large === true }).map(notice => (
            <Strip key={notice.key} theme={theme} icon="lock" text={notice.text} action={notice.action?.label}
              onAction={notice.action ? handlers[notice.action.name] : undefined} />
          ))}
          {!uri ? null : (
            <WebView
              key={`${attempt}:${reload}`}
              ref={web}
              originWhitelist={["file://*"]}
              source={{ uri }}
              // Read access to the editor's folder only: the page never reads the rest of the app's files.
              allowingReadAccessToURL={editorFolderUri}
              allowFileAccess
              injectedJavaScriptBeforeContentLoaded={injected}
              onMessage={event => handleMessage(event.nativeEvent.data)}
              onError={() => setLostPage("failed")}
              onContentProcessDidTerminate={() => setLostPage("failed")}
              keyboardDisplayRequiresUserAction={false}
              // WebKit's own bar above the keyboard repeats Done; the header's system Done is the one way out.
              hideKeyboardAccessoryView
              removeIosKeyboardObserver
              // The page scrolls inside its own container; the web view itself never scrolls.
              scrollEnabled={false}
              style={[styles.web, { backgroundColor: theme.bg }]}
            />
          )}
          {painted ? null : <LoadingLines theme={theme} reduceMotion={reduceMotion} />}
        </>
      ) : null}
      {explaining && markKey ? (
        <Pressable style={StyleSheet.absoluteFill} onPress={() => setExplaining(false)} accessibilityElementsHidden>
          <View style={[styles.popover, { top: 4, backgroundColor: theme.raised, borderColor: theme.raisedLine }]}>
            <Text style={[styles.popoverText, { color: theme.ink }]}>{explanationOf(markKey)}</Text>
          </View>
        </Pressable>
      ) : null}
    </View>
  );
}

function labelOf(key: MarkKey): string { return key === "opening" ? documentWords.opening : documentWords.mark[key].label; }
function explanationOf(key: MarkKey): string { return key === "opening" ? documentWords.openingExplanation : documentWords.mark[key].explanation; }
function shapeOf(key: MarkKey): MarkShape { return key === "opening" ? "working" : key === "deleted" || key === "couldntSave" ? "attention" : "held"; }

// The desktop's StateMark: a lock for held, a triangle for attention, a ring for working; the label beside it.
function Mark({ markKey, theme }: { markKey: MarkKey; theme: Theme }) {
  const shape = shapeOf(markKey);
  const color = shape === "attention" ? theme.danger : theme.muted;
  const icon: ReactNode = shape === "held" ? <Lock size={11} color={color} strokeWidth={2.5} />
    : shape === "attention" ? <AlertTriangle size={11} color={color} strokeWidth={2.5} />
    : <LoaderCircle size={11} color={color} strokeWidth={2.5} />;
  return (
    <View style={styles.mark}>
      {icon}
      <Text style={[styles.markText, { color }]}>{labelOf(markKey)}</Text>
    </View>
  );
}

// The desktop's document loading lines (ui/SkeletonRows.tsx, layout "document"): nothing for 150 ms, so a fast
// open never flashes; then one 120 ms fade, none under Reduce Motion. Static, four lines where the text will land.
function LoadingLines({ theme, reduceMotion }: { theme: Theme; reduceMotion: boolean }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setShown(true), 150);
    return () => clearTimeout(timer);
  }, []);
  return (
    <View style={[styles.loading, { backgroundColor: theme.bg }]} accessible accessibilityLabel={documentWords.loading}>
      {shown ? (
        <Animated.View entering={reduceMotion ? undefined : FadeIn.duration(120)} style={styles.loadingLines}>
          {[0.8, 0.62, 0.9, 0.54].map((width, index) => (
            <View key={index} style={[styles.loadingLine, { width: `${width * 100}%`, backgroundColor: inkAt(theme.ink, 0.07) }]} />
          ))}
        </Animated.View>
      ) : null}
    </View>
  );
}

function inkAt(hex: string, alpha: number): string {
  const value = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
}

// A notice across the top of the page, as the desktop's strip above a document.
function Strip({ theme, icon, text, action, onAction }: { theme: Theme; icon: "lock"; text: string; action?: string; onAction?(): void }) {
  return (
    <View style={[styles.strip, { backgroundColor: theme.panel2, borderBottomColor: theme.line }]}>
      <View style={styles.stripIcon}>{icon === "lock" ? <Lock size={16} color={theme.warning} strokeWidth={2} /> : null}</View>
      <View style={styles.stripMain}>
        <Text style={[styles.stripText, { color: theme.warning }]}>{text}</Text>
        {action ? <View style={styles.stripActions}><ActionPill label={action} onPress={onAction} /></View> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  web: { flex: 1 },
  // Where the page's text lands: the web view's 16 pt inset, under the icon's top margin.
  loading: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, paddingHorizontal: 16, paddingTop: 24 },
  loadingLines: { gap: 9 },
  loadingLine: { height: 8, borderRadius: 4 },
  failure: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12, paddingHorizontal: 32, paddingBottom: 80 },
  failureText: { fontSize: 15, lineHeight: 20, textAlign: "center" },
  headerTitle: { alignItems: "center", maxWidth: 220 },
  titleTarget: { minHeight: 44, justifyContent: "center", paddingHorizontal: 8 },
  name: { fontSize: 17, fontWeight: "600" },
  mark: { flexDirection: "row", alignItems: "center", gap: 4 },
  markText: { fontSize: 12, fontWeight: "500" },
  popover: { position: "absolute", alignSelf: "center", left: 40, right: 40, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, padding: 12,
    shadowColor: "#000", shadowOpacity: 0.14, shadowRadius: 16, shadowOffset: { width: 0, height: 6 } },
  popoverText: { fontSize: 15, lineHeight: 20 },
  strip: { flexDirection: "row", gap: 10, paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  stripIcon: { paddingTop: 2 },
  stripMain: { flex: 1, gap: 8 },
  stripText: { fontSize: 15, lineHeight: 20 },
  stripActions: { flexDirection: "row" },
});
