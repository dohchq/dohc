import { collectionWords } from "@dohc/interface-words/collections";
import { confirmWords } from "@dohc/interface-words/confirmations";
import * as Haptics from "expo-haptics";
import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type {
  CollectionTable,
  CreateCollectionField,
  RecordCursor,
  RecordId,
  RecordValue,
} from "../server/phoneCollections";
import { useTheme } from "../theme";
import { ripple, TOUCH } from "../touch";
import { draftOf, draftProblem, valueOf, type Draft } from "./collectionFields";
import type { RecordAction, WorkspaceCollections } from "./collectionStore";
import { FieldInput, useAttachmentUpload } from "./FieldInput";
import { RelationPicker } from "./RelationPicker";
import type { ChangeLineProps } from "./CollectionScreens";

const initialDrafts = (
  fields: readonly CreateCollectionField[],
  submitted?: Readonly<Record<string, RecordValue>>,
): Record<string, Draft> =>
  Object.fromEntries(
    fields.map((field) => [
      field.fieldId,
      draftOf(
        field,
        submitted && Object.hasOwn(submitted, field.fieldId)
          ? submitted[field.fieldId]
          : field.default,
        { emptyDate: true },
      ),
    ]),
  );

export function NewRecordSheet(props: {
  readonly open: boolean;
  readonly table: CollectionTable;
  readonly collections: WorkspaceCollections;
  readonly action: RecordAction | undefined;
  readonly actionKey: string;
  readonly renderAction: (props: Omit<ChangeLineProps, "state" | "cause">) => React.ReactNode;
  readonly onClose: () => void;
  readonly onCreated: (opened: boolean) => void;
}) {
  const { open, table, collections, action, actionKey, onClose, onCreated } = props;
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const saving = action?.state.kind === "saving";
  const failed = action?.state.kind === "failed";
  const [fileNames, setFileNames] = useState<Record<string, string>>({});
  const pendingValues =
    (saving || failed) && action?.kind === "create" ? action.request.values : undefined;
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() =>
    initialDrafts(table.createFields, pendingValues),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [labels, setLabels] = useState<Record<string, Record<string, string>>>({});
  const [pickingId, setPickingId] = useState<string | null>(null);
  const setField = useCallback((fieldId: string, next: Draft) => {
    setDrafts((cur) => ({ ...cur, [fieldId]: next }));
    setErrors((cur) => {
      if (!Object.hasOwn(cur, fieldId)) return cur;
      const copy = { ...cur };
      delete copy[fieldId];
      return copy;
    });
  }, []);
  const onUploaded = useCallback(
    (fieldId: string, fileId: string, name: string) => {
      setFileNames((cur) => ({ ...cur, [fileId]: name }));
      setField(fieldId, fileId);
    },
    [setField],
  );
  const upload = useAttachmentUpload({ store: collections, tableId: table.tableId, onUploaded });
  const locked = saving || failed || upload.uploadingField !== null;
  useEffect(() => {
    if (!open) return;
    setDrafts(initialDrafts(table.createFields, pendingValues));
    setErrors({});
    if (!pendingValues) {
      setLabels({});
      setFileNames({});
    }
    upload.reset();
    setPickingId(null);
  }, [open, table.tableId]);

  const picking =
    !locked && pickingId ? (table.createFields.find((f) => f.fieldId === pickingId) ?? null) : null;
  const close = () => {
    if (saving || upload.uploadingField !== null) return;
    if (picking) setPickingId(null);
    else onClose();
  };
  const submit = async () => {
    if (locked) return;
    const nextErrors: Record<string, string> = {};
    const values: Record<string, RecordValue> = {};
    for (const field of table.createFields) {
      const draft = drafts[field.fieldId] ?? draftOf(field, field.default, { emptyDate: true });
      const problem = draftProblem(field, draft);
      if (problem) nextErrors[field.fieldId] = problem;
      else values[field.fieldId] = valueOf(field, draft)!.value;
    }
    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      return;
    }
    if (action && (action.state.kind === "refused" || action.state.kind === "rulesChanged"))
      collections.discardAction(actionKey);
    const opened = await collections.create(values);
    if (!collections.actions().has(actionKey)) {
      onClose();
      onCreated(opened);
    }
  };
  const loadRelations = useCallback(
    (search: string, after: RecordCursor | null, signal: AbortSignal) =>
      collections.relationOptions(table.tableId, pickingId!, search, after, signal),
    [collections, table.tableId, pickingId],
  );

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
            {picking ? (
              <>
                <View style={styles.side} />
                <Text style={[styles.title, { color: theme.ink }]} numberOfLines={1}>
                  {picking.name}
                </Text>
                <Pressable
                  onPress={() => setPickingId(null)}
                  android_ripple={ripple(theme, true)}
                  style={[styles.btn, styles.side, styles.right]}
                  accessibilityRole="button"
                >
                  <Text style={[styles.btnText, styles.strong, { color: theme.ink }]}>
                    {collectionWords.done}
                  </Text>
                </Pressable>
              </>
            ) : (
              <>
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
                  {collectionWords.newRecord}
                </Text>
                {saving ? (
                  <View style={[styles.btn, styles.side, styles.right]}>
                    <ActivityIndicator accessibilityLabel={collectionWords.saving} />
                  </View>
                ) : (
                  <Pressable
                    onPress={() => void submit()}
                    disabled={failed}
                    android_ripple={ripple(theme, true)}
                    style={[styles.btn, styles.side, styles.right]}
                    accessibilityRole="button"
                  >
                    <Text
                      style={[
                        styles.btnText,
                        styles.strong,
                        { color: failed ? theme.subtle : theme.ink },
                      ]}
                    >
                      {collectionWords.create}
                    </Text>
                  </Pressable>
                )}
              </>
            )}
          </View>
          {picking ? (
            <RelationPicker
              name={picking.name}
              many={picking.relation?.many === true}
              selected={
                Array.isArray(drafts[picking.fieldId])
                  ? (drafts[picking.fieldId] as readonly RecordId[])
                  : []
              }
              labels={labels[picking.fieldId] ?? {}}
              load={loadRelations}
              onChange={(next, nextLabels) => {
                setField(picking.fieldId, next);
                setLabels((cur) => ({ ...cur, [picking.fieldId]: { ...nextLabels } }));
              }}
            />
          ) : (
            <ScrollView
              contentContainerStyle={styles.form}
              keyboardShouldPersistTaps="handled"
              automaticallyAdjustKeyboardInsets
            >
              {action
                ? props.renderAction({
                    onRetry: () =>
                      void collections.retryAction(actionKey).then((opened) => {
                        if (!collections.actions().has(actionKey)) {
                          onClose();
                          onCreated(opened);
                        }
                      }),
                    onReload: () => {
                      collections.discardAction(actionKey);
                      void collections.reload();
                    },
                    onDiscard: () => collections.discardAction(actionKey),
                  })
                : null}
              {table.createFields.map((field) => (
                <View key={field.fieldId} style={styles.field}>
                  {field.type === "checkbox" ? null : (
                    <Text
                      style={[styles.label, { color: theme.muted }]}
                      accessibilityLabel={
                        field.required ? `${field.name}, ${collectionWords.required}` : field.name
                      }
                    >
                      {field.name}
                      {field.required ? " *" : ""}
                    </Text>
                  )}
                  <FieldInput
                    field={field}
                    draft={
                      drafts[field.fieldId] ?? draftOf(field, field.default, { emptyDate: true })
                    }
                    onChange={(next) => setField(field.fieldId, next)}
                    disabled={locked}
                    error={errors[field.fieldId] ?? upload.errors[field.fieldId] ?? null}
                    onClearDate={
                      field.type === "date" && !field.required
                        ? () => setField(field.fieldId, "")
                        : null
                    }
                    relationLabels={labels[field.fieldId]}
                    onPickRelation={
                      field.type === "relation" && !locked
                        ? () => setPickingId(field.fieldId)
                        : undefined
                    }
                    attachmentName={
                      field.type === "attachment" && typeof drafts[field.fieldId] === "string"
                        ? (fileNames[drafts[field.fieldId] as string] ?? null)
                        : null
                    }
                    uploadingAttachment={upload.uploadingField === field.fieldId}
                    onPickAttachment={
                      field.type === "attachment" && !locked
                        ? () => void upload.pick(field.fieldId)
                        : undefined
                    }
                    onClearAttachment={
                      field.type === "attachment" && !field.required
                        ? () => setField(field.fieldId, "")
                        : null
                    }
                    onRetryAttachment={
                      upload.retryable?.fieldId === field.fieldId ? upload.retry : null
                    }
                  />
                </View>
              ))}
            </ScrollView>
          )}
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
    paddingHorizontal: 12,
    paddingBottom: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  side: { minWidth: 80 },
  right: { alignItems: "flex-end" },
  btn: { minHeight: TOUCH, justifyContent: "center", paddingHorizontal: 4 },
  btnText: { fontSize: 17 },
  strong: { fontWeight: "600" },
  title: { flex: 1, fontSize: 17, fontWeight: "600", textAlign: "center" },
  form: { padding: 16, gap: 16, paddingBottom: 48 },
  field: { gap: 6 },
  label: { fontSize: 13 },
});
