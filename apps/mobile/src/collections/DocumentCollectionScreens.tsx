import { collectionWords } from "@dohc/interface-words/collections";
import { confirmWords } from "@dohc/interface-words/confirmations";
import { documentWords } from "@dohc/interface-words/documents";
import type { FieldDefinition } from "@dohc/workspace-contracts/collection";
import * as Haptics from "expo-haptics";
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { ArrowUpDown, Ellipsis, Plus, Search, X } from "lucide-react-native";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAccount, useSignIn } from "../account/AccountProvider";
import { ProblemLine } from "../account/ProblemLine";
import { useBackCloses } from "../backCloses";
import { useShownWorkspaces } from "../chats/Workspaces";
import { choose, confirm } from "../confirm";
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
  PHONE_DOC_COLLECTION_MAX_SCAN,
  readDocumentCollectionRecords,
  validateCollectionFolderName,
  type DocumentCollectionRecord,
  type DocumentCollectionSummary,
} from "../server/phoneDocumentCollections";
import { views, type ReadProblem } from "../server/workspaceData";
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

const fieldDraft = (f: FieldDefinition, v: RecordValue | undefined, emptyDate: boolean): Draft => {
  const s = fieldSpec(f);
  return draftOf({ type: s.type, relation: s.relation }, v, { emptyDate });
};

const toJsonKeyLabels = (raw?: Readonly<Record<string, string>>) =>
  raw ? Object.fromEntries(Object.entries(raw).map(([id, l]) => [JSON.stringify(id), l])) : {};

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
  const [bounded, setBounded] = useState(false);
  const [missing, setMissing] = useState(false);
  const [reading, setReading] = useState<"first" | "refresh" | "more" | null>("first");
  const [problem, setProblem] = useState<{ cause: ReadProblem; more: boolean } | null>(null);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<{ field: string; direction: "asc" | "desc" } | null>(null);
  const [creating, setCreating] = useState(false);
  const [deletingPath, setDeletingPath] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const mounted = useMounted();
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
          {
            collectionPath,
            ...(after ? { afterPath: after } : {}),
            ...(search ? { search } : {}),
            ...(sort ? { sortField: sort.field, sortDirection: sort.direction } : {}),
          },
          abort.signal,
        );
        if (!mounted.current || abort.signal.aborted || !signIn.isCurrent() || !active.isOpen())
          return;
        if (value.kind === "missing") {
          setMissing(true);
          setReading(null);
          return;
        }
        setMissing(false);
        setCollection(value.collection);
        setBounded(value.bounded);
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
    [collectionPath, data, mounted, search, signIn, sort],
  );

  useEffect(() => {
    const trimmed = searchInput.trim();
    if (trimmed === search) return;
    const timer = setTimeout(() => setSearch(trimmed), 250);
    return () => clearTimeout(timer);
  }, [searchInput, search]);

  useFocusEffect(
    useCallback(() => {
      void load(collection ? "refresh" : "first");
    }, [load]),
  );

  const clearQuery = useCallback(() => {
    setSearchInput("");
    setSearch("");
    setSort(null);
  }, []);
  useBackCloses(Boolean(searchInput || sort), clearQuery);

  const pickSort = async () => {
    const toggle = (field: string) =>
      setSort({
        field,
        direction: sort?.field === field && sort.direction === "asc" ? "desc" : "asc",
      });
    const items = [
      ...(sort
        ? [
            {
              label: collectionWords.reverseOrder,
              run: () =>
                setSort({
                  field: sort.field,
                  direction: sort.direction === "asc" ? "desc" : "asc",
                }),
            },
            { label: collectionWords.defaultOrder, run: () => setSort(null) },
          ]
        : []),
      { label: collectionWords.title, run: () => toggle("title") },
      ...(collection?.fields ?? [])
        .filter((f) => f.type !== "button" && f.type !== "multi-select")
        .map((f) => ({ label: f.name, run: () => toggle(f.name) })),
    ];
    const picked = await choose({
      title: collectionWords.sortBy,
      options: items.map((i) => ({ label: i.label })),
    });
    if (picked !== null) items[picked]?.run();
  };

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
        headerRight: () => (
          <View style={styles.headerButtons}>
            <Pressable
              onPress={() => void pickSort()}
              hitSlop={8}
              android_ripple={ripple(theme, true)}
              style={styles.iconBtn}
              accessibilityRole="button"
              accessibilityLabel={
                sort
                  ? collectionWords.sortedBy(
                      sort.field === "title" ? collectionWords.title : sort.field,
                      sort.direction === "asc",
                    )
                  : collectionWords.sort
              }
            >
              <ArrowUpDown size={22} color={sort ? theme.accent : theme.ink} strokeWidth={2} />
            </Pressable>
            {canEdit ? (
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
            ) : null}
          </View>
        ),
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
  const jsonLabels = useMemo(() => toJsonKeyLabels(relationLabels), [relationLabels]);

  return (
    <View style={[styles.flex, { backgroundColor: theme.bg }]}>
      {header}
      <View style={[styles.searchBar, { backgroundColor: theme.field }]}>
        <Search size={18} color={theme.subtle} strokeWidth={2} />
        <TextInput
          value={searchInput}
          onChangeText={setSearchInput}
          placeholder={collectionWords.searchRecords}
          placeholderTextColor={theme.subtle}
          returnKeyType="search"
          onSubmitEditing={() => setSearch(searchInput.trim())}
          maxLength={200}
          accessibilityLabel={collectionWords.searchRecords}
          style={[styles.searchInput, { color: theme.ink }]}
        />
        {searchInput ? (
          <Pressable
            onPress={() => {
              setSearchInput("");
              setSearch("");
            }}
            android_ripple={ripple(theme, true)}
            style={styles.iconBtn}
            accessibilityRole="button"
            accessibilityLabel={collectionWords.clearSearch}
          >
            <X size={18} color={theme.subtle} strokeWidth={2} />
          </Pressable>
        ) : null}
      </View>
      {bounded ? (
        <Text style={[styles.note, { color: theme.muted }]}>
          {collectionWords.boundedResults(PHONE_DOC_COLLECTION_MAX_SCAN)}
        </Text>
      ) : null}
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
            <EmptyLine text={search ? collectionWords.noMatches : collectionWords.noRecords} />
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
        <NewDocumentRecordSheet
          open={creating}
          collection={collection}
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
  const { open, onClose, onCreated } = props;
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
    if (!open) return;
    setName("");
    setSaving(false);
    setError(null);
    requestId.current = null;
  }, [open]);

  const submit = async () => {
    if (saving || !data) return;
    const checked = validateCollectionFolderName(name);
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
      const res = await documentCollectionWrites(
        signIn.client,
        active.workspaceId,
      ).createCollection({
        folder: checked.folder,
        name: checked.folder,
        requestId: requestId.current,
      });
      if (!mounted.current || !signIn.isCurrent() || !active.isOpen()) return;
      if (!res.ok) {
        setError(res.refusal === "folder-occupied" ? collectionWords.folderOccupied : res.reason);
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        return;
      }
      requestId.current = null;
      active.invalidate(views.files);
      active.invalidate(views.documentCollections);
      onCreated(res.path);
    } catch (cause) {
      if (!mounted.current || !signIn.isCurrent() || !active.isOpen()) return;
      const prob = shownProblem(cause);
      setError(prob ? problemText(prob) : collectionWords.couldntCreateCollection);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      if (mounted.current) setSaving(false);
    }
  };

  return (
    <SheetFrame
      open={open}
      title={collectionWords.newCollection}
      saving={saving}
      savingLabel={collectionWords.creating}
      actionLabel={collectionWords.create}
      onClose={onClose}
      onAction={() => void submit()}
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
          placeholder={collectionWords.collectionNamePlaceholder}
          placeholderTextColor={theme.subtle}
          editable={!saving}
          autoFocus
          returnKeyType="done"
          onSubmitEditing={() => void submit()}
          accessibilityLabel={collectionWords.newCollection}
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
    </SheetFrame>
  );
}

function NewDocumentRecordSheet(props: {
  readonly open: boolean;
  readonly collection: DocumentCollectionSummary;
  readonly onClose: () => void;
  readonly onCreated: (path: string) => void;
}) {
  const { open, collection, onClose, onCreated } = props;
  const theme = useTheme();
  const { data } = useAccount();
  const signIn = useSignIn();
  const problemText = useProblemText();
  const mounted = useMounted();
  const editableFields = useMemo(
    () => collection.fields.filter((f) => f.type !== "button" && f.type !== "relation"),
    [collection.fields],
  );
  const [name, setName] = useState("");
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const requestId = useRef<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setName("");
    setDrafts(
      Object.fromEntries(editableFields.map((f) => [f.name, fieldDraft(f, undefined, true)])),
    );
    setErrors({});
    setSubmitError(null);
    setSaving(false);
    requestId.current = null;
  }, [open, editableFields]);

  const submit = async () => {
    if (saving || !data) return;
    const built = buildTargetPath(collection.path, name, ".md");
    const nextErrors: Record<string, string> = {};
    if (!built.ok)
      nextErrors.__name = name.trim()
        ? collectionWords.invalidRecordName
        : collectionWords.recordNameRequired;
    const fields: Record<string, RecordValue> = {};
    for (const field of editableFields) {
      const coerced = coerceDocumentFieldValue(
        field,
        drafts[field.name] ?? fieldDraft(field, undefined, true),
      );
      if (!coerced.ok) nextErrors[field.name] = coerced.error;
      else if (
        coerced.value !== null &&
        (!Array.isArray(coerced.value) || coerced.value.length > 0)
      )
        fields[field.name] = coerced.value;
    }
    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      return;
    }
    const active = data;
    requestId.current ??= newFileRequestId();
    setSaving(true);
    setSubmitError(null);
    try {
      const res = await documentCollectionWrites(signIn.client, active.workspaceId).createRecord({
        collectionPath: collection.path,
        name: name.trim().replace(/\.md$/i, "").trim(),
        ...(Object.keys(fields).length > 0 ? { fields } : {}),
        requestId: requestId.current,
      });
      if (!mounted.current || !signIn.isCurrent() || !active.isOpen()) return;
      if (!res.ok) {
        setSubmitError(res.refusal === "path-exists" ? collectionWords.recordExists : res.reason);
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        return;
      }
      requestId.current = null;
      active.invalidate(views.files);
      active.invalidate(views.page(res.path), true);
      onCreated(res.path);
    } catch (cause) {
      if (!mounted.current || !signIn.isCurrent() || !active.isOpen()) return;
      const prob = shownProblem(cause);
      setSubmitError(prob ? problemText(prob) : collectionWords.couldntCreateRecord);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      if (mounted.current) setSaving(false);
    }
  };

  return (
    <SheetFrame
      open={open}
      title={collectionWords.newRecord}
      saving={saving}
      savingLabel={collectionWords.creating}
      actionLabel={collectionWords.create}
      onClose={onClose}
      onAction={() => void submit()}
    >
      <ScrollView
        contentContainerStyle={styles.form}
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
      >
        {submitError ? (
          <Text style={[styles.fieldError, { color: theme.danger }]} accessibilityRole="alert">
            {submitError}
          </Text>
        ) : null}
        <View style={styles.field}>
          <Text style={[styles.label, { color: theme.muted }]}>{collectionWords.recordName} *</Text>
          <TextInput
            value={name}
            onChangeText={(next) => {
              setName(next);
              setErrors(({ __name: _, ...rest }) => rest);
              requestId.current = null;
            }}
            placeholder={collectionWords.recordNamePlaceholder}
            placeholderTextColor={theme.subtle}
            editable={!saving}
            autoFocus
            returnKeyType="done"
            accessibilityLabel={collectionWords.recordName}
            style={[
              styles.input,
              {
                color: theme.ink,
                backgroundColor: theme.panel,
                borderColor: errors.__name ? theme.danger : theme.line,
              },
            ]}
          />
          {errors.__name ? (
            <Text style={[styles.fieldError, { color: theme.danger }]} accessibilityRole="alert">
              {errors.__name}
            </Text>
          ) : null}
        </View>
        {editableFields.map((field) => (
          <View key={field.name} style={styles.field}>
            {field.type === "checkbox" ? null : (
              <Text style={[styles.label, { color: theme.muted }]}>{field.name}</Text>
            )}
            <FieldInput
              field={fieldSpec(field)}
              draft={drafts[field.name] ?? fieldDraft(field, undefined, true)}
              onChange={(next) => {
                setDrafts((cur) => ({ ...cur, [field.name]: next }));
                setErrors((cur) => {
                  if (!Object.hasOwn(cur, field.name)) return cur;
                  const copy = { ...cur };
                  delete copy[field.name];
                  return copy;
                });
              }}
              disabled={saving}
              error={errors[field.name] ?? null}
              onClearDate={
                field.type === "date"
                  ? () => setDrafts((cur) => ({ ...cur, [field.name]: "" }))
                  : null
              }
            />
          </View>
        ))}
      </ScrollView>
    </SheetFrame>
  );
}

export function PropertyEditorSheet(props: {
  readonly open: boolean;
  readonly field: FieldDefinition | null;
  readonly value: RecordValue;
  readonly saving: boolean;
  readonly error: string | null;
  readonly relationLabels?: Readonly<Record<string, string>>;
  readonly onClose: () => void;
  readonly onSave: (value: RecordValue, labels?: Readonly<Record<string, string>>) => void;
}) {
  const { open, field, value, saving, error, onClose, onSave } = props;
  const { data } = useAccount();
  const signIn = useSignIn();
  const [draft, setDraft] = useState<Draft>("");
  const [localError, setLocalError] = useState<string | null>(null);
  const [labels, setLabels] = useState<Readonly<Record<string, string>>>({});
  useEffect(() => {
    if (!open || !field) return;
    setDraft(fieldDraft(field, value, false));
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

  return (
    <SheetFrame
      open={open && field !== null}
      title={field?.name ?? ""}
      saving={saving}
      savingLabel={collectionWords.saving}
      actionLabel={collectionWords.save}
      onClose={onClose}
      onAction={() => commit()}
    >
      {field?.type === "relation" ? (
        <RelationPicker
          name={field.name}
          many={field.many}
          selected={Array.isArray(draft) ? (draft as readonly RecordId[]) : []}
          labels={labels}
          load={loadRelations}
          onChange={(next, nextLabels) => {
            setDraft(next);
            setLabels(nextLabels);
          }}
        />
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
            error={localError ?? error}
            onClearDate={value === null || value === "" ? null : () => commit("")}
          />
        </ScrollView>
      ) : null}
    </SheetFrame>
  );
}

function SheetFrame(props: {
  readonly open: boolean;
  readonly title: string;
  readonly saving: boolean;
  readonly savingLabel: string;
  readonly actionLabel: string;
  readonly onClose: () => void;
  readonly onAction: () => void;
  readonly children: ReactNode;
}) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const close = () => {
    if (!props.saving) props.onClose();
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
            styles.flex,
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
              disabled={props.saving}
              android_ripple={ripple(theme, true)}
              style={[styles.btn, styles.side]}
              accessibilityRole="button"
            >
              <Text style={[styles.btnText, { color: props.saving ? theme.subtle : theme.ink }]}>
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

const styles = StyleSheet.create({
  flex: { flex: 1 },
  headerButtons: { flexDirection: "row", alignItems: "center", gap: 4 },
  iconBtn: { minWidth: TOUCH, minHeight: TOUCH, alignItems: "center", justifyContent: "center" },
  searchBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginHorizontal: 16,
    marginVertical: 8,
    paddingLeft: 12,
    paddingRight: 4,
    borderRadius: 10,
    minHeight: TOUCH,
  },
  searchInput: { flex: 1, fontSize: 17, paddingVertical: 8 },
  note: { fontSize: 13, paddingHorizontal: 16, paddingBottom: 6 },
  pad: { paddingHorizontal: 16, paddingBottom: 8 },
  errLine: { fontSize: 14, paddingHorizontal: 16, paddingBottom: 8 },
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
  form: { padding: 16, gap: 16, paddingBottom: 48 },
  field: { gap: 6 },
  label: { fontSize: 13 },
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
