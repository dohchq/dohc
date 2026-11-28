import { confirmWords } from "@dohc/interface-words/confirmations";
import { documentWords } from "@dohc/interface-words/documents";
import { noticesWords } from "@dohc/interface-words/notices";
import * as Haptics from "expo-haptics";
import { useIsFocused } from "expo-router";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
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
import { useHideToast, useShowToast } from "../notices/Toast";
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
  readonly guard?: () => boolean;
  readonly before?: () => Promise<void>;
  readonly onDone?: (path: string) => void;
  readonly onRestored?: (path: string) => void;
  readonly onCancel?: () => void;
}

type SheetState =
  | { readonly mode: "create"; readonly onCreated: (path: string) => void }
  | ({ readonly mode: "rename" } & FileTarget);

export function useFileLifecycle(workspaceName: string) {
  const { data } = useAccount();
  const signIn = useSignIn();
  const showToast = useShowToast();
  const hideToast = useHideToast();
  const notices = useOptionalNotices();
  const problemText = useProblemText();
  const focused = useIsFocused();
  const [sheetState, setSheetState] = useState<SheetState | null>(null);
  const [deletingPath, setDeletingPath] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const focusedRef = useRef(focused);
  focusedRef.current = focused;
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  useEffect(() => {
    setSheetState(null);
  }, [data?.workspaceId]);
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

  const reportFailure = useCallback(
    (id: string, title: string, body: string, retry?: () => void, alertFallback = true) => {
      if (!notices) {
        if (!alertFallback || !mountedRef.current) return;
        Alert.alert(title, body, [
          ...(retry ? [{ text: noticesWords.tryAgain, onPress: retry }] : []),
          { text: confirmWords.cancel, style: "cancel" },
        ]);
        return;
      }
      showToast({
        id,
        tone: "failure",
        title,
        body,
        ...(retry ? { action: { label: noticesWords.tryAgain, onPress: retry } } : {}),
      });
      notices.add({
        id,
        senderKind: null,
        senderLabel: "",
        title,
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

  const runCreate = useCallback(
    async (
      active: WorkspaceData,
      targetPath: string,
      requestId: string,
      onCreated: ((path: string) => void) | undefined,
      fromSheet: boolean,
    ): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: string }> => {
      const noticeId = `create:${targetPath}`;
      try {
        const result = await fileWriteOperations(signIn.client, active.workspaceId).createPage({
          path: targetPath,
          requestId,
        });
        if (!alive(active)) return { ok: true };
        if (!result.ok) {
          const msg = fileWriteRefusalText(result.refusal, result.reason);
          if (!fromSheet) reportFailure(noticeId, documentWords.couldntCreate, msg);
          return { ok: false, error: msg };
        }
        hideToast(noticeId);
        notices?.dismiss(noticeId);
        active.invalidate(views.files);
        active.invalidate(views.page(result.path), true);
        if (mountedRef.current) {
          setSheetState(null);
          if (focusedRef.current) onCreated?.(result.path);
        }
        return { ok: true };
      } catch (error) {
        if (!alive(active)) return { ok: true };
        const msg = errorText(error, documentWords.couldntCreate);
        reportFailure(
          noticeId,
          documentWords.couldntCreate,
          msg,
          () => {
            if (!alive(active)) return;
            void runCreate(
              active,
              targetPath,
              requestId,
              mountedRef.current ? onCreated : undefined,
              false,
            );
          },
          !fromSheet,
        );
        return { ok: false, error: msg };
      }
    },
    [alive, errorText, hideToast, notices, reportFailure, signIn],
  );

  const runRename = useCallback(
    async (
      active: WorkspaceData,
      target: FileTarget,
      targetPath: string,
      requestId: string,
      fromSheet: boolean,
    ): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: string }> => {
      const noticeId = `rename:${target.path}`;
      if (mountedRef.current && target.guard?.())
        return { ok: false, error: documentWords.couldntRename };
      try {
        if (mountedRef.current) await target.before?.();
        if (!alive(active)) return { ok: true };
        const result = await fileWriteOperations(signIn.client, active.workspaceId).renameFile({
          fromPath: target.path,
          toPath: targetPath,
          expectedObjectId: target.objectId,
          requestId,
        });
        if (!alive(active)) return { ok: true };
        if (!result.ok) {
          const msg = fileWriteRefusalText(result.refusal, result.reason);
          if (!fromSheet) {
            reportFailure(noticeId, documentWords.couldntRename, msg);
            if (mountedRef.current) target.onCancel?.();
          }
          return { ok: false, error: msg };
        }
        hideToast(noticeId);
        notices?.dismiss(noticeId);
        active.invalidate(views.files);
        active.invalidate(views.page(target.path), true);
        active.invalidate(views.page(result.path), true);
        if (mountedRef.current) {
          setSheetState(null);
          if (focusedRef.current) target.onDone?.(result.path);
        }
        return { ok: true };
      } catch (error) {
        if (!alive(active)) return { ok: true };
        if (!fromSheet && mountedRef.current) target.onCancel?.();
        const msg = errorText(error, documentWords.couldntRename);
        reportFailure(
          noticeId,
          documentWords.couldntRename,
          msg,
          () => {
            if (!alive(active)) return;
            void runRename(
              active,
              mountedRef.current ? target : { path: target.path, objectId: target.objectId },
              targetPath,
              requestId,
              false,
            );
          },
          !fromSheet,
        );
        return { ok: false, error: msg };
      }
    },
    [alive, errorText, hideToast, notices, reportFailure, signIn],
  );

  const restoringRef = useRef(new Set<string>());
  const runRestore = useCallback(
    async (
      active: WorkspaceData,
      target: Pick<FileTarget, "path" | "objectId" | "onRestored">,
      deleteMomentId: string,
      restoreRequestId: string,
    ) => {
      if (!alive(active) || restoringRef.current.has(restoreRequestId)) return;
      restoringRef.current.add(restoreRequestId);
      const fileName = target.path.split("/").pop() ?? target.path;
      const noticeId = `restore:${target.path}:${deleteMomentId}`;
      try {
        const res = await fileWriteOperations(signIn.client, active.workspaceId).restoreDeletedFile(
          {
            path: target.path,
            objectId: target.objectId,
            deleteMomentId,
            requestId: restoreRequestId,
          },
        );
        if (!alive(active)) return;
        if (!res.ok) {
          reportFailure(
            noticeId,
            confirmWords.couldntRestore(fileName),
            fileWriteRefusalText(res.refusal, res.reason),
            res.refusal === "live-active"
              ? () => void runRestore(active, target, deleteMomentId, restoreRequestId)
              : undefined,
          );
          return;
        }
        hideToast(noticeId);
        notices?.dismiss(noticeId);
        active.invalidate(views.files);
        active.invalidate(views.page(target.path), true);
        active.invalidate(views.documentCollections);
        if (mountedRef.current) target.onRestored?.(target.path);
        showToast({
          id: `restored:${target.path}:${deleteMomentId}`,
          tone: "success",
          title: confirmWords.restoredFile(fileName),
        });
      } catch (error) {
        if (!alive(active)) return;
        reportFailure(
          noticeId,
          confirmWords.couldntRestore(fileName),
          errorText(error, confirmWords.couldntRestore(fileName)),
          () => void runRestore(active, target, deleteMomentId, restoreRequestId),
        );
      } finally {
        restoringRef.current.delete(restoreRequestId);
      }
    },
    [alive, errorText, hideToast, notices, reportFailure, showToast, signIn],
  );

  const runDelete = useCallback(
    async (active: WorkspaceData, target: FileTarget, requestId: string) => {
      if (mountedRef.current && target.guard?.()) return;
      if (mountedRef.current) setDeletingPath(target.path);
      const noticeId = `delete:${target.path}`;
      try {
        if (mountedRef.current) await target.before?.();
        if (!alive(active)) return;
        const result = await fileWriteOperations(signIn.client, active.workspaceId).deleteFile({
          path: target.path,
          expectedObjectId: target.objectId,
          requestId,
        });
        if (!alive(active)) return;
        if (!result.ok) {
          reportFailure(
            noticeId,
            documentWords.couldntDelete,
            fileWriteRefusalText(result.refusal, result.reason),
          );
          if (mountedRef.current) target.onCancel?.();
          return;
        }
        hideToast(noticeId);
        notices?.dismiss(noticeId);
        active.invalidate(views.files);
        active.invalidate(views.page(target.path), true);
        if (mountedRef.current && focusedRef.current) target.onDone?.(target.path);
        if (result.deleteMomentId) {
          const deleteMomentId = result.deleteMomentId;
          const restoreRequestId = newFileRequestId();
          const fileName = target.path.split("/").pop() ?? target.path;
          showToast({
            id: `deleted:${target.path}:${deleteMomentId}`,
            tone: "success",
            title: confirmWords.deletedFile(fileName),
            holdsUndo: true,
            workspaceId: active.workspaceId,
            action: {
              label: confirmWords.undo,
              onPress: () => void runRestore(active, target, deleteMomentId, restoreRequestId),
            },
          });
        }
      } catch (error) {
        if (!alive(active)) return;
        if (mountedRef.current) target.onCancel?.();
        reportFailure(
          noticeId,
          documentWords.couldntDelete,
          errorText(error, documentWords.couldntDelete),
          () => {
            if (!alive(active)) return;
            void runDelete(
              active,
              mountedRef.current ? target : { path: target.path, objectId: target.objectId },
              requestId,
            );
          },
        );
      } finally {
        if (mountedRef.current) setDeletingPath((cur) => (cur === target.path ? null : cur));
      }
    },
    [alive, errorText, hideToast, notices, reportFailure, runRestore, showToast, signIn],
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
      readonly before?: () => Promise<void>;
      readonly onCancel?: () => void;
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
        const shared = {
          path: target.path,
          objectId: target.objectId,
          guard: target.guard,
          before: target.before,
          onCancel: target.onCancel,
        };
        if (chosen === 0) openRename({ ...shared, onDone: target.onRenamed });
        else if (chosen === 1) confirmDelete({ ...shared, onDone: target.onDeleted });
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
        return sheetState.mode === "create"
          ? await runCreate(data, targetPath, requestId, sheetState.onCreated, true)
          : await runRename(data, sheetState, targetPath, requestId, true);
      }}
    />
  );

  return { sheet, openCreate, openRename, confirmDelete, openActions, deletingPath };
}

export function SheetModal(props: {
  readonly open: boolean;
  readonly title: string;
  readonly saving: boolean;
  readonly allowDismissWhileSaving?: boolean;
  readonly savingLabel: string;
  readonly actionLabel: string;
  readonly onClose: () => void;
  readonly onAction: () => void;
  readonly children: ReactNode;
}) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const canDismiss = !props.saving || props.allowDismissWhileSaving === true;
  const close = () => {
    if (canDismiss) props.onClose();
  };
  useBackCloses(props.open, close);
  return (
    <Modal
      visible={props.open}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={close}
    >
      {props.open ? (
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
              disabled={!canDismiss}
              android_ripple={ripple(theme, true)}
              style={[styles.btn, styles.side]}
              accessibilityRole="button"
            >
              <Text style={[styles.btnText, { color: !canDismiss ? theme.subtle : theme.ink }]}>
                {confirmWords.cancel}
              </Text>
            </Pressable>
            <Text style={[styles.title, { color: theme.ink }]} numberOfLines={1}>
              {props.title}
            </Text>
            {props.saving ? (
              <View style={[styles.btn, styles.side, styles.right]}>
                <ActivityIndicator accessibilityLabel={props.savingLabel} />
              </View>
            ) : (
              <Pressable
                onPress={props.onAction}
                android_ripple={ripple(theme, true)}
                style={[styles.btn, styles.side, styles.right]}
                accessibilityRole="button"
              >
                <Text style={[styles.btnText, styles.strong, { color: theme.ink }]}>
                  {props.actionLabel}
                </Text>
              </Pressable>
            )}
          </View>
          {props.children}
        </View>
      ) : null}
    </Modal>
  );
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
    <SheetModal
      open={open}
      title={title}
      saving={saving}
      savingLabel={savingLabel}
      actionLabel={mode === "create" ? documentWords.create : documentWords.save}
      onClose={onClose}
      onAction={() => void submit()}
    >
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
    </SheetModal>
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
