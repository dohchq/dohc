import { collectionWords } from "@dohc/interface-words/collections";
import { confirmWords } from "@dohc/interface-words/confirmations";
import { documentWords } from "@dohc/interface-words/documents";
import type { FieldDefinition } from "@dohc/workspace-contracts/collection";
import * as Haptics from "expo-haptics";
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { Ellipsis, Plus } from "lucide-react-native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useAccount, useSignIn } from "../account/AccountProvider";
import { ProblemLine } from "../account/ProblemLine";
import { useShownWorkspaces } from "../chats/Workspaces";
import { choose, confirm } from "../confirm";
import { SheetModal } from "../home/FileNameSheet";
import { shownProblem } from "../server/client";
import {
  buildTargetPath,
  canWriteFiles,
  fileWriteOperations,
  fileWriteRefusalText,
  newFileRequestId,
} from "../server/fileWrites";
import type { RecordCursor, RecordId, RecordValue } from "../server/phoneCollections";
import {
  coerceDocumentFieldValue,
  documentCollectionWrites,
  readDocumentCollectionRecords,
  validateCollectionFolderName,
  type DocumentCollectionRecord,
  type DocumentCollectionSummary,
  type DocumentCollectionWriteResult,
} from "../server/phoneDocumentCollections";
import { views, type ReadProblem, type WorkspaceData } from "../server/workspaceData";
import { useTheme } from "../theme";
import { ripple, TOUCH } from "../touch";
import { EmptyLine, HoldRow, ScreenFailure } from "../workspace/ListStates";
import { useProblemText } from "../workspace/useView";
import { draftOf, rowText, shownValue, type Draft } from "./collectionFields";
import { FieldInput, type FieldInputSpec } from "./FieldInput";
import { RelationPicker } from "./RelationPicker";

function fieldSpec(field: FieldDefinition): FieldInputSpec {
  const type = field.type === "person" || field.type === "button" ? "text" : field.type;
  return {
    name: field.name,
    type,
    ...(field.type === "select" || field.type === "multi-select" ? { options: field.options } : {}),
    ...(field.type === "relation" ? { relation: { many: field.many } } : {}),
  };
}

const toJsonKeyLabels = (raw?: Readonly<Record<string, string>>) =>
  raw
    ? Object.fromEntries(Object.entries(raw).map(([id, label]) => [JSON.stringify(id), label]))
    : {};

function useMounted() {
  const ref = useRef(true);
  useEffect(() => {
    ref.current = true;
    return () => {
      ref.current = false;
    };
  }, []);
  return ref;
}

export function DocumentCollectionScreen() {
  const { path = "" } = useLocalSearchParams<{ path?: string }>();
  const { data } = useAccount();
  if (!data || data.joined || !path)
    return <ScreenFailure text={collectionWords.collectionFailed} />;
  return <DocumentRecords key={`${data.instance}:${path}`} collectionPath={path} />;
}

function DocumentRecords({ collectionPath }: { collectionPath: string }) {
  const theme = useTheme();
  const router = useRouter();
  const problemText = useProblemText();
  const { data } = useAccount();
  const signIn = useSignIn();
  const { current } = useShownWorkspaces();
  const canEdit = canWriteFiles(data, current);
  const [collection, setCollection] = useState<DocumentCollectionSummary | null>(null);
  const [records, setRecords] = useState<readonly DocumentCollectionRecord[]>([]);
  const [relationLabels, setRelationLabels] = useState<Readonly<Record<string, string>>>({});
  const [nextPath, setNextPath] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [reading, setReading] = useState<"first" | "refresh" | "more" | null>("first");
  const [problem, setProblem] = useState<{ cause: ReadProblem; more: boolean } | null>(null);
  const [creating, setCreating] = useState(false);
  const [deletingPath, setDeletingPath] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const loadedRef = useRef(false);
  const mounted = useMounted();
  const jsonLabels = useMemo(() => toJsonKeyLabels(relationLabels), [relationLabels]);
  useEffect(() => () => abortRef.current?.abort(), []);

  const load = useCallback(
    async (mode: "first" | "refresh" | "more", after?: string) => {
      if (!data || data.joined) return;
      const active = data;
      abortRef.current?.abort();
      const abort = new AbortController();
      abortRef.current = abort;
      setReading(mode);
      setProblem(null);
      try {
        const { value } = await readDocumentCollectionRecords(
          signIn.client,
          active.workspaceId,
          { collectionPath, ...(after ? { afterPath: after } : {}) },
          abort.signal,
        );
        if (!mounted.current || abort.signal.aborted || !signIn.isCurrent() || !active.isOpen())
          return;
        if (value.kind === "missing") {
          setMissing(true);
          setReading(null);
          return;
        }
        loadedRef.current = true;
        setMissing(false);
        setCollection(value.collection);
        setNextPath(value.nextPath);
        setRelationLabels((cur) =>
          after ? { ...cur, ...value.relationLabels } : value.relationLabels,
        );
        setRecords((cur) =>
          after
            ? [...cur, ...value.records.filter((r) => !cur.some((e) => e.path === r.path))]
            : value.records,
        );
        setReading(null);
      } catch (error) {
        if (!mounted.current || abort.signal.aborted || !signIn.isCurrent() || !active.isOpen())
          return;
        const cause = shownProblem(error);
        if (cause) setProblem({ cause, more: Boolean(after) });
        setReading(null);
      }
    },
    [collectionPath, data, mounted, signIn],
  );

  useFocusEffect(
    useCallback(() => {
      void load(loadedRef.current ? "refresh" : "first");
    }, [load]),
  );

  const removeRecord = async (record: DocumentCollectionRecord) => {
    if (!data || !canEdit || deletingPath !== null) return;
    const active = data;
    const ok = await confirm({
      title: confirmWords.deleteFilesTitle([record.path]),
      message: confirmWords.deleteFilesBody(1, current?.name ?? ""),
      confirm: confirmWords.delete,
      destructive: true,
    });
    if (!ok || !mounted.current || !signIn.isCurrent() || !active.isOpen()) return;
    setDeletingPath(record.path);
    setDeleteError(null);
    try {
      const res = await fileWriteOperations(signIn.client, active.workspaceId).deleteFile({
        path: record.path,
        expectedObjectId: record.objectId,
        requestId: newFileRequestId(),
      });
      if (!mounted.current || !signIn.isCurrent() || !active.isOpen()) return;
      if (!res.ok) return setDeleteError(fileWriteRefusalText(res.refusal, res.reason));
      active.invalidate(views.files);
      active.invalidate(views.page(record.path), true);
      setRecords((cur) => cur.filter((r) => r.path !== record.path));
    } catch (error) {
      if (!mounted.current || !signIn.isCurrent() || !active.isOpen()) return;
      const cause = shownProblem(error);
      setDeleteError(cause ? problemText(cause) : documentWords.couldntDelete);
    } finally {
      if (mounted.current) setDeletingPath((cur) => (cur === record.path ? null : cur));
    }
  };

  const displayName = collection?.name ?? collectionPath.split("/").pop() ?? collectionPath;
  const header = (
    <Stack.Screen
      options={{
        title: displayName,
        headerTransparent: false,
        headerStyle: { backgroundColor: theme.bg },
        headerShadowVisible: false,
        headerRight: canEdit
          ? () => (
              <Pressable
                onPress={() => setCreating(true)}
                hitSlop={8}
                android_ripple={ripple(theme, true)}
                style={styles.iconBtn}
                accessibilityRole="button"
                accessibilityLabel={collectionWords.newRecord}
              >
                <Plus size={24} color={theme.ink} strokeWidth={2} />
              </Pressable>
            )
          : undefined,
      }}
    />
  );

  if (missing)
    return (
      <>
        {header}
        <ScreenFailure text={collectionWords.collectionFailed} />
      </>
    );

  const visibleFields = (collection?.fields ?? []).filter((f) => f.type !== "button");

  return (
    <View style={[styles.flex, { backgroundColor: theme.bg }]}>
      {header}
      {problem ? (
        <View style={styles.pad}>
          <ProblemLine
            text={`${collectionWords.recordsFailed(displayName)} ${problemText(problem.cause)}`}
            onRetry={() =>
              void load(
                problem.more ? "more" : "refresh",
                problem.more ? (nextPath ?? undefined) : undefined,
              )
            }
          />
        </View>
      ) : null}
      {deleteError ? (
        <Text style={[styles.errLine, { color: theme.danger }]} accessibilityRole="alert">
          {deleteError}
        </Text>
      ) : null}
      <FlatList
        style={styles.flex}
        keyboardShouldPersistTaps="handled"
        data={records}
        keyExtractor={(item) => item.path}
        renderItem={({ item }) => {
          const details = visibleFields
            .flatMap(
              (field) =>
                rowText(
                  shownValue(
                    { type: fieldSpec(field).type },
                    item.values[field.name],
                    {},
                    field.type === "relation" ? jsonLabels : undefined,
                  ),
                  field.name,
                ) ?? [],
            )
            .slice(0, 2);
          return (
            <View style={[styles.rowWrap, { borderColor: theme.line }]}>
              <Pressable
                onPress={() =>
                  router.push({
                    pathname: "/page",
                    params: { path: item.path, t0: String(Date.now()) },
                  })
                }
                android_ripple={ripple(theme)}
                style={({ pressed }) => [
                  styles.recordRow,
                  pressed && { backgroundColor: theme.panel2 },
                ]}
                accessibilityRole="button"
                accessibilityLabel={[item.title, ...details].join(", ")}
              >
                <Text style={[styles.recordTitle, { color: theme.ink }]} numberOfLines={1}>
                  {item.title}
                </Text>
                {details.length > 0 ? (
                  <Text style={[styles.recordDetail, { color: theme.muted }]} numberOfLines={1}>
                    {details.join(" · ")}
                  </Text>
                ) : null}
              </Pressable>
              {canEdit ? (
                deletingPath === item.path ? (
                  <View style={styles.iconBtn}>
                    <ActivityIndicator size="small" accessibilityLabel={documentWords.deleting} />
                  </View>
                ) : (
                  <Pressable
                    onPress={() =>
                      void choose({
                        title: item.title,
                        options: [{ label: confirmWords.delete, destructive: true }],
                      }).then((idx) => {
                        if (idx === 0) void removeRecord(item);
                      })
                    }
                    android_ripple={ripple(theme, true)}
                    style={styles.iconBtn}
                    accessibilityRole="button"
                    accessibilityLabel={collectionWords.actionsFor(item.title)}
                  >
                    <Ellipsis size={18} color={theme.muted} strokeWidth={2} />
                  </Pressable>
                )
              ) : null}
            </View>
          );
        }}
        ListEmptyComponent={
          reading === "first" ? (
            <HoldRow />
          ) : problem ? undefined : (
            <EmptyLine text={collectionWords.noRecords} />
          )
        }
        ListFooterComponent={reading === "more" ? <HoldRow /> : undefined}
        onEndReached={() => {
          if (nextPath && reading === null) void load("more", nextPath);
        }}
        onEndReachedThreshold={0.5}
        refreshControl={
          <RefreshControl
            refreshing={reading === "refresh"}
            onRefresh={() => void load("refresh")}
          />
        }
      />
      {canEdit && collection ? (
        <CreateNameSheet
          open={creating}
          title={collectionWords.newRecord}
          placeholder={collectionWords.recordNamePlaceholder}
          fallbackError={collectionWords.couldntCreateRecord}
          validate={(entered) => {
            const built = buildTargetPath(collection.path, entered, ".md");
            if (!built.ok)
              return {
                ok: false,
                error: entered.trim()
                  ? collectionWords.invalidRecordName
                  : collectionWords.recordNameRequired,
              };
            return { ok: true, value: entered.trim().replace(/\.md$/i, "").trim() };
          }}
          submit={(active, client, value, requestId) =>
            documentCollectionWrites(client, active.workspaceId).createRecord({
              collectionPath: collection.path,
              name: value,
              requestId,
            })
          }
          refusalText={(res) =>
            res.refusal === "path-exists" ? collectionWords.recordExists : res.reason
          }
          invalidate={(active, path) => {
            active.invalidate(views.files);
            active.invalidate(views.page(path), true);
          }}
          onClose={() => setCreating(false)}
          onCreated={(path) => {
            setCreating(false);
            router.push({ pathname: "/page", params: { path, t0: String(Date.now()) } });
          }}
        />
      ) : null}
    </View>
  );
}

export function NewDocumentCollectionSheet(props: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onCreated: (folder: string) => void;
}) {
  return (
    <CreateNameSheet
      open={props.open}
      title={collectionWords.newCollection}
      placeholder={collectionWords.collectionNamePlaceholder}
      fallbackError={collectionWords.couldntCreateCollection}
      validate={(entered) => {
        const checked = validateCollectionFolderName(entered);
        return checked.ok ? { ok: true, value: checked.folder } : checked;
      }}
      submit={(active, client, folder, requestId) =>
        documentCollectionWrites(client, active.workspaceId).createCollection({
          folder,
          name: folder,
          requestId,
        })
      }
      refusalText={(res) =>
        res.refusal === "folder-occupied" ? collectionWords.folderOccupied : res.reason
      }
      invalidate={(active) => {
        active.invalidate(views.files);
        active.invalidate(views.documentCollections);
      }}
      onClose={props.onClose}
      onCreated={props.onCreated}
    />
  );
}

function CreateNameSheet(props: {
  readonly open: boolean;
  readonly title: string;
  readonly placeholder: string;
  readonly fallbackError: string;
  readonly validate: (
    entered: string,
  ) =>
    | { readonly ok: true; readonly value: string }
    | { readonly ok: false; readonly error: string };
  readonly submit: (
    active: WorkspaceData,
    client: ReturnType<typeof useSignIn>["client"],
    value: string,
    requestId: string,
  ) => Promise<DocumentCollectionWriteResult>;
  readonly refusalText: (
    res: Extract<DocumentCollectionWriteResult, { readonly ok: false }>,
  ) => string;
  readonly invalidate: (active: WorkspaceData, path: string) => void;
  readonly onClose: () => void;
  readonly onCreated: (path: string) => void;
}) {
  const theme = useTheme();
  const { data } = useAccount();
  const signIn = useSignIn();
  const problemText = useProblemText();
  const mounted = useMounted();
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef<string | null>(null);
  useEffect(() => {
    if (!props.open) return;
    setName("");
    setSaving(false);
    setError(null);
    requestId.current = null;
  }, [props.open]);

  const run = async () => {
    if (saving || !data) return;
    const checked = props.validate(name);
    if (!checked.ok) {
      setError(checked.error);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      return;
    }
    const active = data;
    requestId.current ??= newFileRequestId();
    setSaving(true);
    setError(null);
    try {
      const res = await props.submit(active, signIn.client, checked.value, requestId.current);
      if (!mounted.current || !signIn.isCurrent() || !active.isOpen()) return;
      if (!res.ok) {
        setError(props.refusalText(res));
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        return;
      }
      requestId.current = null;
      props.invalidate(active, res.path);
      props.onCreated(res.path);
    } catch (cause) {
      if (!mounted.current || !signIn.isCurrent() || !active.isOpen()) return;
      const prob = shownProblem(cause);
      setError(prob ? problemText(prob) : props.fallbackError);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      if (mounted.current) setSaving(false);
    }
  };

  return (
    <SheetModal
      open={props.open}
      title={props.title}
      saving={saving}
      savingLabel={collectionWords.creating}
      actionLabel={collectionWords.create}
      onClose={props.onClose}
      onAction={() => void run()}
    >
      <ScrollView
        contentContainerStyle={styles.form}
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
      >
        <TextInput
          value={name}
          onChangeText={(next) => {
            setName(next);
            setError(null);
            requestId.current = null;
          }}
          placeholder={props.placeholder}
          placeholderTextColor={theme.subtle}
          editable={!saving}
          autoFocus
          returnKeyType="done"
          onSubmitEditing={() => void run()}
          accessibilityLabel={props.title}
          style={[
            styles.input,
            {
              color: theme.ink,
              backgroundColor: theme.panel,
              borderColor: error ? theme.danger : theme.line,
            },
          ]}
        />
        {error ? (
          <Text style={[styles.fieldError, { color: theme.danger }]} accessibilityRole="alert">
            {error}
          </Text>
        ) : null}
      </ScrollView>
    </SheetModal>
  );
}

export function PropertyEditorSheet(props: {
  readonly open: boolean;
  readonly field: FieldDefinition | null;
  readonly value: RecordValue;
  readonly saving: boolean;
  readonly allowDismissWhileSaving?: boolean;
  readonly error: string | null;
  readonly relationLabels?: Readonly<Record<string, string>>;
  readonly onClose: () => void;
  readonly onSave: (value: RecordValue, labels?: Readonly<Record<string, string>>) => void;
}) {
  const { open, field, value, saving, allowDismissWhileSaving, error, onClose, onSave } = props;
  const theme = useTheme();
  const { data } = useAccount();
  const signIn = useSignIn();
  const [draft, setDraft] = useState<Draft>("");
  const [localError, setLocalError] = useState<string | null>(null);
  const [labels, setLabels] = useState<Readonly<Record<string, string>>>({});
  useEffect(() => {
    if (!open || !field) return;
    const spec = fieldSpec(field);
    setDraft(draftOf({ type: spec.type, relation: spec.relation }, value, { emptyDate: false }));
    setLocalError(null);
    setLabels(toJsonKeyLabels(props.relationLabels));
  }, [open, field, value]);

  const loadRelations = useCallback(
    async (term: string, after: RecordCursor | null, signal: AbortSignal) => {
      if (!data || !field || field.type !== "relation")
        return { options: [], next: null, searchUnsupported: false };
      const { value: page } = await readDocumentCollectionRecords(
        signIn.client,
        data.workspaceId,
        {
          collectionPath: field.collection,
          ...(after && typeof after.id === "string" ? { afterPath: after.id } : {}),
          ...(term ? { search: term } : {}),
        },
        signal,
      );
      if (page.kind !== "ready") return { options: [], next: null, searchUnsupported: false };
      return {
        options: page.records.flatMap((r) =>
          r.recordId ? [{ value: r.recordId, label: r.title }] : [],
        ),
        next: page.nextPath ? { id: page.nextPath, value: null } : null,
        searchUnsupported: false,
      };
    },
    [data, field, signIn],
  );

  const commit = (nextDraft: Draft = draft) => {
    if (!field || saving) return;
    const coerced = coerceDocumentFieldValue(field, nextDraft);
    if (!coerced.ok) {
      setLocalError(coerced.error);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      return;
    }
    setLocalError(null);
    const plainLabels =
      field.type === "relation"
        ? Object.fromEntries(
            Object.entries(labels).flatMap(([k, l]) => {
              try {
                const id = JSON.parse(k);
                return typeof id === "string" ? [[id, l]] : [];
              } catch {
                return [];
              }
            }),
          )
        : undefined;
    onSave(coerced.value, plainLabels);
  };

  const shownError = localError ?? error;

  return (
    <SheetModal
      open={open && field !== null}
      title={field?.name ?? ""}
      saving={saving}
      allowDismissWhileSaving={allowDismissWhileSaving}
      savingLabel={collectionWords.saving}
      actionLabel={collectionWords.save}
      onClose={onClose}
      onAction={() => commit()}
    >
      {field?.type === "relation" ? (
        <>
          {shownError ? (
            <Text
              style={[styles.errLine, styles.errPad, { color: theme.danger }]}
              accessibilityRole="alert"
            >
              {shownError}
            </Text>
          ) : null}
          <RelationPicker
            name={field.name}
            many={field.many}
            selected={Array.isArray(draft) ? (draft as readonly RecordId[]) : []}
            labels={labels}
            load={loadRelations}
            onChange={(next, nextLabels) => {
              setDraft(next);
              setLabels(nextLabels);
              setLocalError(null);
            }}
          />
        </>
      ) : field ? (
        <ScrollView
          contentContainerStyle={styles.form}
          keyboardShouldPersistTaps="handled"
          automaticallyAdjustKeyboardInsets
        >
          <FieldInput
            field={fieldSpec(field)}
            draft={draft}
            onChange={(next) => {
              setDraft(next);
              setLocalError(null);
            }}
            onSubmit={() => commit()}
            inlineDate
            autoFocus
            disabled={saving}
            error={shownError}
            onClearDate={value === null || value === "" ? null : () => commit("")}
          />
        </ScrollView>
      ) : null}
    </SheetModal>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  iconBtn: { minWidth: TOUCH, minHeight: TOUCH, alignItems: "center", justifyContent: "center" },
  pad: { paddingHorizontal: 16, paddingBottom: 8 },
  errLine: { fontSize: 14, paddingHorizontal: 16, paddingBottom: 8 },
  errPad: { paddingTop: 12 },
  rowWrap: {
    flexDirection: "row",
    alignItems: "center",
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingRight: 4,
  },
  recordRow: {
    flex: 1,
    minHeight: TOUCH,
    justifyContent: "center",
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 2,
  },
  recordTitle: { fontSize: 17 },
  recordDetail: { fontSize: 15 },
  form: { padding: 16, gap: 16, paddingBottom: 48 },
  input: {
    fontSize: 17,
    minHeight: TOUCH,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
  },
  fieldError: { fontSize: 14, lineHeight: 20 },
});
