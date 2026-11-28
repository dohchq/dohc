import { confirmWords } from "@dohc/interface-words/confirmations";
import { documentWords } from "@dohc/interface-words/documents";
import { noticesWords } from "@dohc/interface-words/notices";
import * as Haptics from "expo-haptics";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAccount, useSignIn } from "../account/AccountProvider";
import { useBackCloses } from "../backCloses";
import { choose, confirm } from "../confirm";
import { useOptionalNotices } from "../notices/NoticesState";
import { useShowToast } from "../notices/Toast";
import { shownProblem } from "../server/client";
import {
  buildTargetPath,
  editableStem,
  fileExtension,
  fileWriteOperations,
  fileWriteRefusalText,
  newFileRequestId,
  parentFolder,
} from "../server/fileWrites";
import { views, type WorkspaceData } from "../server/workspaceData";
import { useTheme } from "../theme";
import { ripple, TOUCH } from "../touch";
import { useProblemText } from "../workspace/useView";

export interface FileTarget {
  readonly path: string;
  readonly objectId: string;
  readonly before?: () => Promise<void>;
  readonly onDone?: (path: string) => void;
  readonly onCancel?: () => void;
}

type SheetState =
  | { readonly mode: "create"; readonly onCreated: (path: string) => void }
  | ({ readonly mode: "rename" } & FileTarget);

export function useFileLifecycle(workspaceName: string) {
  const { data } = useAccount();
  const signIn = useSignIn();
  const showToast = useShowToast();
  const notices = useOptionalNotices();
  const problemText = useProblemText();
  const [sheetState, setSheetState] = useState<SheetState | null>(null);
  const [deletingPath, setDeletingPath] = useState<string | null>(null);
  const alive = useCallback(
    (active: WorkspaceData) => signIn.isCurrent() && active.isOpen(),
    [signIn],
  );
  const errorText = useCallback(
    (error: unknown, fallback: string) => {
      const problem = shownProblem(error);
      return problem ? problemText(problem) : fallback;
    },
    [problemText],
  );

  const reportDeleteFailure = useCallback(
    (path: string, body: string, retry?: () => void) => {
      if (!notices) {
        Alert.alert(documentWords.couldntDelete, body, [
          ...(retry ? [{ text: noticesWords.tryAgain, onPress: retry }] : []),
          { text: confirmWords.cancel, style: "cancel" },
        ]);
        return;
      }
      const id = `delete:${path}`;
      showToast({
        id,
        tone: "failure",
        title: documentWords.couldntDelete,
        body,
        ...(retry ? { action: { label: noticesWords.tryAgain, onPress: retry } } : {}),
      });
      notices.add({
        id,
        senderKind: null,
        senderLabel: "",
        title: documentWords.couldntDelete,
        body,
        minutesAgo: 0,
        atMs: Date.now(),
        read: false,
        ...(retry ? { retry: true, onRetry: retry } : {}),
        dismissible: true,
        failed: true,
      });
    },
    [showToast, notices],
  );

  const runDelete = useCallback(
    async (active: WorkspaceData, target: FileTarget, requestId: string) => {
      setDeletingPath(target.path);
      try {
        await target.before?.();
        if (!alive(active)) return;
        const result = await fileWriteOperations(signIn.client, active.workspaceId).deleteFile({
          path: target.path,
          expectedObjectId: target.objectId,
          requestId,
        });
        if (!alive(active)) return;
        if (!result.ok) {
          reportDeleteFailure(target.path, fileWriteRefusalText(result.refusal, result.reason));
          target.onCancel?.();
          return;
        }
        active.invalidate(views.files);
        active.invalidate(views.page(target.path), true);
        target.onDone?.(target.path);
      } catch (error) {
        if (!alive(active)) return;
        reportDeleteFailure(target.path, errorText(error, documentWords.couldntDelete), () => {
          if (alive(active)) void runDelete(active, target, requestId);
        });
        target.onCancel?.();
      } finally {
        setDeletingPath((cur) => (cur === target.path ? null : cur));
      }
    },
    [alive, errorText, reportDeleteFailure, signIn],
  );

  const confirmDelete = useCallback(
    (target: FileTarget) => {
      if (!data || deletingPath !== null) return;
      const active = data;
      void confirm({
        title: confirmWords.deleteFilesTitle([target.path]),
        message: confirmWords.deleteFilesBody(1, workspaceName),
        confirm: confirmWords.delete,
        destructive: true,
      }).then((ok) => {
        if (ok && alive(active)) void runDelete(active, target, newFileRequestId());
      });
    },
    [alive, data, deletingPath, runDelete, workspaceName],
  );

  const openCreate = useCallback(
    (onCreated: (path: string) => void) => setSheetState({ mode: "create", onCreated }),
    [],
  );
  const openRename = useCallback(
    (target: FileTarget) => setSheetState({ mode: "rename", ...target }),
    [],
  );
  const openActions = useCallback(
    (target: {
      readonly title: string;
      readonly path: string;
      readonly objectId: string;
      readonly guard?: () => boolean;
      readonly onRenamed?: (path: string) => void;
      readonly onDeleted?: () => void;
    }) => {
      if (deletingPath !== null) return;
      void choose({
        title: target.title,
        options: [
          { label: documentWords.rename },
          { label: confirmWords.delete, destructive: true },
        ],
      }).then((chosen) => {
        if (chosen === null || target.guard?.()) return;
        if (chosen === 0)
          openRename({ path: target.path, objectId: target.objectId, onDone: target.onRenamed });
        else if (chosen === 1)
          confirmDelete({ path: target.path, objectId: target.objectId, onDone: target.onDeleted });
      });
    },
    [confirmDelete, deletingPath, openRename],
  );

  const sheet = (
    <FileNameSheet
      open={sheetState !== null}
      mode={sheetState?.mode ?? "create"}
      folder={sheetState?.mode === "rename" ? parentFolder(sheetState.path) : ""}
      initialName={sheetState?.mode === "rename" ? editableStem(sheetState.path) : ""}
      extension={sheetState?.mode === "rename" ? fileExtension(sheetState.path) : ".md"}
      currentPath={sheetState?.mode === "rename" ? sheetState.path : undefined}
      onClose={() => {
        const prev = sheetState;
        setSheetState(null);
        if (prev?.mode === "rename") prev.onCancel?.();
      }}
      onSubmit={async (targetPath, requestId) => {
        if (!data || !sheetState) return { ok: false, error: documentWords.couldntCreate };
        const active = data;
        const ops = fileWriteOperations(signIn.client, active.workspaceId);
        try {
          if (sheetState.mode === "rename") {
            await sheetState.before?.();
            if (!alive(active)) return { ok: true };
          }
          const result =
            sheetState.mode === "create"
              ? await ops.createPage({ path: targetPath, requestId })
              : await ops.renameFile({
                  fromPath: sheetState.path,
                  toPath: targetPath,
                  expectedObjectId: sheetState.objectId,
                  requestId,
                });
          if (!alive(active)) return { ok: true };
          if (!result.ok)
            return { ok: false, error: fileWriteRefusalText(result.refusal, result.reason) };
          active.invalidate(views.files);
          if (sheetState.mode === "rename") active.invalidate(views.page(sheetState.path), true);
          active.invalidate(views.page(result.path), true);
          setSheetState(null);
          if (sheetState.mode === "create") sheetState.onCreated(result.path);
          else sheetState.onDone?.(result.path);
          return { ok: true };
        } catch (error) {
          if (!alive(active)) return { ok: true };
          return {
            ok: false,
            error: errorText(
              error,
              sheetState.mode === "create"
                ? documentWords.couldntCreate
                : documentWords.couldntRename,
            ),
          };
        }
      }}
    />
  );

  return { sheet, openCreate, openRename, confirmDelete, openActions, deletingPath };
}

export function FileNameSheet(props: {
  readonly open: boolean;
  readonly mode: "create" | "rename";
  readonly folder: string;
  readonly initialName: string;
  readonly extension: ".md" | ".excalidraw";
  readonly currentPath?: string;
  readonly onClose: () => void;
  readonly onSubmit: (
    targetPath: string,
    requestId: string,
  ) => Promise<{ readonly ok: true } | { readonly ok: false; readonly error: string }>;
}) {
  const { open, mode, folder, initialName, extension, currentPath, onClose, onSubmit } = props;
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const [name, setName] = useState(initialName);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!open) return;
    setName(initialName);
    setSaving(false);
    setError(null);
    requestId.current = null;
  }, [open, initialName, mode, currentPath]);

  const close = () => {
    if (!saving) onClose();
  };
  useBackCloses(open, close);

  const submit = async () => {
    if (saving) return;
    const built = buildTargetPath(folder, name, extension);
    if (!built.ok) {
      setError(built.error);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      return;
    }
    if (mode === "rename" && built.path === currentPath) return onClose();
    requestId.current ??= newFileRequestId();
    setSaving(true);
    setError(null);
    const answer = await onSubmit(built.path, requestId.current);
    if (!mounted.current) return;
    setSaving(false);
    if (answer.ok) requestId.current = null;
    else {
      setError(answer.error);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    }
  };

  const title = mode === "create" ? documentWords.newPageTitle : documentWords.renameTitle;
  const savingLabel = mode === "create" ? documentWords.creating : documentWords.saving;

  return (
    <Modal
      visible={open}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={close}
    >
      {open ? (
        <View
          style={[
            styles.sheet,
            {
              backgroundColor: theme.bg,
              paddingTop: Platform.OS === "ios" ? 8 : insets.top + 8,
              paddingBottom: insets.bottom,
            },
          ]}
        >
          <View style={[styles.header, { borderColor: theme.line }]}>
            <Pressable
              onPress={close}
              disabled={saving}
              android_ripple={ripple(theme, true)}
              style={[styles.btn, styles.side]}
              accessibilityRole="button"
            >
              <Text style={[styles.btnText, { color: saving ? theme.subtle : theme.ink }]}>
                {confirmWords.cancel}
              </Text>
            </Pressable>
            <Text style={[styles.title, { color: theme.ink }]} numberOfLines={1}>
              {title}
            </Text>
            {saving ? (
              <View style={[styles.btn, styles.side, styles.right]}>
                <ActivityIndicator accessibilityLabel={savingLabel} />
              </View>
            ) : (
              <Pressable
                onPress={() => void submit()}
                android_ripple={ripple(theme, true)}
                style={[styles.btn, styles.side, styles.right]}
                accessibilityRole="button"
              >
                <Text style={[styles.btnText, styles.strong, { color: theme.ink }]}>
                  {mode === "create" ? documentWords.create : documentWords.save}
                </Text>
              </Pressable>
            )}
          </View>
          <View style={styles.body}>
            <TextInput
              value={name}
              onChangeText={(next) => {
                setName(next);
                setError(null);
                requestId.current = null;
              }}
              placeholder={documentWords.namePlaceholder}
              placeholderTextColor={theme.subtle}
              editable={!saving}
              autoFocus
              returnKeyType="done"
              onSubmitEditing={() => void submit()}
              accessibilityLabel={title}
              style={[
                styles.input,
                {
                  color: theme.ink,
                  backgroundColor: theme.panel,
                  borderColor: error ? theme.danger : theme.line,
                },
              ]}
            />
            {saving ? (
              <Text style={[styles.note, { color: theme.muted }]}>
                {savingLabel} {documentWords.coldCopyNote}
              </Text>
            ) : null}
            {error ? (
              <Text style={[styles.note, { color: theme.danger }]} accessibilityRole="alert">
                {error}
              </Text>
            ) : null}
          </View>
        </View>
      ) : null}
    </Modal>
  );
}

const styles = StyleSheet.create({
  sheet: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 8,
    minHeight: 52,
  },
  side: { minWidth: 84 },
  right: { alignItems: "flex-end" },
  btn: { minHeight: TOUCH, justifyContent: "center", paddingHorizontal: 12 },
  btnText: { fontSize: 17 },
  strong: { fontWeight: "600" },
  title: { flex: 1, textAlign: "center", fontSize: 17, fontWeight: "600" },
  body: { padding: 16, gap: 12 },
  input: {
    fontSize: 17,
    minHeight: 48,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
  },
  note: { fontSize: 14, lineHeight: 20 },
});
