import { useEffect, useState } from "react";
import { AppState, StyleSheet, View } from "react-native";
import { WebView } from "react-native-webview";
import { PageScrollTop } from "../../modules/page-scroll-top";
import { editorFolderUri, editorHtmlUri } from "./editorFile";

// One hidden web view, loaded with the editor page at launch and kept, so opening a page doesn't start the web
// content process from cold. It renders nothing, and never takes a status-bar tap from the page in front. When its web
// process dies, as when an app on Android uses up the shared one, it starts again once dohc is in front, so a phone
// short of memory in the background isn't asked again and again.
export function WarmEditor() {
  const [uri, setUri] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [lives, setLives] = useState(0);
  const [gone, setGone] = useState(false);
  useEffect(() => {
    if (!gone) return;
    // The editor's files may have been cleared meanwhile; asking for them again puts them back. If that fails, as on a
    // full disk, the next return to the front tries again.
    const again = () =>
      void editorHtmlUri().then(
        (next) => {
          setUri(next);
          setLoaded(false);
          setLives((count) => count + 1);
          setGone(false);
        },
        () => undefined,
      );
    if (AppState.currentState === "active") again();
    const subscription = AppState.addEventListener("change", (next) => {
      if (next === "active") again();
    });
    return () => subscription.remove();
  }, [gone]);
  const restart = () => setGone(true);
  useEffect(() => {
    void editorHtmlUri().then(setUri);
  }, []);
  if (!uri) return null;
  return (
    <View
      style={styles.hidden}
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <PageScrollTop active={false} ready={loaded} style={styles.fill}>
        <WebView
          key={lives}
          source={{ uri }}
          originWhitelist={["file://*"]}
          allowingReadAccessToURL={editorFolderUri}
          allowFileAccess
          injectedJavaScriptBeforeContentLoaded="window.__dohcWarm = true; true;"
          onLoad={() => setLoaded(true)}
          onRenderProcessGone={restart}
          onContentProcessDidTerminate={restart}
        />
      </PageScrollTop>
    </View>
  );
}

const styles = StyleSheet.create({
  hidden: { position: "absolute", width: 1, height: 1, opacity: 0 },
  fill: { flex: 1 },
});
