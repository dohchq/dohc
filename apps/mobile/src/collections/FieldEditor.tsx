import { collectionWords } from "@dohc/interface-words/collections";
import { confirmWords } from "@dohc/interface-words/confirmations";
import * as Haptics from "expo-haptics";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { Check } from "lucide-react-native";
import { useCallback, useState, useSyncExternalStore } from "react";
import { Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import { useAccount } from "../account/AccountProvider";
import type { CollectionField, RecordValue } from "../server/phoneCollections";
import { phoneWrites } from "../server/phoneWrites";
import { useTheme } from "../theme";
import { ScreenFailure } from "../workspace/ListStates";
import { draftOf, editorKind, valueOf, type Draft, type EditorKind } from "./collectionFields";

// One field of the open record, changed in a sheet: Cancel and Save in its header, as iOS edits a value. Save sends the
// change and closes the sheet; the record's screen shows it saving. A value that doesn't fit says why under the editor.

const nothing = () => () => undefined;

/** `value` is the JSON of a value to start from instead of the record's: one a change the server refused held. */
export function FieldEditorScreen() {
  const { field: fieldId, value } = useLocalSearchParams<{ field?: string; value?: string }>();
  const { collections } = useAccount();
  const view = useSyncExternalStore(
    collections?.subscribe ?? nothing,
    useCallback(() => collections?.view() ?? null, [collections]),
  );
  const opened = view?.opened;
  const field = view?.description?.tables
    .find((table) => table.tableId === opened?.tableId)
    ?.fields.find((field) => field.fieldId === fieldId);
  const kind = field ? editorKind(field) : null;
  if (!phoneWrites || !collections || !opened || !field?.editable || !kind)
    return <ScreenFailure text={collectionWords.recordMissing} />;
  const current = opened.record.values[field.fieldId] ?? null;
  return (
    <Editor
      field={field}
      kind={kind}
      start={value === undefined ? current : parsed(value, current)}
      current={current}
      onSave={(next) => collections.change(field.fieldId, next)}
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
  field: CollectionField;
  kind: EditorKind;
  start: RecordValue;
  current: RecordValue;
  onSave(value: RecordValue): void;
}) {
  const { field, kind } = props;
  const theme = useTheme();
  const router = useRouter();
  const [draft, setDraft] = useState<Draft>(() => draftOf(field, props.start));
  const [tried, setTried] = useState(false);
  const result = valueOf(field, draft);
  const save = () => {
    if ("problem" in result) {
      setTried(true);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      return;
    }
    if (JSON.stringify(result.value) !== JSON.stringify(props.current)) props.onSave(result.value);
    router.back();
  };
  const header = (
    <Stack.Screen
      options={{
        title: field.name,
        headerLeft: () => (
          <HeaderButton label={confirmWords.cancel} onPress={() => router.back()} />
        ),
        headerRight: () => <HeaderButton label={collectionWords.save} onPress={save} strong />,
      }}
    />
  );
  const problem = tried && "problem" in result ? result.problem : null;

  let editor;
  if (kind === "checkbox")
    editor = (
      <View style={[styles.row, { borderColor: theme.line }]}>
        <Text style={[styles.text, { color: theme.ink }]}>{field.name}</Text>
        <Switch
          value={draft === true}
          onValueChange={setDraft}
          accessibilityLabel={field.name}
          trackColor={{ true: theme.accent }}
        />
      </View>
    );
  else if (kind === "select" || kind === "multi-select") {
    const chosen = Array.isArray(draft) ? draft : [];
    const many = kind === "multi-select";
    editor = field.options.map((option) => {
      const on = chosen.includes(option);
      return (
        <Pressable
          key={option}
          onPress={() => {
            void Haptics.selectionAsync();
            // A choice taps off again unless the field needs one.
            setDraft(
              many
                ? on
                  ? chosen.filter((item) => item !== option)
                  : [...chosen, option]
                : on && !field.required
                  ? []
                  : [option],
            );
          }}
          style={({ pressed }) => [
            styles.row,
            { borderColor: theme.line },
            pressed ? { backgroundColor: theme.panel2 } : null,
          ]}
          accessibilityRole={many ? "checkbox" : "radio"}
          accessibilityState={many ? { checked: on } : { selected: on }}
        >
          <Text style={[styles.text, { color: theme.ink }]}>{option}</Text>
          {on ? <Check size={20} color={theme.accent} strokeWidth={2} /> : null}
        </Pressable>
      );
    });
  } else
    editor = (
      <TextInput
        value={typeof draft === "string" ? draft : ""}
        onChangeText={setDraft}
        autoFocus
        multiline={kind === "text"}
        keyboardType={
          kind === "number" ? "numbers-and-punctuation" : kind === "url" ? "url" : "default"
        }
        autoCapitalize={kind === "text" ? "sentences" : "none"}
        autoCorrect={kind === "text"}
        returnKeyType={kind === "text" ? "default" : "done"}
        onSubmitEditing={kind === "text" ? undefined : save}
        accessibilityLabel={field.name}
        style={[
          styles.input,
          kind === "text" ? styles.multiline : null,
          { color: theme.ink, borderColor: problem ? theme.danger : theme.line },
        ]}
      />
    );

  return (
    <ScrollView
      style={{ backgroundColor: theme.bg }}
      contentContainerStyle={styles.screen}
      keyboardShouldPersistTaps="handled"
    >
      {header}
      {editor}
      {problem ? (
        <Text style={[styles.problem, { color: theme.danger }]} accessibilityRole="alert">
          {problem}
        </Text>
      ) : null}
    </ScrollView>
  );
}

function HeaderButton(props: { label: string; onPress(): void; strong?: boolean }) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={props.onPress}
      hitSlop={8}
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
  row: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  text: { fontSize: 17, flexShrink: 1 },
  input: {
    minHeight: 44,
    fontSize: 17,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
  },
  multiline: { minHeight: 120, textAlignVertical: "top" },
  problem: { fontSize: 15, lineHeight: 20 },
  headerButton: { minHeight: 44, justifyContent: "center", paddingHorizontal: 8 },
  headerLabel: { fontSize: 17 },
  strong: { fontWeight: "600" },
});
