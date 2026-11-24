import { useImperativeHandle, useRef, type ComponentRef, type Ref } from "react";
import type { StyleProp, ViewStyle } from "react-native";
import { WebView } from "react-native-webview";
import { EditorSlot, type EditorClaim, type EditorSlotHandle } from "../../modules/editor-pool";
import { editorFolderUri } from "./editorFile";

export interface PageEditorHandle {
  inject(script: string): void;
}

interface PageEditorProps {
  ref: Ref<PageEditorHandle>;
  uri: string;
  /** The page's settings, set before the page starts. */
  startScript?: string;
  onMessage(data: string): void;
  /** The page failed to load or its web process ended. */
  onLost(): void;
  onClaim?(claim: EditorClaim): void;
  style: StyleProp<ViewStyle>;
}

function slotEditor(Slot: NonNullable<typeof EditorSlot>) {
  return function SlotEditor(props: PageEditorProps) {
    const slot = useRef<EditorSlotHandle>(null);
    useImperativeHandle(props.ref, () => ({
      inject: (script) => void slot.current?.inject(script),
    }));
    return (
      <Slot
        ref={slot}
        source={props.uri}
        folder={editorFolderUri}
        startScript={props.startScript}
        onMessage={(event) => props.onMessage(event.nativeEvent.data)}
        onLost={props.onLost}
        onClaim={(event) => props.onClaim?.(event.nativeEvent.kind)}
        style={props.style}
      />
    );
  };
}

function WebViewEditor(props: PageEditorProps) {
  const web = useRef<ComponentRef<typeof WebView>>(null);
  useImperativeHandle(props.ref, () => ({
    inject: (script) => web.current?.injectJavaScript(script),
  }));
  return (
    <WebView
      ref={web}
      originWhitelist={["file://*"]}
      source={{ uri: props.uri }}
      allowingReadAccessToURL={editorFolderUri}
      allowFileAccess
      injectedJavaScriptBeforeContentLoaded={props.startScript}
      onMessage={(event) => props.onMessage(event.nativeEvent.data)}
      onError={props.onLost}
      onContentProcessDidTerminate={props.onLost}
      onRenderProcessGone={props.onLost}
      keyboardDisplayRequiresUserAction={false}
      hideKeyboardAccessoryView
      removeIosKeyboardObserver
      scrollEnabled={false}
      textZoom={100}
      style={props.style}
    />
  );
}

/** A page's editor: one from the pool on iPhone, its own web view elsewhere. Only `inject` reaches the page. */
export const PageEditor = EditorSlot ? slotEditor(EditorSlot) : WebViewEditor;
