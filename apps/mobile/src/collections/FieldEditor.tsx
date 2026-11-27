import { collectionWords } from "@dohc/interface-words/collections";
import { confirmWords } from "@dohc/interface-words/confirmations";
import * as Haptics from "expo-haptics";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text } from "react-native";
import { useAccount } from "../account/AccountProvider";
import type {
  CollectionField,
  RecordCursor,
  RecordId,
  RecordValue,
} from "../server/phoneCollections";
import { phoneWrites } from "../server/phoneWrites";
import { useTheme } from "../theme";
import { ripple, TOUCH } from "../touch";
import { ScreenFailure } from "../workspace/ListStates";
import { draftOf, editorKind, valueOf, type Draft, type EditorKind } from "./collectionFields";
import { recordKey, type WorkspaceCollections } from "./collectionStore";
import { FieldInput } from "./FieldInput";
import { RelationPicker } from "./RelationPicker";

// One field of the open record, changed in a sheet: Cancel and Save in its header, as iOS edits a value. Save sends the
// change and closes the sheet; the record's screen shows it saving, or the Collection's refusal.

/** `value` is the JSON of a value to start from instead of the record's: one a change the server refused held. */
export function FieldEditorScreen() {
  const { field: fieldId, value } = useLocalSearchParams<{ field?: string; value?: string }>();
  const { collections } = useAccount();
  // As it opens: Save names the record's version and the rules then, so a change made since answers as one.
  const [opened] = useState(() => {
    const edit = (fieldId && collections?.edit(fieldId)) || null;
    const view = collections?.view();
    const current = view?.opened;
    const pending =
      view && current
        ? collections?.changes().get(recordKey(view.datasetId, current.tableId, current.record.id))
        : undefined;
    const labels = {
      ...(fieldId && current ? current.relations[fieldId] : undefined),
      ...(pending && pending.change.fieldId === fieldId ? pending.relationLabels : undefined),
    };
    return edit && collections ? { store: collections, edit, labels } : null;
  });
  const kind = opened ? editorKind(opened.edit.field) : null;
  if (!phoneWrites || !opened || !kind)
    return <ScreenFailure text={collectionWords.recordMissing} />;
  const { store, edit, labels } = opened;
  const current = edit.from.value;
  return (
    <Editor
      store={store}
      tableId={edit.from.tableId}
      field={edit.field}
      kind={kind}
      start={value === undefined ? current : parsed(value, current)}
      current={current}
      initialLabels={labels}
      onSave={(next, nextLabels) => store.change(edit, next, nextLabels)}
    />
  );
}

function parsed(text: string, otherwise: RecordValue): RecordValue {
  try {
    return JSON.parse(text) as RecordValue;
  } catch {
    return otherwise;
  }
}

function Editor(props: {
  store: WorkspaceCollections;
  tableId: string;
  field: CollectionField;
  kind: EditorKind;
  start: RecordValue;
  current: RecordValue;
  initialLabels: Readonly<Record<string, string>>;
  onSave(value: RecordValue, relationLabels?: Readonly<Record<string, string>>): void;
}) {
  const { store, tableId, field, kind } = props;
  const theme = useTheme();
  const router = useRouter();
  const [draft, setDraft] = useState<Draft>(() => draftOf(field, props.start));
  const [labels, setLabels] = useState<Readonly<Record<string, string>>>(props.initialLabels);
  const save = (next: Draft = draft) => {
    const result = valueOf(field, next);
    if (!result) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      return;
    }
    if (JSON.stringify(result.value) !== JSON.stringify(props.current))
      props.onSave(result.value, kind === "relation" ? labels : undefined);
    router.back();
  };
  const loadRelations = useCallback(
    (search: string, after: RecordCursor | null, signal: AbortSignal) =>
      store.relationOptions(tableId, field.fieldId, search, after, signal),
    [store, tableId, field.fieldId],
  );
  const header = (
    <Stack.Screen
      options={{
        title: field.name,
        headerLeft: () => (
          <HeaderButton label={confirmWords.cancel} onPress={() => router.back()} />
        ),
        headerRight: () => (
          <HeaderButton label={collectionWords.save} onPress={() => save()} strong />
        ),
      }}
    />
  );
  if (kind === "relation")
    return (
      <>
        {header}
        <RelationPicker
          name={field.name}
          many={field.relation?.many === true}
          selected={Array.isArray(draft) ? (draft as readonly RecordId[]) : []}
          labels={labels}
          load={loadRelations}
          onChange={(next, nextLabels) => {
            setDraft(next);
            setLabels(nextLabels);
          }}
        />
      </>
    );
  return (
    <ScrollView
      style={{ backgroundColor: theme.bg }}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={styles.screen}
      keyboardShouldPersistTaps="handled"
    >
      {header}
      <FieldInput
        field={field}
        draft={draft}
        onChange={setDraft}
        onSubmit={() => save()}
        inlineDate
        autoFocus
        onClearDate={props.current === null || props.current === "" ? null : () => save("")}
      />
    </ScrollView>
  );
}

function HeaderButton(props: { label: string; onPress(): void; strong?: boolean }) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={props.onPress}
      hitSlop={8}
      android_ripple={ripple(theme, true)}
      style={styles.headerButton}
      accessibilityRole="button"
    >
      <Text style={[styles.headerLabel, props.strong ? styles.strong : null, { color: theme.ink }]}>
        {props.label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { padding: 16, gap: 8 },
  headerButton: { minHeight: TOUCH, justifyContent: "center", paddingHorizontal: 8 },
  headerLabel: { fontSize: 17 },
  strong: { fontWeight: "600" },
});
