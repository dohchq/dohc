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
import { FieldInput, useAttachmentUpload } from "./FieldInput";
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
    const fileNames = { ...current?.files, ...pending?.fileNames };
    return edit && collections ? { store: collections, edit, labels, fileNames } : null;
  });
  const kind = opened ? editorKind(opened.edit.field) : null;
  if (!phoneWrites || !opened || !kind)
    return <ScreenFailure text={collectionWords.recordMissing} />;
  const { store, edit, labels, fileNames } = opened;
  const current = edit.from.value;
  return (
    <Editor
      store={store}
      datasetId={edit.from.datasetId}
      tableId={edit.from.tableId}
      recordId={edit.from.recordId}
      revision={edit.from.revision}
      revisionSha256={edit.from.revisionSha256}
      field={edit.field}
      kind={kind}
      start={value === undefined ? current : parsed(value, current)}
      current={current}
      initialLabels={labels}
      initialFiles={fileNames}
      onSave={(next, nextLabels, nextFiles) => store.change(edit, next, nextLabels, nextFiles)}
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
  datasetId: string;
  tableId: string;
  recordId: RecordId;
  revision: number;
  revisionSha256: string;
  field: CollectionField;
  kind: EditorKind;
  start: RecordValue;
  current: RecordValue;
  initialLabels: Readonly<Record<string, string>>;
  initialFiles: Readonly<Record<string, string>>;
  onSave(
    value: RecordValue,
    relationLabels?: Readonly<Record<string, string>>,
    fileNames?: Readonly<Record<string, string>>,
  ): void;
}) {
  const { store, datasetId, tableId, recordId, revision, revisionSha256, field, kind } = props;
  const theme = useTheme();
  const router = useRouter();
  const [draft, setDraft] = useState<Draft>(() => draftOf(field, props.start));
  const [labels, setLabels] = useState<Readonly<Record<string, string>>>(props.initialLabels);
  const [files, setFiles] = useState<Readonly<Record<string, string>>>(props.initialFiles);
  const onUploaded = useCallback((_: string, fileId: string, name: string) => {
    setFiles((cur) => ({ ...cur, [fileId]: name }));
    setDraft(fileId);
  }, []);
  const upload = useAttachmentUpload({ store, tableId, revision, revisionSha256, onUploaded });
  const save = (next: Draft = draft) => {
    if (upload.uploadingField !== null) return;
    const result = valueOf(field, next);
    if (!result) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      return;
    }
    if (JSON.stringify(result.value) !== JSON.stringify(props.current))
      props.onSave(
        result.value,
        kind === "relation" ? labels : undefined,
        kind === "attachment" ? files : undefined,
      );
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
        ...(kind === "relation"
          ? {
              headerTransparent: false,
              headerStyle: { backgroundColor: theme.bg },
              headerShadowVisible: false,
            }
          : {}),
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
        error={upload.errors[field.fieldId] ?? null}
        onClearDate={props.current === null || props.current === "" ? null : () => save("")}
        attachmentName={typeof draft === "string" && draft ? (files[draft] ?? null) : null}
        uploadingAttachment={upload.uploadingField === field.fieldId}
        onPickAttachment={kind === "attachment" ? () => void upload.pick(field.fieldId) : undefined}
        onClearAttachment={kind === "attachment" ? () => setDraft("") : null}
        onRetryAttachment={upload.retryable ? upload.retry : null}
        onOpenAttachment={
          kind === "attachment" &&
          typeof draft === "string" &&
          draft.length > 0 &&
          draft === props.current
            ? () =>
                router.push({
                  pathname: "/file",
                  params: {
                    datasetId,
                    tableId,
                    recordId: String(recordId),
                    ...(typeof recordId === "number" ? { recordIdNum: "1" } : {}),
                    fieldId: field.fieldId,
                    fileId: draft,
                    name: files[draft] ?? collectionWords.attachedFile,
                  },
                })
            : null
        }
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
