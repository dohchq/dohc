import { collectionWords } from "@dohc/interface-words/collections";
import { chatWords, noticesWords } from "@dohc/interface-words/notices";
import * as Haptics from "expo-haptics";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { ChevronRight, Square, SquareCheck, Undo2 } from "lucide-react-native";
import { memo, useCallback, useEffect, useSyncExternalStore } from "react";
import {
  ActivityIndicator,
  AppState,
  FlatList,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useAccount, useSignIn } from "../account/AccountProvider";
import { ProblemLine } from "../account/ProblemLine";
import { outsideLink } from "../apps/appNavigation";
import { offerLink } from "../apps/offerLink";
import { ActionPill } from "../notices/ActionPill";
import type {
  CollectionField,
  CollectionRecord,
  CollectionTable,
  RecordValue,
} from "../server/phoneCollections";
import { phoneWrites } from "../server/phoneWrites";
import type { ReadProblem } from "../server/workspaceData";
import { useTheme } from "../theme";
import { EmptyLine, HoldRow, ScreenFailure } from "../workspace/ListStates";
import { useProblemText } from "../workspace/useView";
import { editorKind, rowText, shownValue } from "./collectionFields";
import {
  canUndo,
  recordKey,
  type RecordChange,
  type WorkspaceCollections,
} from "./collectionStore";

// A Collection's records, from Home, and one record. The list reads its first table, or the one chosen, 50 records at
// a time, the next page as it nears its end. Pulling down, and a return to the foreground, read the Collection again.
// Errors show in place, as on any screen outside the tabs.

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
  const problemText = useProblemText();
  const state = useSyncExternalStore(collections.subscribe, collections.view);
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
  const open = useCallback(
    (record: CollectionRecord) => {
      collections.openRecord(record);
      router.push("/collection-record");
    },
    [router, collections],
  );

  const title = <Stack.Screen options={{ title: description?.name ?? "" }} />;
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
          contentContainerStyle={styles.tables}
        >
          {description.tables.map((each) => {
            const chosen = each.tableId === view.tableId;
            return (
              <Pressable
                key={each.tableId}
                onPress={() => {
                  void Haptics.selectionAsync();
                  void collections.chooseTable(each.tableId);
                }}
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
    </>
  );
  return (
    <FlatList
      style={{ backgroundColor: theme.bg }}
      contentInsetAdjustmentBehavior="automatic"
      data={view.rows}
      keyExtractor={(record) => JSON.stringify(record.id)}
      renderItem={({ item }) =>
        table ? <RecordRow record={item} table={table} files={view.files} onPress={open} /> : null
      }
      ListHeaderComponent={
        <>
          {title}
          {header}
        </>
      }
      ListEmptyComponent={
        view.refused && table ? (
          <EmptyLine text={collectionWords.noRead(table.name)} />
        ) : view.reading === "first" ? (
          <HoldRow />
        ) : view.problem ? undefined : (
          <EmptyLine text={collectionWords.noRecords} />
        )
      }
      ListFooterComponent={view.reading === "more" ? <HoldRow /> : undefined}
      onEndReached={more}
      onEndReachedThreshold={0.5}
      refreshControl={<RefreshControl refreshing={view.reading === "refresh"} onRefresh={reload} />}
    />
  );
}

/** A record's row: the field that names it, then up to two more that have a value. */
const RecordRow = memo(function RecordRow(props: {
  record: CollectionRecord;
  table: CollectionTable;
  files: Readonly<Record<string, string>>;
  onPress(record: CollectionRecord): void;
}) {
  const { record, table, files } = props;
  const theme = useTheme();
  const lead = leadField(table);
  const name =
    (lead && rowText(shownValue(lead, record.values[lead.fieldId], files), lead.name)) ??
    String(record.id);
  const details = table.fields
    .filter((field) => field !== lead)
    .flatMap(
      (field) => rowText(shownValue(field, record.values[field.fieldId], files), field.name) ?? [],
    )
    .slice(0, 2);
  return (
    <Pressable
      onPress={() => props.onPress(record)}
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
  useEffect(() => () => collections?.closeRecord(), [collections]);
  const opened = view?.opened;
  const table = view?.description?.tables.find((table) => table.tableId === opened?.tableId);
  if (!collections || !view || !opened || !table)
    return <ScreenFailure text={collectionWords.recordMissing} />;
  const { record, files } = opened;
  const key = recordKey(view.datasetId, table.tableId, record.id);
  const last = changes.get(key);
  const lead = leadField(table);
  const title =
    (lead && rowText(shownValue(lead, record.values[lead.fieldId], files), lead.name)) ??
    String(record.id);
  const edit = (fieldId: string, value?: RecordValue) =>
    router.push({
      pathname: "/collection-field",
      params: { field: fieldId, ...(value === undefined ? {} : { value: JSON.stringify(value) }) },
    });
  // Reads the record again, then opens the editor with what the person entered, if the same record is still open and
  // its field still takes a change.
  const reload = async ({ change }: RecordChange) => {
    if (!(await collections.reloadRecord())) return;
    const from = collections.edit(change.fieldId)?.from;
    if (from && recordKey(from.datasetId, from.tableId, from.recordId) === key)
      edit(change.fieldId, change.value);
  };
  const undo = phoneWrites && canUndo(last);
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      style={{ backgroundColor: theme.bg }}
      contentContainerStyle={styles.record}
    >
      <Stack.Screen
        options={{
          title,
          headerRight: undo
            ? () => (
                <Pressable
                  onPress={() => collections.undo(key)}
                  hitSlop={8}
                  style={styles.headerButton}
                  accessibilityRole="button"
                  accessibilityLabel={collectionWords.undoLastEdit}
                >
                  <Undo2 size={22} color={theme.ink} strokeWidth={2} />
                </Pressable>
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
          last?.state.kind !== "saving";
        const body = (
          <>
            <Text style={[styles.label, { color: theme.muted }]}>{field.name}</Text>
            <View style={styles.valueLine}>
              <View style={styles.valueText}>
                <FieldValue field={field} record={shown} files={files} />
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
                change={pending}
                cause={(problem) => problemText(problem)}
                onRetry={() => collections.retry(key)}
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

/** Why a change didn't save, and what to do next: send it again, read the record again, or drop it. */
function ChangeLine(props: {
  change: RecordChange;
  cause(problem: ReadProblem): string;
  onRetry(): void;
  onReload(): void;
  onDiscard(): void;
}) {
  const theme = useTheme();
  const { state } = props.change;
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
          <ActionPill label={noticesWords.tryAgain} onPress={props.onRetry} />
        ) : state.kind === "rulesChanged" || stale ? (
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
}) {
  const theme = useTheme();
  const { origin } = useSignIn();
  const shown = shownValue(props.field, props.record.values[props.field.fieldId], props.files);
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
  tables: { gap: 8, paddingHorizontal: 16, paddingVertical: 8 },
  table: {
    minHeight: 44,
    justifyContent: "center",
    paddingHorizontal: 14,
    borderRadius: 22,
    borderWidth: StyleSheet.hairlineWidth,
  },
  tableName: { fontSize: 15 },
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
  linkTarget: { minHeight: 44, justifyContent: "center" },
  link: { textDecorationLine: "underline" },
  editable: { minHeight: 44, gap: 4 },
  valueLine: { flexDirection: "row", alignItems: "center", gap: 8 },
  valueText: { flex: 1 },
  headerButton: { minHeight: 44, minWidth: 44, alignItems: "center", justifyContent: "center" },
  change: { gap: 8, paddingTop: 8 },
  changeText: { fontSize: 15, lineHeight: 20 },
  actions: { flexDirection: "row", gap: 8 },
});
