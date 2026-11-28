import { workspaceWords } from "@dohc/interface-words/workspace";
import type { File } from "expo-file-system";
import { Stack, useLocalSearchParams } from "expo-router";
import { File as FileIcon, Share as ShareIcon } from "lucide-react-native";
import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { WebView } from "react-native-webview";
import { useAccount, useSignIn } from "../account/AccountProvider";
import { useShowToast } from "../notices/Toast";
import {
  classifyFilePreview,
  downloadCollectionAttachment,
  downloadWorkspaceFile,
  formatByteSize,
  writeCachedBinary,
  type FilePreview,
} from "../server/binaryFiles";
import { ServerError, shownProblem } from "../server/client";
import { useTheme } from "../theme";
import { ripple, TOUCH } from "../touch";
import { ScreenFailure } from "../workspace/ListStates";
import { useProblemText } from "../workspace/useView";

type Loaded = { uri: string; file: File; size: number; preview: FilePreview };
type State =
  | { status: "loading" }
  | { status: "ready"; loaded: Loaded }
  | { status: "missing" }
  | { status: "failed"; cause: ReturnType<typeof shownProblem> };

export function FileViewerScreen() {
  const params = useLocalSearchParams<{
    path?: string;
    datasetId?: string;
    tableId?: string;
    recordId?: string;
    recordIdNum?: string;
    fieldId?: string;
    fileId?: string;
    name?: string;
  }>();
  const theme = useTheme();
  const signIn = useSignIn();
  const { data } = useAccount();
  const problemText = useProblemText();
  const showToast = useShowToast();
  const workspaceId = data?.workspaceId ?? null;
  const attachment =
    params.datasetId && params.tableId && params.fieldId && params.fileId && params.recordId
      ? {
          datasetId: params.datasetId,
          tableId: params.tableId,
          recordId: params.recordIdNum === "1" ? Number(params.recordId) : params.recordId,
          fieldId: params.fieldId,
          fileId: params.fileId,
        }
      : null;
  const filePath = !attachment && params.path ? params.path : null;
  const title = params.name || (filePath ? filePath.slice(filePath.lastIndexOf("/") + 1) : "File");
  const [state, setState] = useState<State>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!workspaceId || (!filePath && !attachment)) {
      setState({ status: "missing" });
      return;
    }
    const controller = new AbortController();
    let activeFile: File | null = null;
    const remove = (file: File | null) => {
      if (!file) return;
      try {
        if (file.exists) file.delete();
      } catch {}
    };
    setState({ status: "loading" });
    void (async () => {
      try {
        const bytes = filePath
          ? await downloadWorkspaceFile(signIn.client, workspaceId, filePath, controller.signal)
          : await downloadCollectionAttachment(
              signIn.client,
              workspaceId,
              attachment!,
              controller.signal,
            );
        if (controller.signal.aborted || !signIn.isCurrent()) return;
        const preview = classifyFilePreview(title, bytes);
        const cached = await writeCachedBinary(title, bytes);
        if (!cached || controller.signal.aborted || !signIn.isCurrent()) {
          remove(cached?.file ?? null);
          return;
        }
        activeFile = cached.file;
        setState({ status: "ready", loaded: { ...cached, size: bytes.byteLength, preview } });
      } catch (error) {
        if (controller.signal.aborted || !signIn.isCurrent()) return;
        if (error instanceof ServerError && error.problem === "not-found") {
          setState({ status: "missing" });
          return;
        }
        const cause = shownProblem(error);
        if (cause !== null) setState({ status: "failed", cause });
      }
    })();
    return () => {
      controller.abort();
      remove(activeFile);
      activeFile = null;
    };
  }, [
    workspaceId,
    filePath,
    attachment?.datasetId,
    attachment?.tableId,
    attachment?.recordId,
    attachment?.fieldId,
    attachment?.fileId,
    title,
    signIn,
    attempt,
  ]);

  const openExternal = useCallback(
    async (loaded: Loaded) => {
      try {
        if (Platform.OS === "ios") {
          await Share.share({ url: loaded.uri, title });
        } else if (loaded.preview.kind === "pdf") {
          await loaded.file.preview({ title, mimeType: "application/pdf" });
        } else {
          try {
            await loaded.file.preview({ title });
          } catch {
            await loaded.file.preview({
              title,
              mimeType: loaded.preview.kind === "text" ? "text/plain" : "application/octet-stream",
            });
          }
        }
      } catch {
        showToast({ tone: "failure", title: workspaceWords.fileOpenFailed });
      }
    },
    [showToast, title],
  );
  const actionLabel =
    Platform.OS === "ios" ? workspaceWords.shareFile : workspaceWords.openInAnotherApp;

  return (
    <View style={[styles.flex, { backgroundColor: theme.bg }]}>
      <Stack.Screen
        options={{
          title,
          headerRight:
            state.status === "ready"
              ? () => (
                  <Pressable
                    onPress={() => void openExternal(state.loaded)}
                    hitSlop={8}
                    android_ripple={ripple(theme, true)}
                    style={styles.headerBtn}
                    accessibilityRole="button"
                    accessibilityLabel={actionLabel}
                  >
                    <ShareIcon size={20} color={theme.ink} strokeWidth={2} />
                  </Pressable>
                )
              : undefined,
        }}
      />
      {state.status === "loading" ? (
        <View style={styles.center}>
          <ActivityIndicator />
        </View>
      ) : state.status === "missing" ? (
        <ScreenFailure text={workspaceWords.fileMissing} />
      ) : state.status === "failed" ? (
        <ScreenFailure
          text={workspaceWords.fileReadFailed}
          cause={state.cause ? problemText(state.cause) : undefined}
          onRetry={() => setAttempt((n) => n + 1)}
        />
      ) : state.loaded.preview.kind === "image" ? (
        <Image
          source={{ uri: state.loaded.uri }}
          style={styles.image}
          resizeMode="contain"
          accessibilityLabel={title}
        />
      ) : state.loaded.preview.kind === "pdf" && Platform.OS === "ios" ? (
        <WebView
          source={{ uri: state.loaded.uri }}
          allowingReadAccessToURL={state.loaded.uri}
          // Keep every URL inside onShouldStartLoadWithRequest; a narrow originWhitelist triggers Linking.openURL first.
          originWhitelist={["*"]}
          javaScriptEnabled={false}
          onShouldStartLoadWithRequest={(req) => req.url === state.loaded.uri}
          style={styles.flex}
        />
      ) : state.loaded.preview.kind === "text" ? (
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={styles.textWrap}
        >
          <Text selectable style={[styles.mono, { color: theme.ink }]}>
            {state.loaded.preview.text}
          </Text>
        </ScrollView>
      ) : (
        <View style={styles.center}>
          <FileIcon size={40} color={theme.subtle} strokeWidth={1.6} />
          <Text style={[styles.name, { color: theme.ink }]} numberOfLines={2}>
            {title}
          </Text>
          <Text style={[styles.meta, { color: theme.muted }]}>
            {formatByteSize(state.loaded.size)}
          </Text>
          <Text style={[styles.note, { color: theme.subtle }]}>
            {state.loaded.preview.kind === "other" && state.loaded.preview.reason === "too-large"
              ? workspaceWords.fileTextTooLarge
              : workspaceWords.filePreviewUnavailable}
          </Text>
          <Pressable
            onPress={() => void openExternal(state.loaded)}
            android_ripple={ripple(theme)}
            style={({ pressed }) => [
              styles.openBtn,
              { backgroundColor: theme.panel, borderColor: theme.line },
              pressed && { backgroundColor: theme.panel2 },
            ]}
            accessibilityRole="button"
          >
            <Text style={[styles.openBtnText, { color: theme.accent }]}>{actionLabel}</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  image: { flex: 1, width: "100%" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 10 },
  headerBtn: { minHeight: TOUCH, minWidth: TOUCH, alignItems: "center", justifyContent: "center" },
  textWrap: { padding: 16 },
  mono: { fontSize: 14, lineHeight: 20, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace" },
  name: { fontSize: 17, fontWeight: "600", textAlign: "center" },
  meta: { fontSize: 14 },
  note: { fontSize: 14, textAlign: "center" },
  openBtn: {
    marginTop: 8,
    minHeight: TOUCH,
    paddingHorizontal: 18,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
  },
  openBtnText: { fontSize: 16, fontWeight: "600" },
});
