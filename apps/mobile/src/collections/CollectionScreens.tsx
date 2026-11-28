import { collectionWords } from "@dohc/interface-words/collections";
import { chatWords, noticesWords } from "@dohc/interface-words/notices";
import * as Haptics from "expo-haptics";
import { Stack, useFocusEffect, useLocalSearchParams, useNavigation, useRouter } from "expo-router";
import {
  ArrowUpDown,
  ChevronRight,
  Plus,
  Search,
  Square,
  SquareCheck,
  Trash2,
  Undo2,
  X,
} from "lucide-react-native";
import { memo, useCallback, useEffect, useState, useSyncExternalStore } from "react";
import {
  ActivityIndicator,
  AppState,
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
import { outsideLink } from "../apps/appNavigation";
import { offerLink } from "../apps/offerLink";
import { useBackCloses } from "../backCloses";
import { choose, confirm } from "../confirm";
import { ActionPill } from "../notices/ActionPill";
import type {
  CollectionField,
  CollectionRecord,
  CollectionTable,
  RecordValue,
  RelationLabels,
} from "../server/phoneCollections";
import { phoneWrites } from "../server/phoneWrites";
import type { ReadProblem } from "../server/workspaceData";
import { useTheme } from "../theme";
import { ripple, TOUCH } from "../touch";
import { EmptyLine, HoldRow, ScreenFailure } from "../workspace/ListStates";
import { useProblemText } from "../workspace/useView";
import {
  editorKind,
  recordName,
  rowText,
  shownValue,
  supportsSearch,
  supportsSort,
} from "./collectionFields";
import {
  canUndo,
  newRecordKey,
  recordKey,
  type RecordAction,
  type RecordChange,
  type WorkspaceCollections,
} from "./collectionStore";
import { NewRecordSheet } from "./NewRecordSheet";

// A Collection's records, from Home, and one record. The list reads its first table, or the one chosen, 50 records at
// a time, the next page as it nears its end. Pulling down, and a return to the foreground, read the Collection again.
// Errors show in place, as on any screen outside the tabs. With phone writes on, New record in the list's header adds
// a record and opens it, and Delete in a record's header asks first, then deletes it and leaves its screen.

const nothing = () => () => undefined;

export function CollectionScreen() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const { collections } = useAccount();
  if (!collections || !id) return <ScreenFailure text={collectionWords.collectionFailed} />;
  return (
    <Records key={`${collections.workspaceId}:${id}`} collections={collections} datasetId={id} />
  );
}

/** The field that names a record in its row and its title: the table's primary field, or its first. */
const leadField = (table: CollectionTable) =>
  table.fields.find((field) => field.fieldId === table.primaryFieldId) ?? table.fields[0];

function Records({
  collections,
  datasetId,
}: {
  collections: WorkspaceCollections;
  datasetId: string;
}) {
  const theme = useTheme();
  const router = useRouter();
  const navigation = useNavigation();
  const problemText = useProblemText();
  const state = useSyncExternalStore(collections.subscribe, collections.view);
  const actions = useSyncExternalStore(collections.subscribe, collections.actions);
  const [searchInput, setSearchInput] = useState("");
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    void collections.open(datasetId);
    return () => collections.close(datasetId);
  }, [collections, datasetId]);
  useEffect(() => {
    let away = false;
    const subscription = AppState.addEventListener("change", (next) => {
      if (next === "background") away = true;
      else if (next === "active" && away) {
        away = false;
        void collections.reload();
      }
    });
    return () => subscription.remove();
  }, [collections]);
  const reload = useCallback(() => void collections.reload(), [collections]);
  const more = useCallback(() => void collections.more(), [collections]);
  const view = state?.datasetId === datasetId ? state : null;
  const description = view?.description;
  const table = description?.tables.find((table) => table.tableId === view?.tableId);
  const clearQuery = useCallback(() => {
    setSearchInput("");
    void collections.setQuery({ search: "", sort: null });
  }, [collections]);
  useEffect(() => {
    setSearchInput(view?.search ?? "");
    setCreating(false);
  }, [view?.tableId]);
  useEffect(() => {
    if (!view || searchInput.trim() === view.search) return;
    const timer = setTimeout(() => void collections.setQuery({ search: searchInput.trim() }), 250);
    return () => clearTimeout(timer);
  }, [searchInput, view?.search, collections]);
  useBackCloses(Boolean(searchInput || view?.sort), clearQuery);
  const open = useCallback(
    (record: CollectionRecord) => {
      collections.openRecord(record);
      router.push("/collection-record");
    },
    [router, collections],
  );
  const added = (opened: boolean) => {
    if (opened && navigation.isFocused()) router.push("/collection-record");
  };
  const newKey = table ? newRecordKey(datasetId, table.tableId) : null;
  const adding = newKey ? actions.get(newKey) : undefined;
  const sortable = table ? table.fields.filter(supportsSort) : [];
  const sortField =
    view?.sort && table ? table.fields.find((f) => f.fieldId === view.sort!.fieldId) : null;
  const pickSort = async () => {
    if (!sortable.length) return;
    const cur = view?.sort ?? null;
    const items: Array<{ label: string; run(): void }> = [
      ...(cur
        ? [
            {
              label: collectionWords.reverseOrder,
              run: () =>
                void collections.setQuery({
                  sort: {
                    fieldId: cur.fieldId,
                    direction: cur.direction === "asc" ? "desc" : "asc",
                  },
                }),
            },
            {
              label: collectionWords.defaultOrder,
              run: () => void collections.setQuery({ sort: null }),
            },
          ]
        : []),
      ...sortable.map((f) => ({
        label: f.name,
        run: () =>
          void collections.setQuery({
            sort: {
              fieldId: f.fieldId,
              direction: cur?.fieldId === f.fieldId && cur.direction === "asc" ? "desc" : "asc",
            },
          }),
      })),
    ];
    const picked = await choose({
      title: collectionWords.sortBy,
      options: items.map((i) => ({ label: i.label })),
    });
    if (picked !== null) items[picked]?.run();
  };
  const showSort = sortable.length > 0 && !view?.refused;
  const showCreate = phoneWrites && table?.canCreate;
  const sheetOpen =
    creating && Boolean(showCreate && table && newKey && table.createFields.length > 0);

  const title = (
    <Stack.Screen
      options={{
        title: description?.name ?? "",
        headerTransparent: false,
        headerStyle: { backgroundColor: theme.bg },
        headerShadowVisible: false,
        headerRight:
          showSort || showCreate
            ? () => (
                <View style={styles.headerButtons}>
                  {showSort ? (
                    <Pressable
                      onPress={() => void pickSort()}
                      hitSlop={8}
                      android_ripple={ripple(theme, true)}
                      style={styles.headerButton}
                      accessibilityRole="button"
                      accessibilityLabel={
                        sortField && view?.sort
                          ? collectionWords.sortedBy(sortField.name, view.sort.direction === "asc")
                          : collectionWords.sort
                      }
                    >
                      <ArrowUpDown
                        size={22}
                        color={view?.sort ? theme.accent : theme.ink}
                        strokeWidth={2}
                      />
                    </Pressable>
                  ) : null}
                  {!showCreate ? null : adding?.state.kind === "saving" && !sheetOpen ? (
                    <View style={styles.headerButton}>
                      <ActivityIndicator accessibilityLabel={collectionWords.saving} />
                    </View>
                  ) : (
                    <Pressable
                      onPress={() =>
                        table.createFields.length > 0
                          ? setCreating(true)
                          : void collections.create().then(added)
                      }
                      disabled={
                        table.createFields.length === 0
                          ? adding !== undefined
                          : adding?.state.kind === "saving"
                      }
                      hitSlop={8}
                      android_ripple={ripple(theme, true)}
                      style={styles.headerButton}
                      accessibilityRole="button"
                      accessibilityLabel={collectionWords.newRecord}
                    >
                      <Plus size={24} color={theme.ink} strokeWidth={2} />
                    </Pressable>
                  )}
                </View>
              )
            : undefined,
      }}
    />
  );
  if (!view || !description)
    return (
      <>
        {title}
        {view?.problem ? (
          <ScreenFailure
            text={collectionWords.collectionFailed}
            cause={problemText(view.problem.cause)}
            onRetry={reload}
          />
        ) : (
          <HoldRow />
        )}
      </>
    );

  const header = (
    <>
      {description.tables.length > 1 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.tabsWrap}
          contentContainerStyle={styles.tables}
        >
          {description.tables.map((each) => {
            const chosen = each.tableId === view.tableId;
            return (
              <Pressable
                key={each.tableId}
                onPress={() => {
                  void Haptics.selectionAsync();
                  setSearchInput("");
                  void collections.chooseTable(each.tableId);
                }}
                android_ripple={ripple(theme)}
                style={[
                  styles.table,
                  { borderColor: theme.line },
                  chosen ? { backgroundColor: theme.ink, borderColor: theme.ink } : null,
                ]}
                accessibilityRole="button"
                accessibilityState={{ selected: chosen }}
              >
                <Text style={[styles.tableName, { color: chosen ? theme.bg : theme.ink }]}>
                  {each.name}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
      ) : null}
      {table && supportsSearch(table.fields) && !view.refused ? (
        <View style={[styles.searchBar, { backgroundColor: theme.field }]}>
          <Search size={18} color={theme.subtle} strokeWidth={2} />
          <TextInput
            value={searchInput}
            onChangeText={setSearchInput}
            placeholder={collectionWords.searchRecords}
            placeholderTextColor={theme.subtle}
            returnKeyType="search"
            onSubmitEditing={() => void collections.setQuery({ search: searchInput.trim() })}
            maxLength={200}
            accessibilityLabel={collectionWords.searchRecords}
            style={[styles.searchInput, { color: theme.ink }]}
          />
          {searchInput ? (
            <Pressable
              onPress={() => {
                setSearchInput("");
                void collections.setQuery({ search: "" });
              }}
              android_ripple={ripple(theme, true)}
              style={styles.headerButton}
              accessibilityRole="button"
              accessibilityLabel={collectionWords.clearSearch}
            >
              <X size={18} color={theme.subtle} strokeWidth={2} />
            </Pressable>
          ) : null}
        </View>
      ) : null}
      {view.problem ? (
        <View style={styles.problem}>
          <ProblemLine
            text={`${
              table ? collectionWords.recordsFailed(table.name) : collectionWords.collectionFailed
            } ${problemText(view.problem.cause)}`}
            onRetry={view.problem.more ? more : reload}
          />
        </View>
      ) : null}
      {newKey && adding && !sheetOpen ? (
        <View style={styles.problem}>
          <ChangeLine
            state={adding.state}
            cause={problemText}
            onRetry={() => void collections.retryAction(newKey).then(added)}
            onReload={() => {
              collections.discardAction(newKey);
              void collections.reload();
            }}
            onDiscard={() => collections.discardAction(newKey)}
          />
        </View>
      ) : null}
    </>
  );
  return (
    <View style={[styles.screen, { backgroundColor: theme.bg }]}>
      {title}
      {header}
      <FlatList
        style={styles.screen}
        keyboardShouldPersistTaps="handled"
        data={view.rows}
        keyExtractor={recordRowKey}
        renderItem={({ item }) =>
          table ? (
            <RecordRow
              record={item}
              table={table}
              files={view.files}
              relations={view.relations}
              onPress={open}
            />
          ) : null
        }
        ListEmptyComponent={
          view.queryUnsupported ? (
            <View style={styles.unsupported}>
              <EmptyLine text={collectionWords.queryUnsupported} />
              <ActionPill label={collectionWords.clear} onPress={clearQuery} />
            </View>
          ) : view.refused && table ? (
            <EmptyLine text={collectionWords.noRead(table.name)} />
          ) : view.reading === "first" ? (
            <HoldRow />
          ) : view.problem ? undefined : (
            <EmptyLine text={view.search ? collectionWords.noMatches : collectionWords.noRecords} />
          )
        }
        ListFooterComponent={view.reading === "more" ? <HoldRow /> : undefined}
        onEndReached={more}
        onEndReachedThreshold={0.5}
        refreshControl={
          <RefreshControl refreshing={view.reading === "refresh"} onRefresh={reload} />
        }
      />
      {showCreate && table && newKey && table.createFields.length > 0 ? (
        <NewRecordSheet
          open={sheetOpen}
          table={table}
          collections={collections}
          action={adding}
          actionKey={newKey}
          renderAction={(p) =>
            adding ? <ChangeLine state={adding.state} cause={problemText} {...p} /> : null
          }
          onClose={() => setCreating(false)}
          onCreated={added}
        />
      ) : null}
    </View>
  );
}

const recordRowKey = (record: CollectionRecord) =>
  typeof record.id === "number" ? `n:${record.id}` : `s:${record.id}`;

/** A record's row: the field that names it, then up to two more that have a value. */
const RecordRow = memo(function RecordRow(props: {
  record: CollectionRecord;
  table: CollectionTable;
  files: Readonly<Record<string, string>>;
  relations: RelationLabels;
  onPress(record: CollectionRecord): void;
}) {
  const { record, table, files, relations } = props;
  const theme = useTheme();
  const lead = leadField(table);
  const name = recordName(lead, record.values, files, relations);
  const details = table.fields
    .filter((field) => field !== lead)
    .flatMap(
      (field) =>
        rowText(
          shownValue(field, record.values[field.fieldId], files, relations[field.fieldId]),
          field.name,
        ) ?? [],
    )
    .slice(0, 2);
  return (
    <Pressable
      onPress={() => props.onPress(record)}
      android_ripple={ripple(theme)}
      style={({ pressed }) => [styles.row, pressed ? { backgroundColor: theme.panel2 } : null]}
      accessibilityRole="button"
      accessibilityLabel={[name, ...details].join(", ")}
    >
      <Text style={[styles.name, { color: theme.ink }]} numberOfLines={1}>
        {name}
      </Text>
      {details.length ? (
        <Text style={[styles.detail, { color: theme.muted }]} numberOfLines={1}>
          {details.join(" · ")}
        </Text>
      ) : null}
    </Pressable>
  );
});

/**
 * The record opened from the list, which stays while a refresh of the list reads pages without it. With phone writes
 * on, a field the Collection lets the phone change opens its editor, and the record's last change shows on its field:
 * saving, or why it didn't save with what to do next. Undo in the header reverses the last saved edit.
 */
export function RecordScreen() {
  const theme = useTheme();
  const router = useRouter();
  const navigation = useNavigation();
  const problemText = useProblemText();
  const { collections } = useAccount();
  const view = useSyncExternalStore(
    collections?.subscribe ?? nothing,
    useCallback(() => collections?.view() ?? null, [collections]),
  );
  const changes = useSyncExternalStore(
    collections?.subscribe ?? nothing,
    useCallback(() => collections?.changes() ?? NO_CHANGES, [collections]),
  );
  const actions = useSyncExternalStore(
    collections?.subscribe ?? nothing,
    useCallback(() => collections?.actions() ?? NO_ACTIONS, [collections]),
  );
  useEffect(() => () => collections?.closeRecord(), [collections]);
  const opened = view?.opened;
  const table = view?.description?.tables.find((table) => table.tableId === opened?.tableId);
  const deletion =
    view && opened
      ? actions.get(recordKey(view.datasetId, opened.tableId, opened.record.id))
      : undefined;
  const deleted = deletion?.state.kind === "saved";
  useFocusEffect(
    useCallback(() => {
      if (deleted && router.canGoBack()) router.back();
    }, [deleted, router]),
  );
  if (!collections || !view || !opened || !table)
    return <ScreenFailure text={collectionWords.recordMissing} />;
  const { record, files, relations } = opened;
  const key = recordKey(view.datasetId, table.tableId, record.id);
  const last = changes.get(key);
  const deleting = deleted || deletion?.state.kind === "saving";
  const askDelete = async () => {
    if (
      await confirm({
        title: collectionWords.deleteRecordTitle,
        message: collectionWords.deleteRecordBody,
        confirm: collectionWords.deleteRecord,
        destructive: true,
      })
    )
      collections.remove();
  };
  const lead = leadField(table);
  const title = recordName(lead, record.values, files, relations);
  const edit = (fieldId: string, value?: RecordValue) =>
    router.push({
      pathname: "/collection-field",
      params: { field: fieldId, ...(value === undefined ? {} : { value: JSON.stringify(value) }) },
    });
  // Reads the record again, then opens the editor with what the person entered, if the same record is still open and
  // on top, so no editor opened meanwhile sits under it, and its field still takes a change.
  const reload = async ({ change }: RecordChange) => {
    if (!(await collections.reloadRecord()) || !navigation.isFocused()) return;
    const from = collections.edit(change.fieldId)?.from;
    if (from && recordKey(from.datasetId, from.tableId, from.recordId) === key)
      edit(change.fieldId, change.value);
  };
  const undo = phoneWrites && !deleting && canUndo(last);
  const canDelete = phoneWrites && table.canDelete && record.version !== null;
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      style={{ backgroundColor: theme.bg }}
      contentContainerStyle={styles.record}
    >
      <Stack.Screen
        options={{
          title,
          headerRight:
            undo || canDelete
              ? () => (
                  <View style={styles.headerButtons}>
                    {undo ? (
                      <Pressable
                        onPress={() => collections.undo(key)}
                        hitSlop={8}
                        android_ripple={ripple(theme, true)}
                        style={styles.headerButton}
                        accessibilityRole="button"
                        accessibilityLabel={collectionWords.undoLastEdit}
                      >
                        <Undo2 size={22} color={theme.ink} strokeWidth={2} />
                      </Pressable>
                    ) : null}
                    {!canDelete ? null : deleting ? (
                      <View style={styles.headerButton}>
                        <ActivityIndicator accessibilityLabel={collectionWords.saving} />
                      </View>
                    ) : (
                      <Pressable
                        onPress={() => void askDelete()}
                        disabled={last?.state.kind === "saving"}
                        hitSlop={8}
                        android_ripple={ripple(theme, true)}
                        style={styles.headerButton}
                        accessibilityRole="button"
                        accessibilityLabel={collectionWords.deleteRecord}
                      >
                        <Trash2 size={22} color={theme.danger} strokeWidth={2} />
                      </Pressable>
                    )}
                  </View>
                )
              : undefined,
        }}
      />
      {view.problem ? (
        <ProblemLine
          text={`${collectionWords.recordsFailed(table.name)} ${problemText(view.problem.cause)}`}
          onRetry={() => void (view.problem?.more ? collections.more() : collections.reload())}
        />
      ) : null}
      {deletion ? (
        <ChangeLine
          state={deletion.state}
          cause={problemText}
          onRetry={() => void collections.retryAction(key)}
          blocked={last?.state.kind === "saving"}
          onReload={() =>
            void collections.reloadRecord().then((read) => read && collections.discardAction(key))
          }
          onDiscard={() => collections.discardAction(key)}
        />
      ) : null}
      {table.fields.map((field) => {
        // The change shows its value on its field until it saves, when the record holds it.
        const change = last?.change.fieldId === field.fieldId ? last : undefined;
        const pending = change && change.state.kind !== "saved" ? change : undefined;
        const shown = pending
          ? { ...record, values: { ...record.values, [field.fieldId]: pending.change.value } }
          : record;
        const editable =
          phoneWrites &&
          field.editable &&
          editorKind(field) !== null &&
          record.version !== null &&
          last?.state.kind !== "saving" &&
          !deleting;
        const body = (
          <>
            <Text style={[styles.label, { color: theme.muted }]}>{field.name}</Text>
            <View style={styles.valueLine}>
              <View style={styles.valueText}>
                <FieldValue
                  field={field}
                  record={shown}
                  files={files}
                  relationLabels={
                    pending?.relationLabels
                      ? { ...relations[field.fieldId], ...pending.relationLabels }
                      : relations[field.fieldId]
                  }
                />
              </View>
              {pending?.state.kind === "saving" ? (
                <ActivityIndicator accessibilityLabel={collectionWords.saving} />
              ) : editable ? (
                <ChevronRight size={18} color={theme.subtle} strokeWidth={2} />
              ) : null}
            </View>
          </>
        );
        return (
          <View key={field.fieldId} style={styles.field} testID="record-field">
            {editable ? (
              <Pressable
                onPress={() => edit(field.fieldId)}
                style={({ pressed }) => [styles.editable, pressed ? { opacity: 0.6 } : null]}
                accessibilityRole="button"
              >
                {body}
              </Pressable>
            ) : (
              body
            )}
            {pending ? (
              <ChangeLine
                state={pending.state}
                cause={(problem) => problemText(problem)}
                onRetry={() => collections.retry(key)}
                blocked={deleting}
                onReload={() => void reload(pending)}
                onDiscard={() => collections.discard(key)}
              />
            ) : null}
          </View>
        );
      })}
    </ScrollView>
  );
}

const NO_CHANGES: ReadonlyMap<string, RecordChange> = new Map();
const NO_ACTIONS: ReadonlyMap<string, RecordAction> = new Map();

export interface ChangeLineProps {
  state: RecordChange["state"] | RecordAction["state"];
  cause(problem: ReadProblem): string;
  onRetry(): void;
  blocked?: boolean;
  onReload?(): void;
  onDiscard(): void;
}

/** Why a write didn't save, and what to do next. Try again waits while another write to the record saves. */
function ChangeLine(props: ChangeLineProps) {
  const theme = useTheme();
  const { state } = props;
  if (state.kind === "saving" || state.kind === "saved") return null;
  const stale = state.kind === "refused" && state.code === "stale_record";
  const text =
    state.kind === "failed"
      ? `${collectionWords.notConfirmed} ${props.cause(state.problem)}`
      : state.kind === "rulesChanged"
        ? collectionWords.rulesChanged
        : stale
          ? collectionWords.recordChanged
          : collectionWords.refused(state.message);
  return (
    <View style={styles.change}>
      <Text style={[styles.changeText, { color: theme.danger }]} accessibilityRole="alert">
        {text}
      </Text>
      <View style={styles.actions}>
        {state.kind === "failed" ? (
          <ActionPill
            label={noticesWords.tryAgain}
            onPress={props.onRetry}
            disabled={props.blocked}
          />
        ) : props.onReload && (state.kind === "rulesChanged" || stale) ? (
          <ActionPill label={collectionWords.reload} onPress={props.onReload} />
        ) : null}
        <ActionPill label={chatWords.discard} onPress={props.onDiscard} />
      </View>
    </View>
  );
}

function FieldValue(props: {
  field: CollectionField;
  record: CollectionRecord;
  files: Readonly<Record<string, string>>;
  relationLabels?: Readonly<Record<string, string>>;
}) {
  const theme = useTheme();
  const { origin } = useSignIn();
  const shown = shownValue(
    props.field,
    props.record.values[props.field.fieldId],
    props.files,
    props.relationLabels,
  );
  if (shown.kind === "check") {
    const Mark = shown.checked ? SquareCheck : Square;
    return (
      <View
        accessible
        accessibilityLabel={shown.checked ? collectionWords.checked : collectionWords.notChecked}
      >
        <Mark size={20} color={shown.checked ? theme.accent : theme.subtle} strokeWidth={2} />
      </View>
    );
  }
  if (shown.kind === "empty") return <Text style={[styles.value, { color: theme.subtle }]}>—</Text>;
  if (shown.kind === "link") {
    const allowed = outsideLink(shown.url, origin);
    if (allowed)
      return (
        <Pressable
          style={styles.linkTarget}
          onPress={() => offerLink(allowed)}
          accessibilityRole="link"
        >
          <Text style={[styles.value, styles.link, { color: theme.accent }]}>{shown.url}</Text>
        </Pressable>
      );
    return (
      <Text style={[styles.value, { color: theme.ink }]} selectable>
        {shown.url}
      </Text>
    );
  }
  return (
    <Text style={[styles.value, { color: theme.ink }]} selectable>
      {shown.text}
    </Text>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  tabsWrap: { flexGrow: 0 },
  tables: { gap: 8, paddingHorizontal: 16, paddingVertical: 8 },
  table: {
    minHeight: TOUCH,
    justifyContent: "center",
    paddingHorizontal: 14,
    borderRadius: 22,
    borderWidth: StyleSheet.hairlineWidth,
  },
  tableName: { fontSize: 15 },
  searchBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginHorizontal: 16,
    marginVertical: 6,
    paddingLeft: 12,
    paddingRight: 4,
    borderRadius: 10,
    minHeight: TOUCH,
  },
  searchInput: { flex: 1, fontSize: 17, paddingVertical: 8 },
  unsupported: { alignItems: "center", gap: 8, paddingHorizontal: 16 },
  problem: { paddingHorizontal: 16 },
  row: {
    minHeight: 56,
    justifyContent: "center",
    gap: 2,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  name: { fontSize: 17 },
  detail: { fontSize: 15 },
  record: { paddingHorizontal: 16, paddingBottom: 48 },
  field: { gap: 4, paddingVertical: 10 },
  label: { fontSize: 13 },
  value: { fontSize: 17, lineHeight: 22 },
  linkTarget: { minHeight: TOUCH, justifyContent: "center" },
  link: { textDecorationLine: "underline" },
  editable: { minHeight: TOUCH, gap: 4 },
  valueLine: { flexDirection: "row", alignItems: "center", gap: 8 },
  valueText: { flex: 1 },
  headerButton: {
    minHeight: TOUCH,
    minWidth: TOUCH,
    alignItems: "center",
    justifyContent: "center",
  },
  headerButtons: { flexDirection: "row" },
  change: { gap: 8, paddingTop: 8 },
  changeText: { fontSize: 15, lineHeight: 20 },
  actions: { flexDirection: "row", gap: 8 },
});
