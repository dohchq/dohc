import { collectionWords } from "@dohc/interface-words/collections";
import type { DatasetColumnFieldType } from "@dohc/security-contract/dataset";
import DateTimePicker, { DateTimePickerAndroid } from "@react-native-community/datetimepicker";
import * as Haptics from "expo-haptics";
import { Check, ChevronRight } from "lucide-react-native";
import { useEffect, useState } from "react";
import { Platform, Pressable, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import type { CollectionRelation, RecordId } from "../server/phoneCollections";
import { useTheme } from "../theme";
import { ripple, TOUCH } from "../touch";
import { dateOf, dayOf, rowText, shownValue, type Draft } from "./collectionFields";

export interface FieldInputSpec {
  readonly name: string;
  readonly type: DatasetColumnFieldType;
  readonly options?: readonly string[];
  readonly relation?: CollectionRelation;
  readonly required?: boolean;
}

export interface FieldInputProps {
  readonly field: FieldInputSpec;
  readonly draft: Draft;
  readonly onChange: (next: Draft) => void;
  readonly onSubmit?: () => void;
  readonly onClearDate?: (() => void) | null;
  readonly inlineDate?: boolean;
  readonly autoFocus?: boolean;
  readonly error?: string | null;
  readonly relationLabels?: Readonly<Record<string, string>>;
  readonly onPickRelation?: () => void;
}

export function FieldInput(props: FieldInputProps) {
  const { field, draft, onChange, error } = props;
  const theme = useTheme();
  let control;
  if (field.type === "checkbox")
    control = (
      <View style={[styles.row, { borderColor: theme.line }]}>
        <Text style={[styles.text, { color: theme.ink }]}>{field.name}</Text>
        <Switch
          value={draft === true}
          onValueChange={onChange}
          accessibilityLabel={field.name}
          trackColor={{ true: theme.accent }}
        />
      </View>
    );
  else if (field.type === "date")
    control = (
      <DateInput
        name={field.name}
        day={typeof draft === "string" ? draft : ""}
        inline={props.inlineDate === true}
        onPick={onChange}
        onClear={props.onClearDate ?? null}
      />
    );
  else if (field.type === "select" || field.type === "multi-select") {
    const chosen = Array.isArray(draft) ? (draft as readonly string[]) : [];
    const many = field.type === "multi-select";
    control = (field.options ?? []).map((option) => {
      const on = chosen.includes(option);
      return (
        <Pressable
          key={option}
          onPress={() => {
            void Haptics.selectionAsync();
            onChange(
              on ? chosen.filter((x) => x !== option) : many ? [...chosen, option] : [option],
            );
          }}
          android_ripple={ripple(theme)}
          style={({ pressed }) => [
            styles.row,
            { borderColor: theme.line },
            pressed && { backgroundColor: theme.panel2 },
          ]}
          accessibilityRole={many ? "checkbox" : "radio"}
          accessibilityState={many ? { checked: on } : { selected: on }}
        >
          <Text style={[styles.text, { color: theme.ink }]}>{option}</Text>
          {on ? <Check size={20} color={theme.accent} strokeWidth={2} /> : null}
        </Pressable>
      );
    });
  } else if (field.type === "relation") {
    const selected = Array.isArray(draft) ? (draft as readonly RecordId[]) : [];
    const summary = selected
      .map((k) => props.relationLabels?.[JSON.stringify(k)] ?? String(k))
      .join(", ");
    const placeholder = field.relation?.many
      ? collectionWords.chooseRecords
      : collectionWords.chooseRecord;
    control = (
      <Pressable
        onPress={props.onPickRelation}
        disabled={!props.onPickRelation}
        android_ripple={ripple(theme)}
        style={({ pressed }) => [
          styles.row,
          { borderColor: theme.line },
          pressed && { backgroundColor: theme.panel2 },
        ]}
        accessibilityRole="button"
        accessibilityLabel={`${field.name}, ${summary || placeholder}`}
      >
        <Text
          style={[styles.text, { color: summary ? theme.ink : theme.subtle }]}
          numberOfLines={2}
        >
          {summary || placeholder}
        </Text>
        <ChevronRight size={18} color={theme.subtle} strokeWidth={2} />
      </Pressable>
    );
  } else
    control = (
      <TextInput
        value={typeof draft === "string" ? draft : ""}
        onChangeText={onChange}
        autoFocus={props.autoFocus}
        multiline={field.type === "text"}
        keyboardType={
          field.type === "number"
            ? "numbers-and-punctuation"
            : field.type === "url"
              ? "url"
              : "default"
        }
        autoCapitalize={field.type === "text" ? "sentences" : "none"}
        autoCorrect={field.type === "text"}
        returnKeyType={field.type === "text" ? "default" : "done"}
        onSubmitEditing={field.type === "text" ? undefined : props.onSubmit}
        accessibilityLabel={field.name}
        style={[
          styles.input,
          field.type === "text" && styles.multiline,
          { color: theme.ink, borderColor: error ? theme.danger : theme.line },
        ]}
      />
    );
  return (
    <View style={styles.wrap}>
      {control}
      {error ? (
        <Text style={[styles.error, { color: theme.danger }]} accessibilityRole="alert">
          {error}
        </Text>
      ) : null}
    </View>
  );
}

function DateInput(props: {
  name: string;
  day: string;
  inline: boolean;
  onPick(day: string): void;
  onClear: (() => void) | null;
}) {
  const theme = useTheme();
  const [expanded, setExpanded] = useState(props.inline);
  const value = dateOf(props.day) ?? new Date();
  const pick = (_: unknown, picked: Date) => props.onPick(dayOf(picked));
  const openDialog = () => DateTimePickerAndroid.open({ value, mode: "date", onValueChange: pick });
  useEffect(() => {
    if (props.inline && Platform.OS === "android") openDialog();
  }, []);
  const formatted = props.day
    ? rowText(shownValue({ type: "date" }, props.day, {}), props.name)
    : null;
  return (
    <>
      {Platform.OS === "ios" && expanded ? (
        <DateTimePicker
          value={value}
          mode="date"
          display="inline"
          accentColor={theme.accent}
          onValueChange={pick}
          accessibilityLabel={props.name}
        />
      ) : (
        <Pressable
          onPress={() => {
            if (Platform.OS === "android") openDialog();
            else {
              if (!expanded && !props.day) props.onPick(dayOf(new Date()));
              setExpanded((open) => !open);
            }
          }}
          android_ripple={ripple(theme)}
          style={[styles.row, { borderColor: theme.line }]}
          accessibilityRole="button"
          accessibilityLabel={props.name}
        >
          <Text style={[styles.text, { color: formatted ? theme.ink : theme.subtle }]}>
            {formatted ?? collectionWords.chooseDate}
          </Text>
        </Pressable>
      )}
      {props.onClear && props.day ? (
        <Pressable
          onPress={() => {
            if (!props.inline) setExpanded(false);
            props.onClear?.();
          }}
          android_ripple={ripple(theme)}
          style={[styles.row, { borderColor: theme.line }]}
          accessibilityRole="button"
        >
          <Text style={[styles.text, { color: theme.accent }]}>{collectionWords.clearValue}</Text>
        </Pressable>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 4 },
  row: {
    minHeight: TOUCH,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  text: { fontSize: 17, flexShrink: 1 },
  input: {
    minHeight: TOUCH,
    fontSize: 17,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
  },
  multiline: { minHeight: 96, textAlignVertical: "top" },
  error: { fontSize: 14, lineHeight: 19 },
});
