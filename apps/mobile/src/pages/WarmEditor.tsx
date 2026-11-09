import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { WebView } from "react-native-webview";
import { editorFolderUri, editorHtmlUri } from "./editorFile";

// One hidden web view, loaded with the editor page at launch and kept, so opening a page doesn't start the web
// content process from cold. It renders nothing.
export function WarmEditor() {
  const [uri, setUri] = useState<string | null>(null);
  useEffect(() => { void editorHtmlUri().then(setUri); }, []);
  if (!uri) return null;
  return (
    <View style={styles.hidden} pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <WebView source={{ uri }} originWhitelist={["file://*"]} allowingReadAccessToURL={editorFolderUri} allowFileAccess
        injectedJavaScriptBeforeContentLoaded="window.__dohcWarm = true; true;" />
    </View>
  );
}

const styles = StyleSheet.create({ hidden: { position: "absolute", width: 1, height: 1, opacity: 0 } });
